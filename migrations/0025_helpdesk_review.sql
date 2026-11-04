ALTER TABLE apps ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0 CHECK(trusted IN (0,1));
-- There is no safe way to bind an already-issued challenge to its browser.
UPDATE email_codes SET state='expired',digest=NULL WHERE kind!='verification' AND state='pending' AND requested_by IS NULL;
DROP INDEX one_signin_code;
CREATE UNIQUE INDEX one_signin_code ON email_codes(kind,coalesce(app_id,''),email,requested_by) WHERE kind!='verification' AND state='pending';

CREATE TABLE code_recipients(app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,day TEXT NOT NULL,scope TEXT NOT NULL,address_hash TEXT NOT NULL,
 PRIMARY KEY(app_id,day,scope,address_hash)) WITHOUT ROWID;
CREATE INDEX code_recipient_expiry ON code_recipients(day);
CREATE TRIGGER code_recipient_limit AFTER INSERT ON code_recipients WHEN
 (SELECT count(*) FROM code_recipients WHERE app_id=NEW.app_id AND day=NEW.day AND scope=NEW.scope)>
 CASE WHEN NEW.scope!='workspace' THEN 3 WHEN (SELECT trusted FROM apps WHERE id=NEW.app_id) THEN 1000 ELSE 50 END
 BEGIN SELECT RAISE(ABORT,'code_limit'); END;

CREATE TABLE review_sessions AS SELECT s.*,min(unixepoch(t.created_at),s.expires-2592000) born FROM contact_sessions s JOIN contacts t ON t.app_id=s.app_id AND t.id=s.contact_id;
DROP TABLE contact_sessions;
CREATE TABLE contact_sessions(hash TEXT PRIMARY KEY,app_id TEXT NOT NULL,contact_id TEXT NOT NULL,expires INTEGER NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()),renewed_at INTEGER NOT NULL DEFAULT(unixepoch()),CHECK(expires<=created_at+7776000),
 FOREIGN KEY(app_id,contact_id) REFERENCES contacts(app_id,id) ON DELETE CASCADE);
-- Old rows lack an issuance time. Use a conservative lower bound, not a new 90-day lease.
INSERT INTO contact_sessions SELECT hash,app_id,contact_id,min(expires,born+7776000),born,expires-2592000 FROM review_sessions;
DROP TABLE review_sessions;
CREATE INDEX contact_expiry ON contact_sessions(expires);
