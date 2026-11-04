-- One account-owned identity and workspace ACL for both authentication methods. Preserve
-- actor IDs, OAuth refresh families, access tokens, and static secrets already in use.
CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('oauth','token')), client_id TEXT REFERENCES oauth_clients(id),
  token_hash TEXT UNIQUE, preview TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER,
  create_workspaces INTEGER NOT NULL DEFAULT 0 CHECK(create_workspaces IN (0,1)),
  all_workspaces TEXT CHECK(all_workspaces IN ('viewer','responder','member','admin')),
  CHECK((kind='oauth' AND client_id IS NOT NULL AND token_hash IS NULL AND preview IS NULL) OR
        (kind='token' AND client_id IS NULL AND token_hash IS NOT NULL AND preview IS NOT NULL))
);
CREATE INDEX agents_user ON agents(user_id,revoked_at);
INSERT INTO agents(id,user_id,name,kind,client_id,created_at,last_used_at,revoked_at,create_workspaces)
SELECT g.id,g.user_id,c.name,'oauth',g.client_id,g.created_at,g.last_used_at,g.revoked_at,g.create_workspaces
FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id;
-- A missing joined owner fails NOT NULL, rolling back rather than silently orphaning a token.
INSERT INTO agents(id,user_id,name,kind,token_hash,preview,created_at,last_used_at)
SELECT t.id,(SELECT user_id FROM members WHERE app_id=t.app_id AND role='owner' AND user_id IS NOT NULL ORDER BY rowid LIMIT 1),
  t.name,'token',t.token_hash,t.preview,unixepoch(t.created_at),unixepoch(t.last_used_at) FROM agent_tokens t;
CREATE TABLE agent_apps (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  role TEXT CHECK(role IN ('viewer','responder','member','admin')),
  -- An app admin may adjust an agent's workspace role, but cannot manufacture delegation
  -- from an owner to change other owners/admins by upgrading that owner's read-only agent.
  delegated_admin INTEGER NOT NULL DEFAULT 0 CHECK(delegated_admin IN (0,1)), PRIMARY KEY(agent_id,app_id)
);
CREATE INDEX agent_apps_app ON agent_apps(app_id);
INSERT INTO agent_apps(agent_id,app_id,role) SELECT grant_id,app_id,role FROM oauth_grant_apps;
INSERT INTO agent_apps(agent_id,app_id,role) SELECT id,app_id,'member' FROM agent_tokens;

CREATE TABLE oauth_codes_new (
  hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES agents(id), redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, spent_by TEXT
);
INSERT INTO oauth_codes_new SELECT * FROM oauth_codes;
CREATE TABLE oauth_tokens_new (
  hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), expires_at INTEGER NOT NULL, spent_by TEXT
);
INSERT INTO oauth_tokens_new SELECT * FROM oauth_tokens;
DROP TABLE oauth_codes;
ALTER TABLE oauth_codes_new RENAME TO oauth_codes;
DROP TABLE oauth_tokens;
ALTER TABLE oauth_tokens_new RENAME TO oauth_tokens;
CREATE INDEX oauth_tokens_expiry ON oauth_tokens(kind,expires_at);
DROP TABLE oauth_grant_apps;
DROP TABLE oauth_grants;
DROP TABLE agent_tokens;
