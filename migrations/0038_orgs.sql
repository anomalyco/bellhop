-- Orgs: a group of apps run by one team, with one inbox across them. An org role counts in every app of the
-- org as if held there; the effective role in an app is the higher of the app role and the org role.
CREATE TABLE orgs(id TEXT PRIMARY KEY NOT NULL,slug TEXT NOT NULL UNIQUE,name TEXT NOT NULL,
 icon_version TEXT,icon_mime TEXT CHECK((icon_version IS NULL)=(icon_mime IS NULL) AND icon_mime IN ('image/png','image/jpeg','image/webp')),
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
-- Only accepted seats live in org_members; pending ones are org_invitations and grant nothing.
CREATE TABLE org_members(id TEXT PRIMARY KEY NOT NULL,org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id),email TEXT NOT NULL COLLATE NOCASE,
 role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),UNIQUE(org_id,user_id),UNIQUE(org_id,email));
CREATE INDEX org_members_user ON org_members(user_id);
CREATE TABLE org_invitations(id TEXT PRIMARY KEY NOT NULL,org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 email TEXT NOT NULL COLLATE NOCASE,role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),invited_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),UNIQUE(org_id,email));
CREATE INDEX org_invitations_recipient ON org_invitations(email,created_at);
CREATE TRIGGER org_members_need_invite BEFORE INSERT ON org_members WHEN NOT (
 (NEW.role='owner' AND NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=NEW.org_id)) OR EXISTS(
 SELECT 1 FROM org_invitations v JOIN users u ON u.id=NEW.user_id AND u.email=v.email
 WHERE v.id=NEW.id AND v.org_id=NEW.org_id AND v.email=NEW.email AND v.role=NEW.role))
BEGIN SELECT RAISE(ABORT,'invitation acceptance required'); END;
CREATE TRIGGER org_last_owner_update BEFORE UPDATE OF role ON org_members WHEN OLD.role='owner' AND NEW.role!='owner'
 AND NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=OLD.org_id AND id!=OLD.id AND role='owner')
BEGIN SELECT RAISE(ABORT,'last org owner'); END;
CREATE TRIGGER org_last_owner_delete BEFORE DELETE ON org_members WHEN OLD.role='owner' AND EXISTS(SELECT 1 FROM orgs WHERE id=OLD.org_id)
 AND NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=OLD.org_id AND id!=OLD.id AND role='owner')
BEGIN SELECT RAISE(ABORT,'last org owner'); END;
-- Org-level history (membership, settings). App-visible changes are also written to each app's audit_log.
CREATE TABLE org_audit_log(id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
 actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT,data TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX org_audit_page ON org_audit_log(org_id,created_at DESC,id DESC);
CREATE INDEX org_audit_retention ON org_audit_log(created_at);
ALTER TABLE apps ADD COLUMN org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL;
CREATE INDEX apps_org ON apps(org_id,name) WHERE org_id IS NOT NULL;
-- The inbox seeks each app's most recently active issues, private ones included.
CREATE INDEX issues_inbox ON issues(app_id,(status='closed'),updated_at DESC,id DESC);

-- The one definition of "team": every account with an effective role in an app.
CREATE VIEW team_roles(app_id,user_id,role,email,member_id) AS
 SELECT m.app_id,m.user_id,CASE WHEN o.role='owner' OR (o.role='admin' AND m.role!='owner') OR (o.role='member' AND m.role='viewer') THEN o.role ELSE m.role END,m.email,m.id
 FROM members m JOIN apps a ON a.id=m.app_id LEFT JOIN org_members o ON o.org_id=a.org_id AND o.user_id=m.user_id WHERE m.user_id IS NOT NULL
 UNION ALL SELECT a.id,o.user_id,o.role,o.email,NULL FROM org_members o JOIN apps a ON a.org_id=o.org_id
 WHERE NOT EXISTS(SELECT 1 FROM members x WHERE x.app_id=a.id AND x.user_id=o.user_id);
-- Its indexed copy, kept in step by the triggers below inside the same write, so a removal or demotion (in the
-- app or the org) applies to the very next read. The id stays the same while the account stays on the team.
CREATE TABLE team(id TEXT PRIMARY KEY NOT NULL,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,user_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),email TEXT NOT NULL COLLATE NOCASE,UNIQUE(app_id,user_id));
CREATE INDEX team_user ON team(user_id);
CREATE INDEX team_email ON team(email);
INSERT INTO team(id,app_id,user_id,role,email) SELECT coalesce(member_id,lower(hex(randomblob(16)))),app_id,user_id,role,email FROM team_roles WHERE 1;
CREATE TRIGGER team_member_insert AFTER INSERT ON members BEGIN
 INSERT INTO team(id,app_id,user_id,role,email) SELECT coalesce(member_id,lower(hex(randomblob(16)))),app_id,user_id,role,email FROM team_roles WHERE app_id=NEW.app_id AND user_id=NEW.user_id
 ON CONFLICT(app_id,user_id) DO UPDATE SET role=excluded.role,email=excluded.email WHERE role IS NOT excluded.role OR email IS NOT excluded.email;
