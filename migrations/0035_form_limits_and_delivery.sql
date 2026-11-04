-- Bound the active catalog returned by /v1/workspace. Check in the write transaction,
-- including restores and concurrent admin edits. Legacy catalogs may shrink without data loss.
CREATE VIEW request_catalog_usage AS SELECT app_id,count(*) active,sum(length(CAST(fields AS BLOB))) bytes
 FROM request_types WHERE archived=0 GROUP BY app_id;
CREATE TRIGGER request_catalog_insert AFTER INSERT ON request_types WHEN NEW.archived=0 BEGIN
 SELECT CASE WHEN active>50 THEN RAISE(ABORT,'active request type limit') WHEN bytes>262144 THEN RAISE(ABORT,'request fields byte limit') END
 FROM request_catalog_usage WHERE app_id=NEW.app_id; END;
CREATE TRIGGER request_catalog_update AFTER UPDATE OF archived,fields ON request_types WHEN NEW.archived=0
 AND (OLD.archived=1 OR length(CAST(NEW.fields AS BLOB))>length(CAST(OLD.fields AS BLOB))) BEGIN
 SELECT CASE WHEN OLD.archived=1 AND active>50 THEN RAISE(ABORT,'active request type limit') WHEN bytes>262144 THEN RAISE(ABORT,'request fields byte limit') END
 FROM request_catalog_usage WHERE app_id=NEW.app_id; END;

-- Form submissions reserve quota, challenge and delivery together. Queue messages only
-- reference IDs; deletion/erasure cascades, and completed challenges lose the ciphertext.
CREATE TABLE form_code_mail(id TEXT PRIMARY KEY REFERENCES email_codes(id) ON DELETE CASCADE,
 cipher TEXT NOT NULL, sender TEXT NOT NULL, locale TEXT NOT NULL, wake INTEGER NOT NULL DEFAULT(unixepoch()+60));
CREATE INDEX form_code_mail_wake ON form_code_mail(wake);
CREATE TRIGGER form_code_done AFTER UPDATE OF state ON email_codes WHEN NEW.state!='pending' AND OLD.state='pending' BEGIN
 DELETE FROM form_code_mail WHERE id=NEW.id; END;
