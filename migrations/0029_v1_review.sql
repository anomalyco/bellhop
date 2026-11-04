ALTER TABLE api_replays ADD COLUMN budget_scope TEXT;
CREATE INDEX api_nonce_budget ON api_replays(key_id,coalesce(budget_scope,scope),expires);
CREATE TRIGGER api_nonce_cap AFTER INSERT ON api_replays WHEN EXISTS(SELECT 1 FROM api_replays
 WHERE key_id=NEW.key_id AND coalesce(budget_scope,scope)=coalesce(NEW.budget_scope,NEW.scope) AND expires>unixepoch() LIMIT 1 OFFSET 1000)
 BEGIN SELECT RAISE(ABORT,'api_nonce_limit'); END;
CREATE TABLE api_upload_bytes(app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,day TEXT NOT NULL,scope TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(app_id,day,scope)) WITHOUT ROWID;
CREATE INDEX api_bytes_expiry ON api_upload_bytes(day);
CREATE TRIGGER api_bytes_insert AFTER INSERT ON api_upload_bytes WHEN NEW.bytes>CASE WHEN NEW.scope!='workspace' THEN 268435456 WHEN (SELECT trusted FROM apps WHERE id=NEW.app_id) THEN 21474836480 ELSE 2147483648 END BEGIN SELECT RAISE(ABORT,'api_upload_quota'); END;
CREATE TRIGGER api_bytes_update AFTER UPDATE OF bytes ON api_upload_bytes WHEN NEW.bytes>CASE WHEN NEW.scope!='workspace' THEN 268435456 WHEN (SELECT trusted FROM apps WHERE id=NEW.app_id) THEN 21474836480 ELSE 2147483648 END BEGIN SELECT RAISE(ABORT,'api_upload_quota'); END;
