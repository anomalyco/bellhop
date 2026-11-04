-- Rotation changes the bearer, not its absolute clock or rate/storage budgets.
ALTER TABLE api_sessions ADD COLUMN born INTEGER NOT NULL DEFAULT 0;
ALTER TABLE api_sessions ADD COLUMN family TEXT;
UPDATE api_sessions SET born=expires-86400,family=hash;
CREATE TRIGGER api_session_birth AFTER INSERT ON api_sessions WHEN NEW.born=0 OR NEW.family IS NULL BEGIN
 UPDATE api_sessions SET born=CASE WHEN NEW.born=0 THEN unixepoch() ELSE NEW.born END,family=coalesce(NEW.family,NEW.hash) WHERE hash=NEW.hash;
END;
CREATE TRIGGER api_rotation_cap BEFORE INSERT ON api_sessions WHEN NEW.born!=0 AND (NEW.expires>NEW.born+2592000 OR NEW.expires<=unixepoch())
 BEGIN SELECT RAISE(ABORT,'v1 credential unavailable'); END;
