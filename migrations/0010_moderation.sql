ALTER TABLE apps ADD COLUMN default_private INTEGER NOT NULL DEFAULT 0 CHECK(default_private IN (0,1));
ALTER TABLE apps ADD COLUMN reporter_can_choose INTEGER NOT NULL DEFAULT 0 CHECK(reporter_can_choose IN (0,1));
ALTER TABLE issues ADD COLUMN private INTEGER NOT NULL DEFAULT 0 CHECK(private IN (0,1));
ALTER TABLE issues ADD COLUMN hidden TEXT;
ALTER TABLE issues ADD COLUMN edited_at TEXT;
ALTER TABLE comments ADD COLUMN hidden TEXT;
ALTER TABLE comments ADD COLUMN edited_at TEXT;
ALTER TABLE comments ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE issue_tombstones (app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, number INTEGER NOT NULL, PRIMARY KEY(app_id,number));
CREATE TRIGGER reserved_issue_number BEFORE INSERT ON issues WHEN EXISTS
  (SELECT 1 FROM issue_tombstones WHERE app_id=NEW.app_id AND number=NEW.number)
BEGIN SELECT RAISE(ABORT,'deleted issue number is reserved'); END;
-- The feed only seeks over publicly visible issues, even in an app with a long private backlog.
DROP INDEX issues_feed_page;
CREATE INDEX issues_feed_page ON issues(app_id,(status='closed'),updated_at DESC,id DESC) WHERE private=0 AND hidden IS NULL;
CREATE TABLE revisions (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE, actor TEXT NOT NULL, title TEXT, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX revisions_target ON revisions(issue_id,comment_id,created_at DESC);
CREATE TABLE blocks (id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, actor_id TEXT NOT NULL,
  actor TEXT NOT NULL, moderator TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(app_id,actor_id));
CREATE INDEX comments_attachments ON attachment_links(comment_id) WHERE comment_id IS NOT NULL;
CREATE TRIGGER purge_linked_attachment AFTER DELETE ON attachment_links BEGIN DELETE FROM attachments WHERE id=OLD.attachment_id; END;
-- Keep the block decision in the transaction too, including uploads that were still streaming when blocked.
CREATE TRIGGER blocked_issue BEFORE INSERT ON issues WHEN EXISTS(SELECT 1 FROM blocks WHERE app_id=NEW.app_id AND actor_id=json_extract(NEW.author,'$.id'))
 AND NOT EXISTS(SELECT 1 FROM members WHERE app_id=NEW.app_id AND user_id=json_extract(NEW.author,'$.id')) BEGIN SELECT RAISE(ABORT,'actor blocked'); END;
CREATE TRIGGER blocked_comment BEFORE INSERT ON comments WHEN EXISTS(SELECT 1 FROM blocks b JOIN issues i ON i.app_id=b.app_id
 WHERE i.id=NEW.issue_id AND b.actor_id=json_extract(NEW.author,'$.id') AND NOT EXISTS(SELECT 1 FROM members WHERE app_id=i.app_id AND user_id=b.actor_id))
 BEGIN SELECT RAISE(ABORT,'actor blocked'); END;
CREATE TRIGGER blocked_upload BEFORE INSERT ON attachments WHEN EXISTS(SELECT 1 FROM blocks WHERE app_id=NEW.app_id AND actor_id=NEW.owner_id)
 AND NOT EXISTS(SELECT 1 FROM members WHERE app_id=NEW.app_id AND user_id=NEW.owner_id) BEGIN SELECT RAISE(ABORT,'actor blocked'); END;
