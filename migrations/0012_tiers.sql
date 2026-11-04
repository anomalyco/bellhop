CREATE TABLE tiers (
  id TEXT PRIMARY KEY NOT NULL, app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE, color TEXT NOT NULL, description TEXT NOT NULL, position INTEGER NOT NULL,
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL, force_private INTEGER NOT NULL CHECK(force_private IN (0,1)),
  agents_reply INTEGER NOT NULL CHECK(agents_reply IN (0,1)), UNIQUE(app_id,name), UNIQUE(app_id,id)
);
CREATE INDEX tiers_position ON tiers(app_id,position,name);
CREATE TABLE tier_labels (
  tier_id TEXT NOT NULL REFERENCES tiers(id) ON DELETE CASCADE, label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY(tier_id,label_id)
);
CREATE TABLE tier_assignments (
  app_id TEXT NOT NULL, tier_id TEXT NOT NULL, actor_id TEXT, pending_email TEXT COLLATE NOCASE,
  CHECK((actor_id IS NULL)!=(pending_email IS NULL)), UNIQUE(app_id,actor_id), UNIQUE(app_id,pending_email),
  FOREIGN KEY(app_id,tier_id) REFERENCES tiers(app_id,id) ON DELETE CASCADE
);
CREATE INDEX assignments_tier ON tier_assignments(tier_id);
CREATE INDEX assignments_email ON tier_assignments(pending_email) WHERE pending_email IS NOT NULL;
CREATE INDEX assignments_actor ON tier_assignments(actor_id) WHERE actor_id IS NOT NULL;
CREATE VIEW reporter_tiers AS SELECT x.app_id,x.actor_id,t.id,t.name,t.color,t.force_private,t.agents_reply,t.assignee_id
  FROM tier_assignments x JOIN tiers t ON t.id=x.tier_id WHERE x.actor_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM members m WHERE m.app_id=x.app_id AND m.user_id=x.actor_id);

CREATE TRIGGER validate_tier_label BEFORE INSERT ON tier_labels WHEN NOT EXISTS
  (SELECT 1 FROM labels l JOIN tiers t ON t.app_id=l.app_id WHERE l.id=NEW.label_id AND t.id=NEW.tier_id)
BEGIN SELECT RAISE(ABORT,'invalid tier label'); END;
CREATE TRIGGER validate_tier_assignee_insert BEFORE INSERT ON tiers WHEN NEW.assignee_id IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM members WHERE app_id=NEW.app_id AND user_id=NEW.assignee_id)
BEGIN SELECT RAISE(ABORT,'invalid tier assignee'); END;
CREATE TRIGGER validate_tier_assignee_update BEFORE UPDATE OF assignee_id ON tiers WHEN NEW.assignee_id IS NOT NULL AND NOT EXISTS
  (SELECT 1 FROM members WHERE app_id=NEW.app_id AND user_id=NEW.assignee_id)
BEGIN SELECT RAISE(ABORT,'invalid tier assignee'); END;
CREATE TRIGGER clear_tier_assignee AFTER DELETE ON members WHEN OLD.user_id IS NOT NULL BEGIN
  UPDATE tiers SET assignee_id=NULL WHERE app_id=OLD.app_id AND assignee_id=OLD.user_id;
END;
-- Invitations and team membership take precedence over reporter tiers.
CREATE TRIGGER clear_member_tier AFTER INSERT ON members BEGIN
  DELETE FROM tier_assignments WHERE app_id=NEW.app_id AND (actor_id=NEW.user_id OR pending_email=NEW.email);
END;
CREATE TRIGGER clear_joined_tier AFTER UPDATE OF user_id,email ON members BEGIN
  DELETE FROM tier_assignments WHERE app_id=NEW.app_id AND (actor_id=NEW.user_id OR pending_email=NEW.email);
END;
CREATE TRIGGER bind_email_tier AFTER INSERT ON users BEGIN
  INSERT OR IGNORE INTO tier_assignments(app_id,tier_id,actor_id)
    SELECT x.app_id,x.tier_id,NEW.id FROM tier_assignments x WHERE x.pending_email=NEW.email
    AND NOT EXISTS(SELECT 1 FROM members m WHERE m.app_id=x.app_id AND (m.user_id=NEW.id OR m.email=NEW.email));
  DELETE FROM tier_assignments WHERE pending_email=NEW.email;
END;

-- A later tier assignment must not retroactively restrict an existing issue. The opening
-- tier can veto public agent replies only while it is still the reporter's current tier.
ALTER TABLE issues ADD COLUMN reply_tier_id TEXT REFERENCES tiers(id) ON DELETE SET NULL;
CREATE INDEX issues_reply_tier ON issues(reply_tier_id) WHERE reply_tier_id IS NOT NULL;
CREATE TRIGGER tier_agent_reply BEFORE INSERT ON comments WHEN NEW.internal=0 AND json_extract(NEW.author,'$.type')='agent'
  AND EXISTS(SELECT 1 FROM issues i JOIN reporter_tiers t ON t.id=i.reply_tier_id AND t.app_id=i.app_id
    AND t.actor_id=json_extract(i.author,'$.id') WHERE i.id=NEW.issue_id AND t.agents_reply=0)
BEGIN SELECT RAISE(ABORT,'tier requires human reply'); END;

-- Kept apart from the public timeline: a pre-0012 reader must not see the rule
-- or its name during a rolling deploy. Actor and timestamp are the opening post's.
CREATE TABLE tier_issue_events (
  id TEXT PRIMARY KEY NOT NULL, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('labeled','assigned')), data TEXT NOT NULL
);
CREATE INDEX tier_events_issue ON tier_issue_events(issue_id,app_id);
