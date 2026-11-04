-- The status and pagination indexes can seek the workspace, but not an opening window.
CREATE INDEX issues_app_created ON issues(app_id,created_at);
