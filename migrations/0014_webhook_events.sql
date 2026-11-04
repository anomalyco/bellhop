-- Matches DEFAULT_WEBHOOK_EVENTS; old inserts that omit events keep the same behaviour.
ALTER TABLE webhook_settings ADD COLUMN events TEXT NOT NULL
  DEFAULT '["issue.opened","issue.updated","comment.created","mention.created"]'
  CHECK (json_valid(events) AND json_type(events)='array');