END;
CREATE TRIGGER team_member_update AFTER UPDATE OF role,user_id,email,app_id ON members BEGIN
 DELETE FROM team WHERE app_id=OLD.app_id AND user_id=OLD.user_id AND NOT EXISTS(SELECT 1 FROM team_roles WHERE app_id=OLD.app_id AND user_id=OLD.user_id);
 INSERT INTO team(id,app_id,user_id,role,email) SELECT coalesce(member_id,lower(hex(randomblob(16)))),app_id,user_id,role,email FROM team_roles
 WHERE (app_id=OLD.app_id AND user_id=OLD.user_id) OR (app_id=NEW.app_id AND user_id=NEW.user_id)
 ON CONFLICT(app_id,user_id) DO UPDATE SET role=excluded.role,email=excluded.email WHERE role IS NOT excluded.role OR email IS NOT excluded.email;
END;
CREATE TRIGGER team_member_delete AFTER DELETE ON members BEGIN
 DELETE FROM team WHERE app_id=OLD.app_id AND user_id=OLD.user_id AND NOT EXISTS(SELECT 1 FROM team_roles WHERE app_id=OLD.app_id AND user_id=OLD.user_id);
 UPDATE team SET role=(SELECT role FROM team_roles r WHERE r.app_id=team.app_id AND r.user_id=team.user_id),email=(SELECT email FROM team_roles r WHERE r.app_id=team.app_id AND r.user_id=team.user_id)
 WHERE app_id=OLD.app_id AND user_id=OLD.user_id;
END;
CREATE TRIGGER team_org_insert AFTER INSERT ON org_members BEGIN
 INSERT INTO team(id,app_id,user_id,role,email) SELECT coalesce(member_id,lower(hex(randomblob(16)))),app_id,user_id,role,email FROM team_roles
 WHERE user_id=NEW.user_id AND app_id IN(SELECT id FROM apps WHERE org_id=NEW.org_id)
 ON CONFLICT(app_id,user_id) DO UPDATE SET role=excluded.role,email=excluded.email WHERE role IS NOT excluded.role OR email IS NOT excluded.email;
END;
CREATE TRIGGER team_org_update AFTER UPDATE OF role,user_id,email,org_id ON org_members BEGIN
 DELETE FROM team WHERE user_id=OLD.user_id AND app_id IN(SELECT id FROM apps WHERE org_id=OLD.org_id) AND NOT EXISTS(SELECT 1 FROM team_roles r WHERE r.app_id=team.app_id AND r.user_id=team.user_id);
 INSERT INTO team(id,app_id,user_id,role,email) SELECT coalesce(member_id,lower(hex(randomblob(16)))),app_id,user_id,role,email FROM team_roles
 WHERE (user_id=OLD.user_id AND app_id IN(SELECT id FROM apps WHERE org_id=OLD.org_id)) OR (user_id=NEW.user_id AND app_id IN(SELECT id FROM apps WHERE org_id=NEW.org_id))
 ON CONFLICT(app_id,user_id) DO UPDATE SET role=excluded.role,email=excluded.email WHERE role IS NOT excluded.role OR email IS NOT excluded.email;
