CREATE TABLE handoff_groups(id TEXT PRIMARY KEY,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 name TEXT NOT NULL COLLATE NOCASE,strategy TEXT NOT NULL CHECK(strategy IN ('round_robin','least_busy')),hours TEXT,
 response_minutes INTEGER CHECK(response_minutes BETWEEN 5 AND 1440),last_user TEXT,version INTEGER NOT NULL DEFAULT 1,UNIQUE(app_id,name));
ALTER TABLE apps ADD COLUMN default_group_id TEXT REFERENCES handoff_groups(id) ON DELETE SET NULL;
CREATE TRIGGER default_group_scope BEFORE UPDATE OF default_group_id ON apps WHEN NEW.default_group_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM handoff_groups WHERE id=NEW.default_group_id AND app_id=NEW.id) BEGIN SELECT RAISE(ABORT,'invalid workspace group'); END;
CREATE TABLE handoff_members(group_id TEXT NOT NULL REFERENCES handoff_groups(id) ON DELETE CASCADE,member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,PRIMARY KEY(group_id,member_id));
CREATE TABLE handoff_availability(member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,available INTEGER NOT NULL CHECK(available IN (0,1)));
CREATE TRIGGER handoff_demoted AFTER UPDATE OF role,user_id ON members WHEN NEW.role='viewer' OR NEW.user_id IS NOT OLD.user_id BEGIN
 DELETE FROM handoff_members WHERE member_id=NEW.id; DELETE FROM handoff_availability WHERE member_id=NEW.id; END;
CREATE VIEW handoff_roster AS SELECT g.id group_id,g.app_id,m.user_id,h.position,coalesce(a.available,1) available,
 json_object('type','member','id',u.id,'name',u.name,'avatar_url',u.avatar_url,'role',m.role) actor
 FROM handoff_groups g JOIN handoff_members h ON h.group_id=g.id JOIN members m ON m.id=h.member_id AND m.app_id=g.app_id AND m.role IN ('member','admin','owner')
 JOIN users u ON u.id=m.user_id LEFT JOIN handoff_availability a ON a.member_id=m.id;
CREATE INDEX handoff_load ON issues(app_id,json_extract(assignee,'$.id')) WHERE status!='closed';
CREATE TABLE handoffs(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 group_id TEXT REFERENCES handoff_groups(id) ON DELETE SET NULL,source TEXT NOT NULL CHECK(source IN ('agent','team','routing','requester')),reason TEXT NOT NULL,actor TEXT,at TEXT NOT NULL,ended_at TEXT,
 assignee TEXT,waiting TEXT CHECK(waiting IN ('hours','nobody_available')),respond_by TEXT,next_check TEXT,passed INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 0,first_reply TEXT);
