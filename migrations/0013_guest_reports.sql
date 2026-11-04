-- Private discovery index; never store a browser cookie or a cross-workspace identifier in posts.
CREATE TABLE guest_report_authors (
  actor_id TEXT PRIMARY KEY NOT NULL, origin_app TEXT NOT NULL, guest_hash TEXT, name TEXT
);
CREATE INDEX reports_by_browser ON guest_report_authors(guest_hash,actor_id) WHERE guest_hash IS NOT NULL;
CREATE INDEX reports_unbound ON guest_report_authors(name,origin_app) WHERE guest_hash IS NULL;
-- Old posts have only their scoped actor ID. A name narrows the candidate origins on the
-- first read; only hashing the actual cookie with an origin can prove ownership. For a
-- transferred issue the oldest move, not its current workspace, supplies the origin.
INSERT OR IGNORE INTO guest_report_authors(actor_id,origin_app,name)
  SELECT json_extract(i.author,'$.id'),coalesce((SELECT from_app FROM issue_moves WHERE issue_id=i.id ORDER BY rowid LIMIT 1),i.app_id),
    json_extract(i.author,'$.name') FROM issues i WHERE json_extract(i.author,'$.type')='guest';
-- During rollout an old writer must also leave a discoverable entry.
CREATE TRIGGER remember_report_author AFTER INSERT ON issues WHEN json_extract(NEW.author,'$.type')='guest' BEGIN
  INSERT OR IGNORE INTO guest_report_authors(actor_id,origin_app,name) VALUES(json_extract(NEW.author,'$.id'),NEW.app_id,json_extract(NEW.author,'$.name'));
END;
CREATE TRIGGER rename_report_author AFTER UPDATE OF author ON issues WHEN json_extract(NEW.author,'$.type')='guest' BEGIN
  UPDATE guest_report_authors SET name=json_extract(NEW.author,'$.name') WHERE guest_hash IS NULL AND actor_id=json_extract(NEW.author,'$.id');
END;
CREATE TRIGGER forget_claimed_report_author AFTER UPDATE OF author ON issues WHEN json_extract(OLD.author,'$.type')='guest' AND json_extract(NEW.author,'$.type')!='guest' BEGIN
  DELETE FROM guest_report_authors WHERE actor_id=json_extract(OLD.author,'$.id') AND NOT EXISTS(SELECT 1 FROM issues WHERE json_extract(author,'$.id')=json_extract(OLD.author,'$.id'));
END;
CREATE TRIGGER forget_deleted_report_author AFTER DELETE ON issues WHEN json_extract(OLD.author,'$.type')='guest' BEGIN
  DELETE FROM guest_report_authors WHERE actor_id=json_extract(OLD.author,'$.id') AND NOT EXISTS(SELECT 1 FROM issues WHERE json_extract(author,'$.id')=json_extract(OLD.author,'$.id'));
END;
