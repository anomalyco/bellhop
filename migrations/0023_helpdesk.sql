ALTER TABLE apps ADD COLUMN mode TEXT NOT NULL DEFAULT 'tracker' CHECK(mode IN ('tracker','helpdesk') AND (mode!='helpdesk' OR public=0));
ALTER TABLE apps ADD COLUMN require_verified_email INTEGER NOT NULL DEFAULT 1 CHECK(require_verified_email IN (0,1));
-- name is the required display label used by existing clients. An email-only
-- account has no profile name; its display label is the email local part.
ALTER TABLE users ADD COLUMN profile_name TEXT;
UPDATE users SET profile_name=name;
CREATE TRIGGER google_profile_name AFTER INSERT ON users WHEN NEW.google_sub IS NOT NULL BEGIN UPDATE users SET profile_name=NEW.name WHERE id=NEW.id; END;
CREATE TRIGGER update_profile_name AFTER UPDATE OF name ON users WHEN NEW.google_sub IS NOT NULL BEGIN UPDATE users SET profile_name=NEW.name WHERE id=NEW.id; END;

CREATE TABLE contacts(id TEXT PRIMARY KEY,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,email TEXT NOT NULL COLLATE NOCASE,name TEXT,
 created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,UNIQUE(app_id,email),UNIQUE(app_id,id));
CREATE INDEX contact_page ON contacts(app_id,created_at DESC,id DESC);
CREATE TABLE contact_sessions(hash TEXT PRIMARY KEY,app_id TEXT NOT NULL,contact_id TEXT NOT NULL,expires INTEGER NOT NULL,
 FOREIGN KEY(app_id,contact_id) REFERENCES contacts(app_id,id) ON DELETE CASCADE);
CREATE INDEX contact_expiry ON contact_sessions(expires);
CREATE TRIGGER contact_follow_open AFTER INSERT ON issues BEGIN
 INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,address,state,reason,locale) SELECT NEW.id,t.id,t.email,'on','opened',NEW.reporter_locale FROM contacts t JOIN apps a ON a.id=t.app_id WHERE a.mode='helpdesk' AND t.app_id=NEW.app_id AND t.id=json_extract(NEW.author,'$.id') AND NOT EXISTS(SELECT 1 FROM mail_suppressed WHERE address=t.email); END;
CREATE TRIGGER desk_enter AFTER UPDATE OF mode ON apps WHEN NEW.mode='helpdesk' AND OLD.mode!='helpdesk' BEGIN
 UPDATE issues SET private=1,revision=revision+1 WHERE app_id=NEW.id AND private=0;
 DELETE FROM public_issue_tombstones WHERE app_id=NEW.id;
END;
CREATE TRIGGER desk_private_insert BEFORE INSERT ON issues WHEN NEW.private=0 AND EXISTS(SELECT 1 FROM apps WHERE id=NEW.app_id AND mode='helpdesk') BEGIN SELECT RAISE(ABORT,'help desk requests are private'); END;
CREATE TRIGGER desk_private_update BEFORE UPDATE OF private,app_id ON issues WHEN NEW.private=0 AND EXISTS(SELECT 1 FROM apps WHERE id=NEW.app_id AND mode='helpdesk') BEGIN SELECT RAISE(ABORT,'help desk requests are private'); END;
-- The checked insert is also a barrier for older HTTP writers during rollout.
CREATE TRIGGER desk_verified_reporter BEFORE INSERT ON issues WHEN NEW.github_repo IS NULL AND EXISTS(SELECT 1 FROM apps WHERE id=NEW.app_id AND mode='helpdesk' AND require_verified_email)
 AND NOT EXISTS(SELECT 1 FROM contacts WHERE app_id=NEW.app_id AND id=json_extract(NEW.author,'$.id'))
 AND NOT EXISTS(SELECT 1 FROM members WHERE app_id=NEW.app_id AND user_id=json_extract(NEW.author,'$.id')) BEGIN SELECT RAISE(ABORT,'verified contact required'); END;

CREATE TABLE email_codes(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('account','contact','verification')),app_id TEXT REFERENCES apps(id) ON DELETE CASCADE,
 issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE,email TEXT NOT NULL COLLATE NOCASE,requested_by TEXT,digest TEXT,
 tries INTEGER NOT NULL DEFAULT 0,expires INTEGER NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL,verified_at TEXT,
 CHECK((state='pending')=(digest IS NOT NULL)));
CREATE UNIQUE INDEX one_signin_code ON email_codes(kind,coalesce(app_id,''),email) WHERE kind!='verification' AND state='pending';
CREATE INDEX code_issue ON email_codes(issue_id,app_id,created_at);
CREATE INDEX code_expiry ON email_codes(expires) WHERE state='pending';
CREATE TABLE code_budget(key TEXT PRIMARY KEY,bucket INTEGER NOT NULL,hits INTEGER NOT NULL,cap INTEGER NOT NULL,CONSTRAINT code_limit CHECK(hits<=cap));
CREATE TABLE verification_outbox(id TEXT PRIMARY KEY REFERENCES email_codes(id) ON DELETE CASCADE,destination_hash TEXT);
CREATE TRIGGER verification_finished AFTER UPDATE OF state ON email_codes WHEN OLD.kind='verification' AND OLD.state='pending' AND NEW.state!='pending' BEGIN
 INSERT INTO verification_outbox(id) VALUES(NEW.id); END;
CREATE TRIGGER desk_exit AFTER UPDATE OF mode ON apps WHEN NEW.mode='tracker' AND OLD.mode='helpdesk' BEGIN
 DELETE FROM contact_sessions WHERE app_id=NEW.id;
 DELETE FROM email_codes WHERE app_id=NEW.id AND kind='contact'; END;
-- Proof is scoped to the original workspace, not an asset to carry on transfer.
CREATE TRIGGER clear_transferred_proof AFTER UPDATE OF app_id ON issues WHEN NEW.app_id!=OLD.app_id BEGIN DELETE FROM email_codes WHERE issue_id=NEW.id; END;
