CREATE TABLE users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  google_sub TEXT UNIQUE, name TEXT NOT NULL, avatar_url TEXT
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);
CREATE TABLE apps (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  description TEXT NOT NULL, created_at TEXT NOT NULL, issue_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE members (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id), email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('owner','member')), UNIQUE(app_id,email), UNIQUE(app_id,user_id)
);
CREATE INDEX members_user ON members(user_id);
CREATE INDEX members_email ON members(email);
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, preview TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE labels (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL, description TEXT NOT NULL,
  UNIQUE(app_id,name)
);
CREATE TABLE templates (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  ask_system_info INTEGER NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE template_labels (
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE, PRIMARY KEY(template_id,label_id)
);
CREATE TABLE issues (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  number INTEGER NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','waiting','closed')),
  close_reason TEXT CHECK((status='closed') = (close_reason IS NOT NULL) AND close_reason IN ('completed','not_planned','duplicate')),
  author TEXT NOT NULL, assignee TEXT, system_info TEXT, activity TEXT,
  template_id TEXT REFERENCES templates(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, UNIQUE(app_id,number)
);
CREATE TABLE comments (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX comments_issue ON comments(issue_id,created_at);
CREATE TABLE attachments (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE attachment_links (
  attachment_id TEXT PRIMARY KEY REFERENCES attachments(id), issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE
);
CREATE INDEX attachment_links_issue ON attachment_links(issue_id,comment_id);
CREATE TRIGGER attachment_owner BEFORE INSERT ON attachment_links WHEN NOT EXISTS (
  SELECT 1 FROM attachments a JOIN issues i ON i.id=NEW.issue_id AND i.app_id=a.app_id
  LEFT JOIN comments c ON c.id=NEW.comment_id AND c.issue_id=i.id
  WHERE a.id=NEW.attachment_id AND a.owner_id=CASE WHEN NEW.comment_id IS NULL THEN json_extract(i.author,'$.id') ELSE json_extract(c.author,'$.id') END
) BEGIN SELECT RAISE(ABORT,'invalid attachment'); END;
CREATE TABLE issue_labels (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE, PRIMARY KEY(issue_id,label_id)
);
CREATE TABLE relations (
  id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('related','blocks','duplicate_of')),
  CHECK(source_id<>target_id), UNIQUE(source_id,target_id,type)
);
CREATE INDEX relations_target ON relations(target_id);
CREATE TABLE issue_events (
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX issue_events_issue ON issue_events(issue_id,created_at);
CREATE TABLE webhook_settings (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE, url TEXT, secret TEXT NOT NULL
);
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  event TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  response_status INTEGER, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX webhook_deliveries_app ON webhook_deliveries(app_id,created_at);

CREATE VIRTUAL TABLE issue_fts USING fts5(title, body);
CREATE TRIGGER issue_fts_insert AFTER INSERT ON issues BEGIN
  INSERT INTO issue_fts(rowid,title,body) VALUES(NEW.rowid,NEW.title,NEW.body);
END;
CREATE TRIGGER issue_fts_update AFTER UPDATE OF title,body ON issues BEGIN
  UPDATE issue_fts SET title=NEW.title,body=NEW.body WHERE rowid=NEW.rowid;
END;
CREATE TRIGGER issue_fts_delete AFTER DELETE ON issues BEGIN DELETE FROM issue_fts WHERE rowid=OLD.rowid; END;
CREATE VIRTUAL TABLE comment_fts USING fts5(body);
CREATE TRIGGER comment_fts_insert AFTER INSERT ON comments BEGIN
  INSERT INTO comment_fts(rowid,body) VALUES(NEW.rowid,NEW.body);
END;
CREATE TRIGGER comment_fts_update AFTER UPDATE OF body ON comments BEGIN
  UPDATE comment_fts SET body=NEW.body WHERE rowid=NEW.rowid;
END;
CREATE TRIGGER comment_fts_delete AFTER DELETE ON comments BEGIN DELETE FROM comment_fts WHERE rowid=OLD.rowid; END;

-- Enforce limits inside the write transaction, including simultaneous requests.
CREATE INDEX issues_rate ON issues(json_extract(author,'$.id'),created_at);
CREATE INDEX comments_rate ON comments(json_extract(author,'$.id'),created_at);
CREATE INDEX attachments_rate ON attachments(owner_id,created_at);
CREATE TRIGGER issues_rate_limit BEFORE INSERT ON issues WHEN (SELECT count(*) FROM issues
  WHERE json_extract(author,'$.id')=json_extract(NEW.author,'$.id') AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))>=10
  BEGIN SELECT RAISE(ABORT,'rate limited'); END;
CREATE TRIGGER comments_rate_limit BEFORE INSERT ON comments WHEN (SELECT count(*) FROM comments
  WHERE json_extract(author,'$.id')=json_extract(NEW.author,'$.id') AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))>=60
  BEGIN SELECT RAISE(ABORT,'rate limited'); END;
CREATE TRIGGER uploads_rate_limit BEFORE INSERT ON attachments WHEN (SELECT count(*) FROM attachments
  WHERE owner_id=NEW.owner_id AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))>=40
  BEGIN SELECT RAISE(ABORT,'rate limited'); END;
