-- Idempotent feedback retries: the v1 replay records (see api_replays), scoped to a report key, with the same
-- 1000 active nonces per key and client IP.
CREATE TABLE feedback_replays(key_id TEXT NOT NULL REFERENCES report_keys(id) ON DELETE CASCADE,scope TEXT NOT NULL,route TEXT NOT NULL,
 nonce TEXT NOT NULL,digest TEXT NOT NULL,status INTEGER,cipher TEXT,expires INTEGER NOT NULL,contact_id TEXT,budget_scope TEXT,
 PRIMARY KEY(key_id,scope,route,nonce)) WITHOUT ROWID;
CREATE INDEX feedback_replay_expiry ON feedback_replays(expires);
CREATE INDEX feedback_nonce_budget ON feedback_replays(key_id,coalesce(budget_scope,scope),expires);
CREATE TRIGGER feedback_nonce_cap AFTER INSERT ON feedback_replays WHEN EXISTS(SELECT 1 FROM feedback_replays
 WHERE key_id=NEW.key_id AND coalesce(budget_scope,scope)=coalesce(NEW.budget_scope,NEW.scope) AND expires>unixepoch() LIMIT 1 OFFSET 1000)
 BEGIN SELECT RAISE(ABORT,'api_nonce_limit'); END;