END;
CREATE TRIGGER team_org_delete AFTER DELETE ON org_members BEGIN
 DELETE FROM team WHERE user_id=OLD.user_id AND app_id IN(SELECT id FROM apps WHERE org_id=OLD.org_id) AND NOT EXISTS(SELECT 1 FROM team_roles r WHERE r.app_id=team.app_id AND r.user_id=team.user_id);
 UPDATE team SET role=(SELECT role FROM team_roles r WHERE r.app_id=team.app_id AND r.user_id=team.user_id),email=(SELECT email FROM team_roles r WHERE r.app_id=team.app_id AND r.user_id=team.user_id)
 WHERE user_id=OLD.user_id AND app_id IN(SELECT id FROM apps WHERE org_id=OLD.org_id);
END;
CREATE TRIGGER team_app_org AFTER UPDATE OF org_id ON apps WHEN OLD.org_id IS NOT NEW.org_id BEGIN
 DELETE FROM team WHERE app_id=NEW.id AND NOT EXISTS(SELECT 1 FROM team_roles r WHERE r.app_id=team.app_id AND r.user_id=team.user_id);
 INSERT INTO team(id,app_id,user_id,role,email) SELECT coalesce(member_id,lower(hex(randomblob(16)))),app_id,user_id,role,email FROM team_roles WHERE app_id=NEW.id
 ON CONFLICT(app_id,user_id) DO UPDATE SET role=excluded.role,email=excluded.email WHERE role IS NOT excluded.role OR email IS NOT excluded.email;
END;
CREATE TRIGGER team_app_insert AFTER INSERT ON apps WHEN NEW.org_id IS NOT NULL BEGIN
 INSERT INTO team(id,app_id,user_id,role,email) SELECT coalesce(member_id,lower(hex(randomblob(16)))),app_id,user_id,role,email FROM team_roles WHERE app_id=NEW.id
 ON CONFLICT(app_id,user_id) DO UPDATE SET role=excluded.role,email=excluded.email WHERE role IS NOT excluded.role OR email IS NOT excluded.email;
END;

-- Help desk groups, availability and handoff mail follow the team seat (members of the org included).
DROP VIEW handoff_roster;
DROP TRIGGER handoff_demoted;
DROP TRIGGER handoff_member_added;
DROP TRIGGER handoff_available_insert;
DROP TRIGGER handoff_available_update;
DROP TRIGGER handoff_notify;
CREATE TABLE handoff_members_next(group_id TEXT NOT NULL REFERENCES handoff_groups(id) ON DELETE CASCADE,member_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
 position INTEGER NOT NULL,PRIMARY KEY(group_id,member_id));
INSERT INTO handoff_members_next SELECT group_id,member_id,position FROM handoff_members;
DROP TABLE handoff_members;
ALTER TABLE handoff_members_next RENAME TO handoff_members;
CREATE TABLE handoff_availability_next(member_id TEXT PRIMARY KEY REFERENCES team(id) ON DELETE CASCADE,available INTEGER NOT NULL CHECK(available IN (0,1)));
INSERT INTO handoff_availability_next SELECT member_id,available FROM handoff_availability;
DROP TABLE handoff_availability;
ALTER TABLE handoff_availability_next RENAME TO handoff_availability;
CREATE TABLE handoff_mail_next(id TEXT PRIMARY KEY DEFAULT(lower(hex(randomblob(16)))),event_id TEXT NOT NULL REFERENCES handoff_events(id) ON DELETE CASCADE,
 member_id TEXT NOT NULL REFERENCES team(id) ON DELETE CASCADE,kind TEXT NOT NULL,wake INTEGER NOT NULL DEFAULT 0,UNIQUE(event_id,member_id,kind));
