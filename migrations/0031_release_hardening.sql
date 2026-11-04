-- Receipt IDs correlate authenticated bounce/complaint feedback with our own recipient.
-- Old receipts have no timestamp; give them one final 30-day feedback window.
ALTER TABLE mail_sent ADD COLUMN sent_at INTEGER NOT NULL DEFAULT 0;
UPDATE mail_sent SET sent_at=unixepoch();
CREATE INDEX mail_sent_age ON mail_sent(sent_at);
CREATE INDEX mail_sent_address ON mail_sent(address);
CREATE TRIGGER mail_sent_time AFTER INSERT ON mail_sent WHEN NEW.sent_at=0 BEGIN
 UPDATE mail_sent SET sent_at=unixepoch() WHERE provider_id=NEW.provider_id; END;
CREATE TRIGGER erase_contact_receipts BEFORE DELETE ON contacts BEGIN
 DELETE FROM mail_sent WHERE address=OLD.email OR address=OLD.unverified_email; END;

-- Existing publishable keys cannot be recovered from their hashes. Secret keys
-- are never recoverable, including after this migration.
ALTER TABLE api_keys ADD COLUMN publishable_value TEXT CHECK(publishable_value IS NULL OR (kind='publishable' AND substr(publishable_value,1,6)='bh_pk_'));
