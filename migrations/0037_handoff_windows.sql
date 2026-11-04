ALTER TABLE handoffs ADD COLUMN admins_reminded INTEGER NOT NULL DEFAULT 0;
CREATE INDEX handoff_reminders ON handoff_events(handoff_id,json_extract(data,'$.assignee.id')) WHERE type='reminder';
CREATE INDEX handoff_wait_notices ON handoff_events(handoff_id,json_extract(data,'$.waiting'));

-- Keep the event history. Retire repeated work already scheduled by 0036, including
-- duplicate queued reminders and the old, misleading notice for a closed office.
DELETE FROM handoff_mail WHERE kind='nobody' AND event_id IN (SELECT id FROM handoff_events WHERE json_extract(data,'$.waiting')='hours');
DELETE FROM handoff_mail WHERE kind='reminder' AND event_id IN (SELECT e.id FROM handoff_events e WHERE e.type='reminder' AND EXISTS(
 SELECT 1 FROM handoff_events old WHERE old.handoff_id=e.handoff_id AND old.type='reminder' AND old.rowid<e.rowid AND json_extract(old.data,'$.assignee.id')=json_extract(e.data,'$.assignee.id')));
INSERT INTO handoff_mail(event_id,member_id,kind) SELECT (SELECT e.id FROM handoff_events e WHERE e.handoff_id=h.id AND e.type='reminder' AND json_extract(e.data,'$.assignee.id')=json_extract(h.assignee,'$.id') ORDER BY e.rowid DESC LIMIT 1),m.id,'still_waiting'
 FROM handoffs h JOIN members m ON m.app_id=h.app_id AND m.role IN ('owner','admin') AND m.user_id!=json_extract(h.assignee,'$.id')
 WHERE h.ended_at IS NULL AND h.respond_by IS NOT NULL AND EXISTS(SELECT 1 FROM handoff_events e WHERE e.handoff_id=h.id AND e.type='reminder' AND json_extract(e.data,'$.assignee.id')=json_extract(h.assignee,'$.id'));
UPDATE handoffs SET next_check=NULL,admins_reminded=1,version=version+1 WHERE ended_at IS NULL AND respond_by IS NOT NULL AND EXISTS(
 SELECT 1 FROM handoff_events e WHERE e.handoff_id=handoffs.id AND e.type='reminder' AND json_extract(e.data,'$.assignee.id')=json_extract(handoffs.assignee,'$.id'));

CREATE TRIGGER handoff_remind_once BEFORE INSERT ON handoff_events WHEN NEW.type='reminder' AND EXISTS(SELECT 1 FROM handoff_events e WHERE e.handoff_id=NEW.handoff_id AND e.type='reminder' AND json_extract(e.data,'$.assignee.id')=json_extract(NEW.data,'$.assignee.id')) BEGIN
 UPDATE handoffs SET next_check=NULL WHERE id=NEW.handoff_id; SELECT RAISE(IGNORE); END;
DROP TRIGGER handoff_notify;
CREATE TRIGGER handoff_notify AFTER INSERT ON handoff_events WHEN NEW.type!='handed_back' BEGIN
 INSERT INTO handoff_mail(event_id,member_id,kind)
 SELECT NEW.id,m.id,CASE WHEN NEW.type='reminder' THEN 'reminder' WHEN m.user_id=json_extract(NEW.data,'$.assignee.id') THEN 'assigned' ELSE 'passed' END
 FROM handoffs h JOIN members m ON m.app_id=h.app_id AND m.role IN ('owner','admin','member') WHERE h.id=NEW.handoff_id
 AND (m.user_id=json_extract(NEW.data,'$.assignee.id') OR (NEW.type='reassigned' AND json_extract(NEW.data,'$.assignee.id') IS NOT NULL AND m.user_id=json_extract(NEW.data,'$.from.id')));
 INSERT INTO handoff_mail(event_id,member_id,kind) SELECT NEW.id,m.id,'nobody' FROM handoffs h JOIN members m ON m.app_id=h.app_id AND m.role IN ('admin','owner') AND m.user_id IS NOT NULL
 WHERE h.id=NEW.handoff_id AND json_extract(NEW.data,'$.waiting')='nobody_available' AND NOT EXISTS(SELECT 1 FROM handoff_events old WHERE old.handoff_id=h.id AND old.id!=NEW.id AND json_extract(old.data,'$.waiting')='nobody_available');
 -- An admin who is also the assignee already gets the reminder above.
 INSERT INTO handoff_mail(event_id,member_id,kind) SELECT NEW.id,m.id,'still_waiting' FROM handoffs h JOIN members m ON m.app_id=h.app_id AND m.role IN ('admin','owner') AND m.user_id!=json_extract(NEW.data,'$.assignee.id')
 WHERE h.id=NEW.handoff_id AND NEW.type='reminder' AND h.admins_reminded=0;
 UPDATE handoffs SET admins_reminded=1,next_check=NULL WHERE id=NEW.handoff_id AND NEW.type='reminder'; END;

-- Availability/roster edits wake an unstaffed queue; schedule edits invalidate the
-- previously computed zoned opening. A change never re-arms a terminal response window.
CREATE TRIGGER handoff_hours_changed AFTER UPDATE OF hours ON handoff_groups WHEN NEW.hours IS NOT OLD.hours BEGIN
 UPDATE handoffs SET next_check=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE group_id=NEW.id AND ended_at IS NULL AND waiting IS NOT NULL; END;
CREATE TRIGGER handoff_member_added AFTER INSERT ON handoff_members BEGIN
 UPDATE handoffs SET next_check=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE group_id=NEW.group_id AND ended_at IS NULL AND waiting='nobody_available'; END;
CREATE TRIGGER handoff_available_insert AFTER INSERT ON handoff_availability WHEN NEW.available=1 BEGIN
 UPDATE handoffs SET next_check=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ended_at IS NULL AND waiting='nobody_available' AND group_id IN(SELECT group_id FROM handoff_members WHERE member_id=NEW.member_id); END;
CREATE TRIGGER handoff_available_update AFTER UPDATE OF available ON handoff_availability WHEN NEW.available=1 AND OLD.available=0 BEGIN
 UPDATE handoffs SET next_check=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ended_at IS NULL AND waiting='nobody_available' AND group_id IN(SELECT group_id FROM handoff_members WHERE member_id=NEW.member_id); END;

-- Keep slots after the mail job is deleted. Retries reuse their slot and provider idempotency key.
CREATE TABLE handoff_mail_slots(day TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,job TEXT NOT NULL,PRIMARY KEY(day,user_id,job)) WITHOUT ROWID;