INSERT INTO handoff_mail_next SELECT id,event_id,member_id,kind,wake FROM handoff_mail;
DROP TABLE handoff_mail;
ALTER TABLE handoff_mail_next RENAME TO handoff_mail;
CREATE INDEX handoff_mail_wake ON handoff_mail(wake);
CREATE VIEW handoff_roster AS SELECT g.id group_id,g.app_id,m.user_id,h.position,coalesce(a.available,1) available,
 json_object('type','member','id',u.id,'name',u.name,'avatar_url',u.avatar_url,'role',m.role) actor
 FROM handoff_groups g JOIN handoff_members h ON h.group_id=g.id JOIN team m ON m.id=h.member_id AND m.app_id=g.app_id AND m.role IN ('member','admin','owner')
 JOIN users u ON u.id=m.user_id LEFT JOIN handoff_availability a ON a.member_id=m.id;
CREATE TRIGGER handoff_demoted AFTER UPDATE OF role ON team WHEN NEW.role='viewer' BEGIN
 DELETE FROM handoff_members WHERE member_id=NEW.id; DELETE FROM handoff_availability WHERE member_id=NEW.id; END;
CREATE TRIGGER handoff_member_added AFTER INSERT ON handoff_members BEGIN
 UPDATE handoffs SET next_check=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE group_id=NEW.group_id AND ended_at IS NULL AND waiting='nobody_available'; END;
CREATE TRIGGER handoff_available_insert AFTER INSERT ON handoff_availability WHEN NEW.available=1 BEGIN
 UPDATE handoffs SET next_check=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ended_at IS NULL AND waiting='nobody_available' AND group_id IN(SELECT group_id FROM handoff_members WHERE member_id=NEW.member_id); END;
CREATE TRIGGER handoff_available_update AFTER UPDATE OF available ON handoff_availability WHEN NEW.available=1 AND OLD.available=0 BEGIN
 UPDATE handoffs SET next_check=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ended_at IS NULL AND waiting='nobody_available' AND group_id IN(SELECT group_id FROM handoff_members WHERE member_id=NEW.member_id); END;
CREATE TRIGGER handoff_notify AFTER INSERT ON handoff_events WHEN NEW.type!='handed_back' BEGIN
 INSERT INTO handoff_mail(event_id,member_id,kind)
 SELECT NEW.id,m.id,CASE WHEN NEW.type='reminder' THEN 'reminder' WHEN m.user_id=json_extract(NEW.data,'$.assignee.id') THEN 'assigned' ELSE 'passed' END
 FROM handoffs h JOIN team m ON m.app_id=h.app_id AND m.role IN ('owner','admin','member') WHERE h.id=NEW.handoff_id
 AND (m.user_id=json_extract(NEW.data,'$.assignee.id') OR (NEW.type='reassigned' AND json_extract(NEW.data,'$.assignee.id') IS NOT NULL AND m.user_id=json_extract(NEW.data,'$.from.id')));
 INSERT INTO handoff_mail(event_id,member_id,kind) SELECT NEW.id,m.id,'nobody' FROM handoffs h JOIN team m ON m.app_id=h.app_id AND m.role IN ('admin','owner')
 WHERE h.id=NEW.handoff_id AND json_extract(NEW.data,'$.waiting')='nobody_available' AND NOT EXISTS(SELECT 1 FROM handoff_events old WHERE old.handoff_id=h.id AND old.id!=NEW.id AND json_extract(old.data,'$.waiting')='nobody_available');
 -- An admin who is also the assignee already gets the reminder above.
 INSERT INTO handoff_mail(event_id,member_id,kind) SELECT NEW.id,m.id,'still_waiting' FROM handoffs h JOIN team m ON m.app_id=h.app_id AND m.role IN ('admin','owner') AND m.user_id!=json_extract(NEW.data,'$.assignee.id')
 WHERE h.id=NEW.handoff_id AND NEW.type='reminder' AND h.admins_reminded=0;
 UPDATE handoffs SET admins_reminded=1,next_check=NULL WHERE id=NEW.handoff_id AND NEW.type='reminder'; END;

