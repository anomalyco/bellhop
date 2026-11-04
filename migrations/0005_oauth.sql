CREATE TABLE oauth_clients (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL, grant_types TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER
);
CREATE INDEX oauth_grants_user ON oauth_grants(user_id,revoked_at);
CREATE TABLE oauth_grant_apps (
  grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE, PRIMARY KEY(grant_id,app_id)
);
CREATE TABLE oauth_requests (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(id),
  kind TEXT NOT NULL CHECK(kind IN ('authorization_code','device')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','consumed')),
  expires_at INTEGER NOT NULL, browser_hash TEXT, redirect_uri TEXT, state TEXT, challenge TEXT,
  device_hash TEXT UNIQUE, user_code_hash TEXT UNIQUE, next_poll INTEGER NOT NULL DEFAULT 0,
  poll_interval INTEGER NOT NULL DEFAULT 5, grant_id TEXT, spent_by TEXT
);
CREATE INDEX oauth_requests_expiry ON oauth_requests(expires_at);
CREATE TABLE oauth_codes (
  hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id), redirect_uri TEXT NOT NULL,
  challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, spent_by TEXT
);
CREATE TABLE oauth_tokens (
  hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id),
  kind TEXT NOT NULL CHECK(kind IN ('access','refresh')), expires_at INTEGER NOT NULL, spent_by TEXT
);
CREATE INDEX oauth_tokens_expiry ON oauth_tokens(kind,expires_at);
CREATE TABLE oauth_limits (key TEXT PRIMARY KEY, until INTEGER NOT NULL, hits INTEGER NOT NULL);
CREATE INDEX oauth_limits_expiry ON oauth_limits(until);
