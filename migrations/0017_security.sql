-- Only accepted seats live in members. Preserve existing teams; carry old unbound
-- invitations forward without looking up accounts or inventing an inviter identity.
CREATE TABLE workspace_invitations(id TEXT PRIMARY KEY NOT NULL,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 email TEXT NOT NULL COLLATE NOCASE,role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),invited_by TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')),UNIQUE(app_id,email));
CREATE INDEX invitations_recipient ON workspace_invitations(email,created_at);
INSERT INTO workspace_invitations(id,app_id,email,role,invited_by) SELECT id,app_id,email,role,'{"name":"Workspace team","avatar_url":null}' FROM members WHERE user_id IS NULL;
DELETE FROM members WHERE user_id IS NULL;
-- Reject pre-consent writers during rollout. The initial workspace owner and the
-- authenticated redemption of a matching invitation are the only legal insertions.
CREATE TRIGGER members_need_invite BEFORE INSERT ON members WHEN NEW.user_id IS NULL OR NOT (
 (NEW.role='owner' AND NOT EXISTS(SELECT 1 FROM members WHERE app_id=NEW.app_id)) OR EXISTS(
 SELECT 1 FROM workspace_invitations v JOIN users u ON u.id=NEW.user_id AND u.email=v.email
 WHERE v.id=NEW.id AND v.app_id=NEW.app_id AND v.email=NEW.email AND v.role=NEW.role))
BEGIN SELECT RAISE(ABORT,'invitation acceptance required'); END;
-- UPSERT on returning sign-in takes the UPDATE path. Account tier still wins over pending.
CREATE TRIGGER bind_returning_email_tier AFTER UPDATE OF name,avatar_url,google_sub ON users BEGIN
 INSERT OR IGNORE INTO tier_assignments(app_id,tier_id,actor_id) SELECT x.app_id,x.tier_id,NEW.id FROM tier_assignments x WHERE x.pending_email=NEW.email AND NOT EXISTS(SELECT 1 FROM members m WHERE m.app_id=x.app_id AND m.user_id=NEW.id)
 AND NOT EXISTS(SELECT 1 FROM tier_assignments a WHERE a.app_id=x.app_id AND a.actor_id=NEW.id);
 DELETE FROM tier_assignments WHERE pending_email=NEW.email;
END;
-- Legacy tombstones lack ACLs. Keep their numbers reserved, but never advertise them.
CREATE TABLE public_issue_tombstones(app_id TEXT NOT NULL,number INTEGER NOT NULL,PRIMARY KEY(app_id,number),FOREIGN KEY(app_id,number) REFERENCES issue_tombstones(app_id,number) ON DELETE CASCADE);
CREATE TRIGGER remember_public_deletion AFTER INSERT ON issue_tombstones WHEN EXISTS(SELECT 1 FROM issues WHERE app_id=NEW.app_id AND number=NEW.number AND private=0 AND hidden IS NULL) BEGIN
 INSERT OR IGNORE INTO public_issue_tombstones VALUES(NEW.app_id,NEW.number); END;
CREATE TABLE confirmation_daily(address TEXT PRIMARY KEY COLLATE NOCASE,day TEXT NOT NULL,sub_id TEXT NOT NULL,nonce TEXT NOT NULL,n INTEGER NOT NULL CONSTRAINT confirmation_daily_limit CHECK(n BETWEEN 1 AND 3));
-- Existing challenges keep their cooldown after the upgrade.
INSERT INTO confirmation_daily SELECT address,date('now'),id,nonce,1 FROM (SELECT *,row_number() OVER(PARTITION BY address ORDER BY requested DESC,id) latest FROM mail_subs WHERE state='pending' AND requested>=unixepoch()-86400) WHERE latest=1;
CREATE TABLE report_key_daily(key_id TEXT PRIMARY KEY REFERENCES report_keys(id) ON DELETE CASCADE,day TEXT NOT NULL,uploads INTEGER NOT NULL,bytes INTEGER NOT NULL,
 CONSTRAINT report_daily_limit CHECK(uploads<=500 AND bytes<=209715200));
