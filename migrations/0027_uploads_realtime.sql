-- Worker-only, derived from deployment configuration, never from key settings.
CREATE TABLE api_workspace_origins(app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,origin TEXT NOT NULL,PRIMARY KEY(app_id,origin)) WITHOUT ROWID;
DROP TRIGGER api_mint_guard;
CREATE TRIGGER api_mint_guard BEFORE INSERT ON api_sessions WHEN NOT EXISTS(
 SELECT 1 FROM apps a JOIN api_keys k ON k.app_id=a.id WHERE a.id=NEW.app_id AND a.mode='helpdesk' AND k.id=NEW.key_id
 AND (NEW.anon_id IS NULL OR a.allow_anonymous) AND ((k.kind='secret' AND NEW.origin IS NULL) OR (k.kind='publishable' AND
 (EXISTS(SELECT 1 FROM api_origins WHERE key_id=k.id AND origin=NEW.origin) OR EXISTS(SELECT 1 FROM api_workspace_origins WHERE app_id=a.id AND origin=NEW.origin)))))
 BEGIN SELECT RAISE(ABORT,'v1 credential unavailable'); END;

CREATE TABLE api_pending_uploads(id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,expires INTEGER NOT NULL);
CREATE INDEX api_pending_expiry ON api_pending_uploads(expires);
CREATE TABLE api_upload_gc(object_key TEXT PRIMARY KEY,due INTEGER NOT NULL);
CREATE INDEX api_upload_gc_due ON api_upload_gc(due);
CREATE TRIGGER api_attachment_age BEFORE INSERT ON attachment_links WHEN EXISTS(SELECT 1 FROM api_pending_uploads WHERE id=NEW.attachment_id AND expires<=unixepoch())
 BEGIN SELECT RAISE(ABORT,'invalid attachment'); END;
CREATE TRIGGER api_attachment_claim AFTER INSERT ON attachment_links BEGIN DELETE FROM api_pending_uploads WHERE id=NEW.attachment_id; END;
CREATE TRIGGER api_pending_delete BEFORE DELETE ON attachments WHEN EXISTS(SELECT 1 FROM api_pending_uploads WHERE id=OLD.id)
 BEGIN INSERT OR REPLACE INTO api_upload_gc VALUES(OLD.object_key,0); END;

CREATE TABLE api_socket_tickets(hash TEXT PRIMARY KEY,session_hash TEXT NOT NULL REFERENCES api_sessions(hash) ON DELETE CASCADE,origin TEXT,expires INTEGER NOT NULL);
CREATE INDEX api_socket_ticket_expiry ON api_socket_tickets(expires);
CREATE TABLE api_watched(session_hash TEXT PRIMARY KEY REFERENCES api_sessions(hash) ON DELETE CASCADE);
CREATE TABLE api_socket_revocations(id INTEGER PRIMARY KEY AUTOINCREMENT,app_id TEXT NOT NULL,actor TEXT NOT NULL);
CREATE TRIGGER api_socket_revoke BEFORE DELETE ON api_sessions WHEN EXISTS(SELECT 1 FROM api_watched WHERE session_hash=OLD.hash)
 BEGIN INSERT INTO api_socket_revocations(app_id,actor) VALUES(OLD.app_id,coalesce(OLD.contact_id,OLD.anon_id)); END;
