CREATE TABLE api_created_issues(issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE);
CREATE TABLE api_erased_contacts(app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,contact_id TEXT NOT NULL,PRIMARY KEY(app_id,contact_id)) WITHOUT ROWID;
ALTER TABLE api_replays ADD COLUMN contact_id TEXT;
-- This view is for workspace credentials ONLY. The public view and realtime feed remain allowlists.
CREATE VIEW api_workspace_events(issue_id,id,created_at,actor,type,body,edited_at,data,internal,hidden) AS
 SELECT issue_id,id,created_at,actor,type,NULL,NULL,data,1,0 FROM issue_events WHERE type NOT IN ('status_changed','assigned','claimed') OR json_type(data,'$.rule') IS NOT NULL
 UNION ALL SELECT t.issue_id,t.id,i.created_at,i.author,t.type,NULL,NULL,t.data,1,0 FROM tier_issue_events t JOIN issues i ON i.id=t.issue_id AND i.app_id=t.app_id
 UNION ALL SELECT n.issue_id,n.id,n.created_at,NULL,'nudged',NULL,NULL,'{}',1,0 FROM nudge_events n;
CREATE VIEW api_workspace_items AS
 SELECT *,0 internal,0 hidden FROM api_items
 UNION ALL SELECT id,id,created_at,author,'message',body,edited_at,NULL,0,1 FROM issues WHERE hidden IS NOT NULL
 UNION ALL SELECT issue_id,id,created_at,author,'message',body,edited_at,NULL,internal,hidden IS NOT NULL FROM comments WHERE internal=1 OR hidden IS NOT NULL
 UNION ALL SELECT * FROM api_workspace_events;

-- Actor columns are snapshots, not foreign keys. Scrub them in the same transaction as session revocation.
CREATE TRIGGER api_erase_contact BEFORE DELETE ON contacts BEGIN
 INSERT OR IGNORE INTO api_erased_contacts SELECT OLD.app_id,OLD.id WHERE EXISTS(SELECT 1 FROM apps WHERE id=OLD.app_id);
 UPDATE api_replays SET cipher=NULL,status=410 WHERE key_id IN(SELECT id FROM api_keys WHERE app_id=OLD.app_id)
 AND (contact_id=OLD.id OR contact_id IS NULL) AND route!='DELETE /v1/contacts/'||OLD.id;
 DELETE FROM webhook_deliveries WHERE app_id=OLD.app_id AND EXISTS(SELECT 1 FROM json_tree(payload) WHERE key='id' AND atom=OLD.id);
 DELETE FROM confirmation_daily WHERE sub_id IN(SELECT s.id FROM mail_subs s JOIN issues i ON i.id=s.issue_id WHERE i.app_id=OLD.app_id AND s.actor_id=OLD.id);
 DELETE FROM mail_subs WHERE actor_id=OLD.id AND issue_id IN(SELECT id FROM issues WHERE app_id=OLD.app_id);
 DELETE FROM email_codes WHERE app_id=OLD.app_id AND ((kind='contact' AND email=OLD.email) OR (kind='verification' AND (json_extract(requested_by,'$.id')=OLD.id OR issue_id IN(SELECT id FROM issues WHERE app_id=OLD.app_id AND json_extract(author,'$.id')=OLD.id))));
 DELETE FROM api_reads WHERE actor_id=OLD.id AND issue_id IN(SELECT id FROM issues WHERE app_id=OLD.app_id);
 DELETE FROM blocks WHERE app_id=OLD.app_id AND actor_id=OLD.id;
 DELETE FROM tier_assignments WHERE app_id=OLD.app_id AND (actor_id=OLD.id OR pending_email=OLD.email);
 DELETE FROM guest_report_authors WHERE origin_app=OLD.app_id AND actor_id=OLD.id;
 DELETE FROM attachments WHERE app_id=OLD.app_id AND owner_id=OLD.id AND id IN(SELECT id FROM api_pending_uploads);
 UPDATE issues SET activity=NULL WHERE app_id=OLD.app_id AND json_extract(activity,'$.actor.id')=OLD.id;
 UPDATE issues SET author='{"type":"guest","id":"deleted-user","name":"Deleted user","handle":"deleted-user"}',reporter_locale=NULL,revision=revision+1 WHERE app_id=OLD.app_id AND json_extract(author,'$.id')=OLD.id;
 UPDATE comments SET author='{"type":"guest","id":"deleted-user","name":"Deleted user","handle":"deleted-user"}',revision=revision+1 WHERE issue_id IN(SELECT id FROM issues WHERE app_id=OLD.app_id) AND json_extract(author,'$.id')=OLD.id;
 UPDATE revisions SET actor='{"type":"guest","id":"deleted-user","name":"Deleted user","handle":"deleted-user"}' WHERE issue_id IN(SELECT id FROM issues WHERE app_id=OLD.app_id) AND json_extract(actor,'$.id')=OLD.id;
 UPDATE issue_events SET actor='{"type":"guest","id":"deleted-user","name":"Deleted user","handle":"deleted-user"}' WHERE issue_id IN(SELECT id FROM issues WHERE app_id=OLD.app_id) AND json_extract(actor,'$.id')=OLD.id;
 UPDATE audit_log SET actor='{"type":"guest","id":"deleted-user","name":"Deleted user","handle":"deleted-user"}' WHERE app_id=OLD.app_id AND json_extract(actor,'$.id')=OLD.id;
END;
-- A background webhook writer might still hold an old actor/contact snapshot after erasure.
CREATE TRIGGER api_no_erased_webhook BEFORE INSERT ON webhook_deliveries WHEN EXISTS(SELECT 1 FROM api_erased_contacts WHERE app_id=NEW.app_id) AND EXISTS(
 SELECT 1 FROM json_tree(NEW.payload) j JOIN api_erased_contacts x ON x.app_id=NEW.app_id AND x.contact_id=j.atom WHERE j.key='id') BEGIN SELECT RAISE(IGNORE); END;