-- Everything else that asks "is this account on the team?" asks team.
DROP TRIGGER handoff_reply;
CREATE TRIGGER handoff_reply AFTER INSERT ON comments WHEN NEW.internal=0 AND NEW.hidden IS NULL AND (NEW.sent_by IS NOT NULL OR json_extract(NEW.author,'$.type')='member') BEGIN
 UPDATE handoffs SET first_reply=coalesce(first_reply,NEW.created_at),version=version+1,
 respond_by=CASE WHEN json_extract(assignee,'$.id')!=json_extract(coalesce(NEW.sent_by,NEW.author),'$.id') THEN respond_by END,
 next_check=CASE WHEN assignee IS NULL OR json_extract(assignee,'$.id')!=json_extract(coalesce(NEW.sent_by,NEW.author),'$.id') THEN next_check END
 WHERE issue_id=NEW.issue_id AND ended_at IS NULL AND NEW.created_at>=at AND EXISTS(SELECT 1 FROM team m WHERE m.app_id=handoffs.app_id AND m.user_id=json_extract(coalesce(NEW.sent_by,NEW.author),'$.id') AND m.role IN ('member','admin','owner')); END;
DROP TRIGGER blocked_issue;
CREATE TRIGGER blocked_issue BEFORE INSERT ON issues WHEN EXISTS(SELECT 1 FROM blocks WHERE app_id=NEW.app_id AND actor_id=json_extract(NEW.author,'$.id'))
 AND NOT EXISTS(SELECT 1 FROM team WHERE app_id=NEW.app_id AND user_id=json_extract(NEW.author,'$.id')) BEGIN SELECT RAISE(ABORT,'actor blocked'); END;
DROP TRIGGER blocked_comment;
CREATE TRIGGER blocked_comment BEFORE INSERT ON comments WHEN EXISTS(SELECT 1 FROM blocks b JOIN issues i ON i.app_id=b.app_id
 WHERE i.id=NEW.issue_id AND b.actor_id=json_extract(NEW.author,'$.id') AND NOT EXISTS(SELECT 1 FROM team WHERE app_id=i.app_id AND user_id=b.actor_id))
 BEGIN SELECT RAISE(ABORT,'actor blocked'); END;
DROP TRIGGER blocked_upload;
CREATE TRIGGER blocked_upload BEFORE INSERT ON attachments WHEN EXISTS(SELECT 1 FROM blocks WHERE app_id=NEW.app_id AND actor_id=NEW.owner_id)
 AND NOT EXISTS(SELECT 1 FROM team WHERE app_id=NEW.app_id AND user_id=NEW.owner_id) BEGIN SELECT RAISE(ABORT,'actor blocked'); END;
DROP TRIGGER locked_issue_comment;
CREATE TRIGGER locked_issue_comment BEFORE INSERT ON comments WHEN EXISTS(SELECT 1 FROM issues i WHERE i.id=NEW.issue_id AND i.locked=1
 AND json_extract(NEW.author,'$.type')!='agent' AND NOT EXISTS(SELECT 1 FROM team WHERE app_id=i.app_id AND user_id=json_extract(NEW.author,'$.id')))
BEGIN SELECT RAISE(ABORT,'issue is locked'); END;
DROP TRIGGER internal_note_permission;
CREATE TRIGGER internal_note_permission BEFORE INSERT ON comments WHEN NEW.internal=1 AND json_extract(NEW.author,'$.type')!='agent'
 AND NOT EXISTS(SELECT 1 FROM issues i JOIN team m ON m.app_id=i.app_id WHERE i.id=NEW.issue_id AND m.user_id=json_extract(NEW.author,'$.id'))
BEGIN SELECT RAISE(ABORT,'internal notes require team'); END;
DROP TRIGGER desk_verified_reporter;
CREATE TRIGGER desk_verified_reporter BEFORE INSERT ON issues WHEN NEW.github_repo IS NULL AND EXISTS(SELECT 1 FROM apps WHERE id=NEW.app_id AND mode='helpdesk' AND require_verified_email)
 AND NOT EXISTS(SELECT 1 FROM contacts WHERE app_id=NEW.app_id AND id=json_extract(NEW.author,'$.id'))
 AND NOT EXISTS(SELECT 1 FROM team WHERE app_id=NEW.app_id AND user_id=json_extract(NEW.author,'$.id')) BEGIN SELECT RAISE(ABORT,'verified contact required'); END;