CREATE UNIQUE INDEX handoff_active ON handoffs(issue_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX handoff_requester_once ON handoffs(issue_id) WHERE source='requester';
CREATE INDEX handoff_history ON handoffs(issue_id,at);
CREATE INDEX handoff_due ON handoffs(next_check) WHERE ended_at IS NULL AND next_check IS NOT NULL;
CREATE VIEW handoff_docs AS SELECT h.*,json_object('reason',h.reason,'source',h.source,'by',json(h.actor),'at',h.at,
 'group',CASE WHEN g.id IS NOT NULL THEN json_object('id',g.id,'name',g.name) END,'waiting',h.waiting,'respond_by',h.respond_by) doc
 FROM handoffs h LEFT JOIN handoff_groups g ON g.id=h.group_id AND g.app_id=h.app_id;
CREATE TABLE handoff_events(id TEXT PRIMARY KEY,handoff_id TEXT NOT NULL REFERENCES handoffs(id) ON DELETE CASCADE,type TEXT NOT NULL,actor TEXT NOT NULL,data TEXT NOT NULL,at TEXT NOT NULL);
CREATE INDEX handoff_events_parent ON handoff_events(handoff_id,at);
CREATE TABLE handoff_mail(id TEXT PRIMARY KEY DEFAULT(lower(hex(randomblob(16)))),event_id TEXT NOT NULL REFERENCES handoff_events(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,kind TEXT NOT NULL,wake INTEGER NOT NULL DEFAULT 0,UNIQUE(event_id,member_id,kind));
CREATE INDEX handoff_mail_wake ON handoff_mail(wake);
CREATE TABLE handoff_guard(ok INTEGER NOT NULL CONSTRAINT handoff_changed CHECK(ok=1));
-- Never expose the internal transition row to a requester, even to older readers.
CREATE VIEW handoff_timeline AS SELECT h.issue_id,h.app_id,e.id,e.type,e.actor,e.data,e.at created_at FROM handoff_events e JOIN handoffs h ON h.id=e.handoff_id JOIN apps a ON a.id=h.app_id AND a.mode='helpdesk' WHERE e.type!='reminder';
CREATE VIEW api_requester_items AS SELECT * FROM api_items UNION ALL SELECT issue_id,id,created_at,NULL,'escalated',NULL,NULL,'{}' FROM handoff_timeline WHERE type='escalated';
DROP VIEW api_review_items;
CREATE VIEW api_review_items(issue_id,id,created_at,actor,type,body,edited_at,data,internal,hidden) AS
 SELECT issue_id,id,created_at,author,'held',body,NULL,NULL,0,0 FROM team_comments WHERE held_at IS NOT NULL
 UNION ALL SELECT issue_id,id,created_at,actor,type,NULL,NULL,data,1,0 FROM approval_events
 UNION ALL SELECT issue_id,id,created_at,actor,type,NULL,NULL,data,1,0 FROM handoff_timeline;
DROP VIEW suggest_issues;
CREATE VIEW suggest_issues AS SELECT i.id,i.app_id FROM issues i JOIN apps a ON a.id=i.app_id
 LEFT JOIN request_answers b ON b.issue_id=i.id AND b.app_id=i.app_id LEFT JOIN request_types t ON t.id=b.type_id AND t.app_id=i.app_id
 WHERE a.mode='helpdesk' AND (coalesce(t.autonomy,a.default_autonomy)='suggest' OR EXISTS(SELECT 1 FROM handoffs h WHERE h.issue_id=i.id AND h.ended_at IS NULL));
CREATE TRIGGER handoff_reply AFTER INSERT ON comments WHEN NEW.internal=0 AND NEW.hidden IS NULL AND (NEW.sent_by IS NOT NULL OR json_extract(NEW.author,'$.type')='member') BEGIN
 UPDATE handoffs SET first_reply=coalesce(first_reply,NEW.created_at),version=version+1,
 respond_by=CASE WHEN json_extract(assignee,'$.id')!=json_extract(coalesce(NEW.sent_by,NEW.author),'$.id') THEN respond_by END,
 next_check=CASE WHEN assignee IS NULL OR json_extract(assignee,'$.id')!=json_extract(coalesce(NEW.sent_by,NEW.author),'$.id') THEN next_check END
 WHERE issue_id=NEW.issue_id AND ended_at IS NULL AND NEW.created_at>=at AND EXISTS(SELECT 1 FROM members m WHERE m.app_id=handoffs.app_id AND m.user_id=json_extract(coalesce(NEW.sent_by,NEW.author),'$.id') AND m.role IN ('member','admin','owner')); END;
CREATE TRIGGER handoff_transfer AFTER UPDATE OF app_id ON issues WHEN NEW.app_id!=OLD.app_id BEGIN DELETE FROM handoffs WHERE issue_id=NEW.id; END;
CREATE TRIGGER handoff_erased AFTER UPDATE OF author ON issues WHEN json_extract(NEW.author,'$.id')='deleted-user' AND NEW.author!=OLD.author BEGIN DELETE FROM handoffs WHERE issue_id=NEW.id; END;
CREATE TRIGGER handoff_desk_exit AFTER UPDATE OF mode ON apps WHEN NEW.mode='tracker' AND OLD.mode='helpdesk' BEGIN
 DELETE FROM handoffs WHERE app_id=NEW.id; DELETE FROM handoff_groups WHERE app_id=NEW.id; END;
CREATE TRIGGER handoff_notify AFTER INSERT ON handoff_events WHEN NEW.type!='handed_back' BEGIN
 INSERT INTO handoff_mail(event_id,member_id,kind)
 SELECT NEW.id,m.id,CASE WHEN NEW.type='reminder' THEN 'reminder' WHEN m.user_id=json_extract(NEW.data,'$.assignee.id') THEN 'assigned' ELSE 'passed' END
 FROM handoffs h JOIN members m ON m.app_id=h.app_id AND m.role IN ('owner','admin','member') WHERE h.id=NEW.handoff_id
 AND (m.user_id=json_extract(NEW.data,'$.assignee.id') OR (NEW.type='reassigned' AND json_extract(NEW.data,'$.assignee.id') IS NOT NULL AND m.user_id=json_extract(NEW.data,'$.from.id')));
 INSERT INTO handoff_mail(event_id,member_id,kind) SELECT NEW.id,m.id,'nobody' FROM handoffs h JOIN members m ON m.app_id=h.app_id AND m.role IN ('admin','owner') AND m.user_id IS NOT NULL
 WHERE h.id=NEW.handoff_id AND json_extract(NEW.data,'$.waiting') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM handoff_events old WHERE old.handoff_id=h.id AND old.id!=NEW.id AND json_extract(old.data,'$.waiting') IS NOT NULL); END;
CREATE TRIGGER handoff_manual_assignment AFTER UPDATE OF assignee ON issues WHEN OLD.assignee IS NOT NEW.assignee BEGIN
 UPDATE handoffs SET assignee=NEW.assignee,version=version+1,waiting=CASE WHEN NEW.assignee IS NULL THEN 'nobody_available' END,
 respond_by=CASE WHEN NEW.assignee IS NOT NULL THEN (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||response_minutes||' minutes') FROM handoff_groups WHERE id=group_id) END,
 next_check=CASE WHEN NEW.assignee IS NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE (SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||response_minutes||' minutes') FROM handoff_groups WHERE id=group_id) END
 WHERE issue_id=NEW.id AND ended_at IS NULL AND assignee IS NOT NEW.assignee; END;
