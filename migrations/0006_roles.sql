-- SQLite cannot widen a CHECK constraint in place. Keep membership and invitation IDs intact.
CREATE TABLE members_new (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id), email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','viewer')),
  UNIQUE(app_id,email), UNIQUE(app_id,user_id)
);
INSERT INTO members_new(id,app_id,user_id,email,role) SELECT id,app_id,user_id,email,role FROM members;
DROP TABLE members;
ALTER TABLE members_new RENAME TO members;
CREATE INDEX members_user ON members(user_id);
CREATE INDEX members_email ON members(email);

-- A pending invitation is not a usable owner. Guard inside the write transaction so concurrent
-- demotions/removals cannot each rely on the other owner remaining.
CREATE TRIGGER members_last_owner_update BEFORE UPDATE OF role ON members
WHEN OLD.role='owner' AND OLD.user_id IS NOT NULL AND NEW.role!='owner' AND NOT EXISTS
  (SELECT 1 FROM members WHERE app_id=OLD.app_id AND id!=OLD.id AND role='owner' AND user_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'last workspace owner'); END;
CREATE TRIGGER members_last_owner_delete BEFORE DELETE ON members
WHEN OLD.role='owner' AND OLD.user_id IS NOT NULL AND EXISTS (SELECT 1 FROM apps WHERE id=OLD.app_id) AND NOT EXISTS
  (SELECT 1 FROM members WHERE app_id=OLD.app_id AND id!=OLD.id AND role='owner' AND user_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'last workspace owner'); END;

ALTER TABLE agent_tokens ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('viewer','responder','member','admin'));
ALTER TABLE oauth_grant_apps ADD COLUMN role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('viewer','responder','member','admin'));
ALTER TABLE oauth_grants ADD COLUMN create_workspaces INTEGER NOT NULL DEFAULT 0 CHECK(create_workspaces IN (0,1));
