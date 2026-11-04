CREATE TABLE guest_names (
  guest_hash TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 40),
  updated_at TEXT NOT NULL
);

-- Issues and comments already index their scoped author IDs for rate limiting.
CREATE INDEX issue_events_actor ON issue_events(json_extract(actor,'$.id'));
