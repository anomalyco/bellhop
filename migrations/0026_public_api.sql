ALTER TABLE apps ADD COLUMN allow_anonymous INTEGER NOT NULL DEFAULT 0 CHECK(allow_anonymous IN (0,1));
ALTER TABLE contacts ADD COLUMN locale TEXT;
CREATE TABLE api_keys(id TEXT PRIMARY KEY,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('publishable','secret')),name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,preview TEXT NOT NULL,
 created_at TEXT NOT NULL,last_used_at TEXT,UNIQUE(app_id,id));
CREATE TABLE api_origins(key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,origin TEXT NOT NULL,PRIMARY KEY(key_id,origin)) WITHOUT ROWID;
CREATE INDEX api_preflight ON api_origins(origin,key_id);
CREATE TABLE api_sessions(hash TEXT PRIMARY KEY,app_id TEXT NOT NULL,key_id TEXT NOT NULL,origin TEXT,contact_id TEXT,anon_id TEXT UNIQUE,
 anon_name TEXT,locale TEXT NOT NULL,expires INTEGER NOT NULL,CHECK((anon_id IS NULL)!=(contact_id IS NULL)),
 FOREIGN KEY(app_id,key_id) REFERENCES api_keys(app_id,id) ON DELETE CASCADE,
 FOREIGN KEY(app_id,contact_id) REFERENCES contacts(app_id,id) ON DELETE CASCADE);
CREATE INDEX api_session_expiry ON api_sessions(expires);
CREATE INDEX api_session_contact ON api_sessions(app_id,contact_id);
CREATE TRIGGER api_mint_guard BEFORE INSERT ON api_sessions WHEN NOT EXISTS(
 SELECT 1 FROM apps a JOIN api_keys k ON k.app_id=a.id WHERE a.id=NEW.app_id AND a.mode='helpdesk' AND k.id=NEW.key_id
 AND (NEW.anon_id IS NULL OR a.allow_anonymous) AND ((k.kind='secret' AND NEW.origin IS NULL) OR EXISTS(SELECT 1 FROM api_origins WHERE key_id=k.id AND origin=NEW.origin)))
 BEGIN SELECT RAISE(ABORT,'v1 credential unavailable'); END;
CREATE TABLE api_replays(key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,scope TEXT NOT NULL,route TEXT NOT NULL,nonce TEXT NOT NULL,
 digest TEXT NOT NULL,status INTEGER,cipher TEXT,expires INTEGER NOT NULL,PRIMARY KEY(key_id,scope,route,nonce)) WITHOUT ROWID;
CREATE INDEX api_replay_expiry ON api_replays(expires);
CREATE TRIGGER api_desk_exit AFTER UPDATE OF mode ON apps WHEN OLD.mode='helpdesk' AND NEW.mode!='helpdesk' BEGIN
 DELETE FROM api_sessions WHERE app_id=NEW.id; DELETE FROM api_replays WHERE key_id IN (SELECT id FROM api_keys WHERE app_id=NEW.id); END;
CREATE TABLE api_reads(issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,actor_id TEXT NOT NULL,stamp TEXT NOT NULL,item TEXT NOT NULL,PRIMARY KEY(issue_id,actor_id)) WITHOUT ROWID;
-- An empty guard table: a stale grant in a multi-statement D1 write aborts the transaction.
CREATE TABLE api_guard(live INTEGER NOT NULL CONSTRAINT api_session_required CHECK(live=1));
CREATE VIEW api_items AS
 SELECT id issue_id,id,created_at,author actor,'message' type,body,edited_at,NULL data FROM issues WHERE hidden IS NULL
 UNION ALL SELECT issue_id,id,created_at,author,'message',body,edited_at,NULL FROM comments WHERE internal=0 AND hidden IS NULL
 UNION ALL SELECT issue_id,id,created_at,actor,type,NULL,NULL,data FROM issue_events WHERE type IN ('status_changed','assigned','claimed') AND json_type(data,'$.rule') IS NULL
 UNION ALL SELECT issue_id,'request:'||id,created_at,requested_by,'verification_requested',NULL,NULL,json_object('verification_id',id) FROM email_codes WHERE kind='verification'
 UNION ALL SELECT v.issue_id,'verified:'||v.id,v.verified_at,i.author,'verified',NULL,NULL,json_object('verification_id',v.id) FROM email_codes v JOIN issues i ON i.id=v.issue_id AND i.app_id=v.app_id WHERE v.kind='verification' AND v.state='verified';
