-- Unlisted by default, including all workspaces that existed before the feed.
ALTER TABLE apps ADD COLUMN public INTEGER NOT NULL DEFAULT 0 CHECK(public IN (0,1));
CREATE INDEX apps_public_directory ON apps(public,slug) WHERE public=1;
-- Seek to a page boundary within each public workspace and state; a busy private
-- workspace must not make a public feed page walk its issues.
CREATE INDEX issues_feed_page ON issues(app_id,(status='closed'),updated_at DESC,id DESC);