DROP VIEW reporter_tiers;
CREATE VIEW reporter_tiers AS SELECT x.app_id,x.actor_id,t.id,t.name,t.color,t.force_private,t.agents_reply,t.assignee_id
  FROM tier_assignments x JOIN tiers t ON t.id=x.tier_id WHERE x.actor_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM team m WHERE m.app_id=x.app_id AND m.user_id=x.actor_id);
DROP TRIGGER validate_tier_assignee_insert;
CREATE TRIGGER validate_tier_assignee_insert BEFORE INSERT ON tiers WHEN NEW.assignee_id IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM team WHERE app_id=NEW.app_id AND user_id=NEW.assignee_id)
BEGIN SELECT RAISE(ABORT,'invalid tier assignee'); END;
DROP TRIGGER validate_tier_assignee_update;
CREATE TRIGGER validate_tier_assignee_update BEFORE UPDATE OF assignee_id ON tiers WHEN NEW.assignee_id IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM team WHERE app_id=NEW.app_id AND user_id=NEW.assignee_id)
BEGIN SELECT RAISE(ABORT,'invalid tier assignee'); END;
DROP TRIGGER clear_tier_assignee;
CREATE TRIGGER clear_tier_assignee AFTER DELETE ON team BEGIN
  UPDATE tiers SET assignee_id=NULL WHERE app_id=OLD.app_id AND assignee_id=OLD.user_id;
END;
DROP TRIGGER github_step_admin;
CREATE TRIGGER github_step_admin INSTEAD OF INSERT ON github_step WHEN NEW.admin_check=1 AND NOT EXISTS(
 SELECT 1 FROM github_jobs j JOIN team m ON m.app_id=j.app_id AND m.user_id=j.requester
 WHERE j.id=NEW.id AND m.role IN ('owner','admin')) BEGIN SELECT RAISE(ABORT,'github admin revoked'); END;
DROP TRIGGER audit_oauth_revoke;
CREATE TRIGGER audit_oauth_revoke BEFORE UPDATE OF revoked_at ON agents WHEN OLD.kind='oauth' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM audit_agent_scope WHERE agent_id=OLD.id) BEGIN
 INSERT INTO audit_log(app_id,actor,action,target,data)
 SELECT m.app_id,json_object('type','agent','id',OLD.id,'name',OLD.name),'agent.revoked',json_object('type','agent','id',OLD.id,'name',OLD.name,'kind',OLD.kind),json_object('kind',OLD.kind)
 FROM team m LEFT JOIN agent_apps ga ON ga.app_id=m.app_id AND ga.agent_id=OLD.id WHERE m.user_id=OLD.user_id AND (CASE WHEN ga.agent_id IS NULL THEN OLD.all_workspaces ELSE ga.role END) IS NOT NULL;
END;
DROP VIEW review_recipients;
CREATE VIEW review_recipients AS SELECT i.id issue_id,u.id user_id,u.email FROM issues i JOIN apps a ON a.id=i.app_id AND a.mode='helpdesk'
 JOIN team m ON m.app_id=i.app_id JOIN users u ON u.id=m.user_id LEFT JOIN mail_settings p ON p.user_id=u.id
 WHERE coalesce(p.approvals,m.role IN ('owner','admin') OR coalesce(json_extract(i.assignee,'$.id')=m.user_id,0))
 AND NOT EXISTS(SELECT 1 FROM mail_suppressed x WHERE x.address=u.email);
