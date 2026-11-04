-- Only a browser hash is retained. Guest writes after logout dirty the link, without ever
-- authorizing the guest cookie to act as the account or letting another account take it over.
CREATE TABLE guest_links (
  guest_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  generation INTEGER NOT NULL DEFAULT 0,
  claimed_generation INTEGER NOT NULL DEFAULT -1
);
CREATE INDEX issues_activity_actor ON issues(json_extract(activity,'$.actor.id')) WHERE activity IS NOT NULL;
