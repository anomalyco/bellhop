-- A host subject need not have a verified mailbox. Copy the child rows too:
-- dropping the old parent with foreign keys enabled would cascade to sessions.
CREATE TABLE h1b_contacts AS SELECT * FROM contacts;
CREATE TABLE h1b_sessions AS SELECT * FROM contact_sessions;
DROP TRIGGER contact_follow_open;
DROP TABLE contact_sessions;
DROP TABLE contacts;
CREATE TABLE contacts(
 id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 email TEXT COLLATE NOCASE, name TEXT, external_id TEXT, unverified_email TEXT,
 verified_via TEXT NOT NULL DEFAULT 'email' CHECK(verified_via IN ('email','host')),
 created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
 UNIQUE(app_id,email), UNIQUE(app_id,external_id), UNIQUE(app_id,id), CHECK(email IS NOT NULL OR external_id IS NOT NULL)
);
INSERT INTO contacts(id,app_id,email,name,created_at,last_seen_at) SELECT id,app_id,email,name,created_at,last_seen_at FROM h1b_contacts;
CREATE INDEX contact_page ON contacts(app_id,created_at DESC,id DESC);
CREATE TABLE contact_sessions(hash TEXT PRIMARY KEY,app_id TEXT NOT NULL,contact_id TEXT NOT NULL,expires INTEGER NOT NULL,
 FOREIGN KEY(app_id,contact_id) REFERENCES contacts(app_id,id) ON DELETE CASCADE);
INSERT INTO contact_sessions SELECT hash,app_id,contact_id,expires FROM h1b_sessions;
CREATE INDEX contact_expiry ON contact_sessions(expires);
DROP TABLE h1b_sessions;
DROP TABLE h1b_contacts;

CREATE TRIGGER contact_follow_open AFTER INSERT ON issues BEGIN
 INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,address,state,reason,locale)
 SELECT NEW.id,t.id,t.email,'on','opened',NEW.reporter_locale FROM contacts t JOIN apps a ON a.id=t.app_id
 WHERE a.mode='helpdesk' AND t.app_id=NEW.app_id AND t.id=json_extract(NEW.author,'$.id') AND t.email IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM mail_suppressed WHERE address=t.email); END;
-- Old reply-by-email credentials must not outlive a replaced verified address.
CREATE TRIGGER contact_email_changed AFTER UPDATE OF email ON contacts WHEN OLD.email IS NOT NULL AND NEW.email IS NOT OLD.email BEGIN
 DELETE FROM mail_subs WHERE actor_id=OLD.id AND address=OLD.email AND issue_id IN (SELECT id FROM issues WHERE app_id=OLD.app_id); END;

CREATE TABLE identity_keys(id TEXT PRIMARY KEY,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 name TEXT NOT NULL,preview TEXT NOT NULL,cipher TEXT NOT NULL,created_at TEXT NOT NULL,last_used_at TEXT);
CREATE INDEX identity_keys_app ON identity_keys(app_id);
CREATE TABLE identity_uses(app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,jti TEXT NOT NULL,expires INTEGER NOT NULL,
 PRIMARY KEY(app_id,jti)) WITHOUT ROWID;
CREATE INDEX identity_uses_expiry ON identity_uses(expires);