DROP VIEW mail_audience;
DROP VIEW mail_people;
CREATE VIEW mail_people AS SELECT s.*,i.app_id,i.number,i.title,i.private,i.hidden,m.role,ga.actor_id owner_alias,
 coalesce(p.opened,1) opened,coalesce(p.replied,1) replied,coalesce(p.mentions,1) mentions,coalesce(p.assigned,1) assigned
 FROM mail_subs s JOIN issues i ON i.id=s.issue_id LEFT JOIN users u ON u.id=s.user_id
 LEFT JOIN guest_report_authors ga ON ga.actor_id=json_extract(i.author,'$.id') AND ga.guest_hash=s.guest_hash AND s.user_id IS NULL
 LEFT JOIN team m ON m.app_id=i.app_id AND m.user_id=s.user_id LEFT JOIN mail_settings p ON p.user_id=s.user_id
 WHERE (s.user_id IS NULL OR u.email=s.address) AND NOT EXISTS(SELECT 1 FROM mail_suppressed x WHERE x.address=s.address)
 AND (m.role IS NOT NULL OR (i.hidden IS NULL AND (i.private=0 OR json_extract(i.author,'$.id')=s.actor_id OR ga.actor_id IS NOT NULL)))
 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.app_id=i.app_id AND (b.actor_id=s.actor_id OR b.actor_id=ga.actor_id OR b.actor_id=(SELECT id FROM users WHERE email=s.address)));
CREATE VIEW mail_audience AS SELECT signal,sub FROM (SELECT g.id signal,p.id sub,row_number() OVER(PARTITION BY g.id,p.address ORDER BY p.user_id IS NULL,p.id) pick FROM mail_signal g JOIN mail_people p ON p.issue_id=g.issue_id
 WHERE p.state='on' AND p.actor_id!=g.actor AND NOT EXISTS(SELECT 1 FROM users sender WHERE sender.id=g.actor AND sender.email=p.address)
 AND NOT EXISTS(SELECT 1 FROM mail_subs sender WHERE sender.issue_id=g.issue_id AND sender.actor_id=g.actor AND sender.state='on' AND sender.address=p.address)
 AND ((p.role IS NULL AND g.target IS NULL AND NOT EXISTS(SELECT 1 FROM team m WHERE m.app_id=p.app_id AND m.email=p.address) AND ((p.reason='opened' AND p.opened) OR (p.reason='replied' AND p.replied) OR p.reason='manual'))
 OR (p.role IS NOT NULL AND g.target=p.actor_id AND ((g.kind='mention' AND p.mentions) OR (g.kind='assigned' AND p.assigned))))) WHERE pick=1;
DROP TRIGGER mail_dispatch;
CREATE TRIGGER mail_dispatch AFTER INSERT ON mail_signal BEGIN
 INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,user_id,address,state,reason)
 SELECT NEW.issue_id,u.id,u.id,u.email,'on',CASE NEW.kind WHEN 'mention' THEN 'mentioned' ELSE 'assigned' END
 FROM users u JOIN team m ON m.user_id=u.id JOIN issues i ON i.app_id=m.app_id AND i.id=NEW.issue_id
 LEFT JOIN mail_settings pref ON pref.user_id=u.id WHERE u.id=NEW.target AND u.id!=NEW.actor AND CASE NEW.kind WHEN 'mention' THEN coalesce(pref.mentions,1) ELSE coalesce(pref.assigned,1) END AND NOT EXISTS(SELECT 1 FROM mail_suppressed x WHERE x.address=u.email);
 INSERT INTO mail_batches(sub_id,issue_id,address) SELECT s.id,s.issue_id,s.address FROM mail_audience a JOIN mail_subs s ON s.id=a.sub WHERE signal=NEW.id
 ON CONFLICT(issue_id,address) WHERE sealed=0 DO UPDATE SET sub_id=excluded.sub_id;
 INSERT OR IGNORE INTO mail_items(batch_id,kind,ref,actor) SELECT b.id,NEW.kind,NEW.ref,NEW.actor FROM mail_audience a JOIN mail_batches b ON b.sub_id=a.sub AND b.sealed=0 WHERE a.signal=NEW.id;
 DELETE FROM mail_signal WHERE id=NEW.id;
END;
