ALTER TABLE apps ADD COLUMN default_autonomy TEXT NOT NULL DEFAULT 'suggest' CHECK(default_autonomy IN ('suggest','approve_actions','autonomous'));
CREATE TABLE request_types(id TEXT PRIMARY KEY,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 name TEXT NOT NULL,description TEXT NOT NULL,fields TEXT NOT NULL,require_verification INTEGER NOT NULL CHECK(require_verification IN (0,1)),
 route TEXT,autonomy TEXT CHECK(autonomy IN ('suggest','approve_actions','autonomous')),position INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 version INTEGER NOT NULL DEFAULT 1,UNIQUE(app_id,id));
CREATE INDEX request_type_order ON request_types(app_id,position,id);
CREATE TABLE request_answers(issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,app_id TEXT NOT NULL,type_id TEXT NOT NULL,
 answers TEXT NOT NULL,public_answers TEXT NOT NULL,FOREIGN KEY(app_id,type_id) REFERENCES request_types(app_id,id) ON DELETE CASCADE);
CREATE INDEX request_answers_type ON request_answers(app_id,type_id);
-- Separate from issue_events: neither old public readers nor realtime catch-up can expose routing decisions.
CREATE TABLE request_route_events(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,actor TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX request_route_history ON request_route_events(issue_id,created_at,id);
CREATE TABLE request_type_guard(ok INTEGER NOT NULL CONSTRAINT request_type_changed CHECK(ok=1));
CREATE TRIGGER request_type_transfer AFTER UPDATE OF app_id ON issues WHEN OLD.app_id!=NEW.app_id BEGIN
 DELETE FROM request_answers WHERE issue_id=NEW.id; DELETE FROM request_route_events WHERE issue_id=NEW.id; END;
CREATE TRIGGER erase_request_answers AFTER UPDATE OF author ON issues WHEN json_extract(NEW.author,'$.id')='deleted-user' AND json_extract(OLD.author,'$.id')!=json_extract(NEW.author,'$.id') BEGIN
 UPDATE request_answers SET answers='{}',public_answers='{}' WHERE issue_id=NEW.id;
 UPDATE request_route_events SET actor=NEW.author WHERE issue_id=NEW.id AND json_extract(actor,'$.id')=json_extract(OLD.author,'$.id'); END;
DROP VIEW api_workspace_events;
CREATE VIEW api_workspace_events(issue_id,id,created_at,actor,type,body,edited_at,data,internal,hidden) AS
 SELECT issue_id,id,created_at,actor,type,NULL,NULL,data,1,0 FROM issue_events WHERE type NOT IN ('status_changed','assigned','claimed') OR json_type(data,'$.rule') IS NOT NULL
 UNION ALL SELECT t.issue_id,t.id,i.created_at,i.author,t.type,NULL,NULL,t.data,1,0 FROM tier_issue_events t JOIN issues i ON i.id=t.issue_id AND i.app_id=t.app_id
 UNION ALL SELECT n.issue_id,n.id,n.created_at,NULL,'nudged',NULL,NULL,'{}',1,0 FROM nudge_events n
 UNION ALL SELECT e.issue_id,e.id,e.created_at,e.actor,'routed',NULL,NULL,e.data,1,0 FROM request_route_events e JOIN issues i ON i.id=e.issue_id AND i.app_id=e.app_id JOIN apps a ON a.id=i.app_id AND a.mode='helpdesk';
