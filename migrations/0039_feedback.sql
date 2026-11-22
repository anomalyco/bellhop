-- In-app feedback: what an app's feedback form sent with each issue, for the team and agents. An anonymous send keeps
-- no email, user, install id or logs; the CHECK makes that structural. install_hash is the reporter's per-app guest id
-- (a keyed hash of the install id) and groups an install's reports.
CREATE TABLE feedback(issue_id TEXT PRIMARY KEY NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 anonymous INTEGER NOT NULL CHECK(anonymous IN (0,1)),
 email TEXT COLLATE NOCASE,user TEXT,app TEXT,device TEXT,install TEXT,install_hash TEXT,
 platform TEXT COLLATE NOCASE,app_version TEXT,category TEXT,screenshots TEXT NOT NULL DEFAULT '[]',created_at TEXT NOT NULL,
 CHECK(anonymous=0 OR (email IS NULL AND user IS NULL AND install IS NULL AND install_hash IS NULL)));
CREATE INDEX feedback_install ON feedback(app_id,install_hash,created_at DESC) WHERE install_hash IS NOT NULL;
CREATE TRIGGER feedback_transfer AFTER UPDATE OF app_id ON issues WHEN OLD.app_id!=NEW.app_id BEGIN
 UPDATE feedback SET app_id=NEW.app_id WHERE issue_id=NEW.id; END;
-- The form's metadata, one row per key, so meta:<key>=<value> is an index lookup.
CREATE TABLE feedback_meta(issue_id TEXT NOT NULL REFERENCES feedback(issue_id) ON DELETE CASCADE,key TEXT NOT NULL,value TEXT NOT NULL,
 PRIMARY KEY(issue_id,key)) WITHOUT ROWID;
-- Abuse budgets. Windows are replaced in place (per report key per minute, per install per hour); old ones are pruned.
CREATE TABLE feedback_rate(key TEXT PRIMARY KEY NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('key','install')),bucket INTEGER NOT NULL,
 hits INTEGER NOT NULL,cap INTEGER NOT NULL,
 CONSTRAINT feedback_key_rate CHECK(scope!='key' OR hits<=cap),CONSTRAINT feedback_install_rate CHECK(scope!='install' OR hits<=cap));
CREATE TABLE feedback_key_daily(key_id TEXT PRIMARY KEY REFERENCES report_keys(id) ON DELETE CASCADE,day TEXT NOT NULL,n INTEGER NOT NULL,
 bytes INTEGER NOT NULL,CONSTRAINT feedback_daily_limit CHECK(n<=1000),CONSTRAINT feedback_byte_quota CHECK(bytes<=1073741824));
