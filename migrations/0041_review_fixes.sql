-- Fixes from the security review of orgs and feedback (ace0d77..f7d85eb).

-- H1. An org's owners own its apps. Apps created in an org give their creator no direct seat (they're on the team
-- through the org), so an org owner counts as an app owner for the last-owner rule, an app can only leave its org
-- with a direct owner, and someone already on the team through the org may be given a direct seat (an ownership
-- transfer, or the org owner who takes an app out of the org).
DROP TRIGGER members_last_owner_update;
CREATE TRIGGER members_last_owner_update BEFORE UPDATE OF role ON members
WHEN OLD.role='owner' AND OLD.user_id IS NOT NULL AND NEW.role!='owner' AND NOT EXISTS
  (SELECT 1 FROM members WHERE app_id=OLD.app_id AND id!=OLD.id AND role='owner' AND user_id IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM apps a JOIN org_members o ON o.org_id=a.org_id AND o.role='owner' WHERE a.id=OLD.app_id)
BEGIN SELECT RAISE(ABORT,'last workspace owner'); END;
DROP TRIGGER members_last_owner_delete;
CREATE TRIGGER members_last_owner_delete BEFORE DELETE ON members
WHEN OLD.role='owner' AND OLD.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM apps WHERE id=OLD.app_id) AND NOT EXISTS
  (SELECT 1 FROM members WHERE app_id=OLD.app_id AND id!=OLD.id AND role='owner' AND user_id IS NOT NULL)
  AND NOT EXISTS(SELECT 1 FROM apps a JOIN org_members o ON o.org_id=a.org_id AND o.role='owner' WHERE a.id=OLD.app_id)
BEGIN SELECT RAISE(ABORT,'last workspace owner'); END;
CREATE TRIGGER app_leaves_org_owned BEFORE UPDATE OF org_id ON apps WHEN OLD.org_id IS NOT NULL AND NEW.org_id IS NULL
  AND NOT EXISTS(SELECT 1 FROM members WHERE app_id=NEW.id AND role='owner' AND user_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'last workspace owner'); END;
DROP TRIGGER members_need_invite;
CREATE TRIGGER members_need_invite BEFORE INSERT ON members WHEN NEW.user_id IS NULL OR NOT (
 (NEW.role='owner' AND NOT EXISTS(SELECT 1 FROM members WHERE app_id=NEW.app_id)
   AND NOT EXISTS(SELECT 1 FROM apps WHERE id=NEW.app_id AND org_id IS NOT NULL)) OR EXISTS(
 SELECT 1 FROM workspace_invitations v JOIN users u ON u.id=NEW.user_id AND u.email=v.email
 WHERE v.id=NEW.id AND v.app_id=NEW.app_id AND v.email=NEW.email AND v.role=NEW.role) OR EXISTS(
 SELECT 1 FROM team t JOIN users u ON u.id=t.user_id AND u.email=NEW.email WHERE t.app_id=NEW.app_id AND t.user_id=NEW.user_id))
BEGIN SELECT RAISE(ABORT,'invitation acceptance required'); END;

-- M2. A feedback reporter's confirmation goes out when the team first replies, one at a time per (app, address),
-- at most 3 a day per (app, address).
CREATE TABLE feedback_confirmations(app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,address TEXT NOT NULL COLLATE NOCASE,
 day TEXT NOT NULL,sub_id TEXT NOT NULL,nonce TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(app_id,address),
 CONSTRAINT feedback_confirmation_limit CHECK(n BETWEEN 1 AND 3)) WITHOUT ROWID;

-- M4. A daily budget per report key and client (an HMAC of the IP), under the key's own daily caps; the workspace's
-- admins hear once a day when a key hits its own caps.
CREATE TABLE feedback_ip_daily(key_id TEXT NOT NULL REFERENCES report_keys(id) ON DELETE CASCADE,client TEXT NOT NULL,day TEXT NOT NULL,
 n INTEGER NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(key_id,client),
 CONSTRAINT feedback_ip_daily_limit CHECK(n<=50),CONSTRAINT feedback_ip_byte_quota CHECK(bytes<=104857600)) WITHOUT ROWID;
CREATE INDEX feedback_ip_daily_day ON feedback_ip_daily(day);
CREATE TABLE feedback_key_alerts(key_id TEXT PRIMARY KEY NOT NULL REFERENCES report_keys(id) ON DELETE CASCADE,day TEXT NOT NULL) WITHOUT ROWID;

-- L7. A feedback issue the team makes public shows its reporter as "Anonymous" (the app-given name stays in
-- FeedbackInfo.user for the team).
CREATE TRIGGER feedback_published AFTER UPDATE OF private ON issues WHEN OLD.private=1 AND NEW.private=0
  AND json_extract(NEW.author,'$.type')='guest' AND EXISTS(SELECT 1 FROM feedback WHERE issue_id=NEW.id) BEGIN
 UPDATE comments SET author=json_set(author,'$.name','Anonymous') WHERE issue_id=NEW.id AND json_extract(author,'$.id')=json_extract(NEW.author,'$.id');
 UPDATE issue_events SET actor=json_set(actor,'$.name','Anonymous') WHERE issue_id=NEW.id AND json_extract(actor,'$.id')=json_extract(NEW.author,'$.id');
 UPDATE issues SET author=json_set(author,'$.name','Anonymous') WHERE id=NEW.id;
END;

-- L8. Feedback is a per-key permission: keys from before this release only upload report metadata until an admin
-- turns feedback on; new keys take feedback.
ALTER TABLE report_keys ADD COLUMN feedback INTEGER NOT NULL DEFAULT 0 CHECK(feedback IN (0,1));
