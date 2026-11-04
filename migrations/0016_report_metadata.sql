CREATE TABLE report_keys (
 id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, preview TEXT NOT NULL, created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE INDEX report_keys_app ON report_keys(app_id);
CREATE TABLE report_metadata (
 id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 title TEXT, message TEXT, source TEXT, system TEXT NOT NULL, context TEXT NOT NULL, fingerprint TEXT,
 created_at TEXT NOT NULL, expires_at TEXT, ready INTEGER NOT NULL DEFAULT 0,
 issue_id TEXT REFERENCES issues(id) ON DELETE CASCADE, comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
 CHECK ((issue_id IS NULL)=(expires_at IS NOT NULL)), CHECK(comment_id IS NULL OR issue_id IS NOT NULL)
);
CREATE INDEX report_metadata_issue ON report_metadata(issue_id);
CREATE INDEX report_metadata_comment ON report_metadata(comment_id) WHERE comment_id IS NOT NULL;
CREATE INDEX report_metadata_expiry ON report_metadata(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX report_metadata_matches ON report_metadata(app_id,fingerprint,issue_id) WHERE issue_id IS NOT NULL;
-- A diagnostic attachment never goes into ordinary attachment_links: even an older
-- Worker/Room cannot mistake a report on a public thread for a public file.
CREATE TABLE report_logs (
 id TEXT PRIMARY KEY NOT NULL, metadata_id TEXT NOT NULL REFERENCES report_metadata(id) ON DELETE CASCADE,
 name TEXT NOT NULL, size INTEGER NOT NULL, object_key TEXT NOT NULL UNIQUE, UNIQUE(metadata_id,name)
);
CREATE TABLE report_log_gc(object_key TEXT PRIMARY KEY NOT NULL);
CREATE TRIGGER report_log_removed AFTER DELETE ON report_logs BEGIN INSERT OR IGNORE INTO report_log_gc VALUES(OLD.object_key); END;
CREATE TABLE expired_reports(id TEXT PRIMARY KEY NOT NULL,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE);
CREATE TRIGGER report_expired BEFORE DELETE ON report_metadata WHEN OLD.ready=1 AND OLD.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') BEGIN
 INSERT OR IGNORE INTO expired_reports VALUES(OLD.id,OLD.app_id);
END;
CREATE TRIGGER move_reports AFTER UPDATE OF app_id ON issues WHEN NEW.app_id!=OLD.app_id BEGIN
 UPDATE report_metadata SET app_id=NEW.app_id WHERE issue_id=NEW.id;
END;
-- Shared transaction precondition for editing or consuming a capability. A failed claim
-- rolls back the entire issue/comment mutation (including counters, events and email).
CREATE VIEW pending_report AS SELECT id,app_id FROM report_metadata WHERE issue_id IS NULL;
CREATE TRIGGER check_pending_report INSTEAD OF INSERT ON pending_report BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM expired_reports WHERE id=NEW.id AND app_id=NEW.app_id) THEN RAISE(ABORT,'expired report metadata')
 WHEN NOT EXISTS(SELECT 1 FROM report_metadata WHERE id=NEW.id AND app_id=NEW.app_id AND ready=1) THEN RAISE(ABORT,'unknown report metadata')
 WHEN EXISTS(SELECT 1 FROM report_metadata WHERE id=NEW.id AND issue_id IS NOT NULL) THEN RAISE(ABORT,'report metadata already attached')
 WHEN EXISTS(SELECT 1 FROM report_metadata WHERE id=NEW.id AND expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN RAISE(ABORT,'expired report metadata') END;
END;
