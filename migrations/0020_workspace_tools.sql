ALTER TABLE apps ADD COLUMN nudge_days INTEGER CHECK(nudge_days BETWEEN 1 AND 30);
ALTER TABLE issues ADD COLUMN github_workspace TEXT;
ALTER TABLE issues ADD COLUMN github_repo TEXT;
ALTER TABLE issues ADD COLUMN github_number INTEGER;
CREATE UNIQUE INDEX github_issue_identity ON issues(github_workspace,github_repo,github_number) WHERE github_repo IS NOT NULL;
ALTER TABLE comments ADD COLUMN github_id INTEGER;
CREATE UNIQUE INDEX github_comment_identity ON comments(issue_id,github_id) WHERE github_id IS NOT NULL;

-- Only the admin importer sets these IDs. Historical posts must neither trip the
-- live posting quotas nor mail people who followed the issue between import runs.
DROP TRIGGER issues_rate_limit;
CREATE TRIGGER issues_rate_limit BEFORE INSERT ON issues WHEN NEW.github_repo IS NULL AND (SELECT count(*) FROM issues
  WHERE json_extract(author,'$.id')=json_extract(NEW.author,'$.id') AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))>=10
  BEGIN SELECT RAISE(ABORT,'rate limited'); END;
DROP TRIGGER comments_rate_limit;
CREATE TRIGGER comments_rate_limit BEFORE INSERT ON comments WHEN NEW.github_id IS NULL AND (SELECT count(*) FROM comments
  WHERE json_extract(author,'$.id')=json_extract(NEW.author,'$.id') AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))>=60
  BEGIN SELECT RAISE(ABORT,'rate limited'); END;
DROP TRIGGER mail_comment;
CREATE TRIGGER mail_comment AFTER INSERT ON comments WHEN NEW.github_id IS NULL BEGIN
 INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,user_id,address,state,reason) SELECT NEW.issue_id,u.id,u.id,u.email,'on','replied' FROM users u LEFT JOIN mail_settings p ON p.user_id=u.id WHERE u.id=json_extract(NEW.author,'$.id') AND coalesce(p.replied,1) AND NOT EXISTS(SELECT 1 FROM mail_suppressed WHERE address=u.email);
 INSERT INTO mail_signal(issue_id,kind,ref,actor) SELECT NEW.issue_id,'reply',NEW.id,json_extract(NEW.author,'$.id') WHERE NEW.internal=0;
 INSERT INTO mail_signal(issue_id,kind,ref,actor,target) SELECT NEW.issue_id,'mention',NEW.id,json_extract(NEW.author,'$.id'),json_extract(value,'$.actor.id') FROM json_each(NEW.mentions);
END;

CREATE TABLE github_jobs(id TEXT PRIMARY KEY,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,repo TEXT NOT NULL,
 filter TEXT NOT NULL,private_repo INTEGER NOT NULL,requester TEXT NOT NULL,actor TEXT NOT NULL,cipher TEXT,
 state TEXT NOT NULL DEFAULT 'queued',stage TEXT NOT NULL DEFAULT 'labels',page INTEGER NOT NULL DEFAULT 1,
 version INTEGER NOT NULL DEFAULT 0,issues INTEGER NOT NULL DEFAULT 0,comments INTEGER NOT NULL DEFAULT 0,labels INTEGER NOT NULL DEFAULT 0,
 due INTEGER NOT NULL DEFAULT 0,wake INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,error TEXT,
 created_at TEXT NOT NULL,finished_at TEXT,CHECK((state IN ('queued','running'))=(cipher IS NOT NULL)));
CREATE UNIQUE INDEX github_one_active ON github_jobs(app_id) WHERE cipher IS NOT NULL;
CREATE INDEX github_wake ON github_jobs(wake) WHERE cipher IS NOT NULL;
CREATE TABLE github_threads(job TEXT NOT NULL REFERENCES github_jobs(id) ON DELETE CASCADE,number INTEGER NOT NULL,
 issue TEXT NOT NULL,PRIMARY KEY(job,number));
-- A duplicate, delayed or concurrent worker must not apply any part of a stale page.
CREATE VIEW github_step AS SELECT id,version,0 admin_check FROM github_jobs;
CREATE TRIGGER github_check_step INSTEAD OF INSERT ON github_step WHEN NOT EXISTS
 (SELECT 1 FROM github_jobs WHERE id=NEW.id AND version=NEW.version AND cipher IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'stale github step'); END;
CREATE TRIGGER github_step_admin INSTEAD OF INSERT ON github_step WHEN NEW.admin_check=1 AND NOT EXISTS(
 SELECT 1 FROM github_jobs j JOIN members m ON m.app_id=j.app_id AND m.user_id=j.requester
 WHERE j.id=NEW.id AND m.role IN ('owner','admin')) BEGIN SELECT RAISE(ABORT,'github admin revoked'); END;

-- Remove the pending period on a public reporter response. Re-entry into waiting
-- starts a fresh period; ordinary edits do not. Historical sends are team-only,
-- even for older readers during rollout (never inserted into public issue_events).
CREATE TABLE waiting_periods(issue_id TEXT PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
 period TEXT NOT NULL UNIQUE DEFAULT(lower(hex(randomblob(16)))),started TEXT NOT NULL);
INSERT INTO waiting_periods(issue_id,started) SELECT id,since FROM (SELECT i.id,i.author,coalesce((SELECT max(e.created_at) FROM issue_events e
 WHERE e.issue_id=i.id AND e.type='status_changed' AND json_extract(e.data,'$.to')='waiting' AND json_extract(e.data,'$.from')!='waiting'),i.updated_at) since FROM issues i WHERE i.status='waiting') w
 WHERE NOT EXISTS(SELECT 1 FROM comments c WHERE c.issue_id=w.id AND c.internal=0 AND c.created_at>=w.since AND json_extract(c.author,'$.id')=json_extract(w.author,'$.id'));
CREATE TRIGGER waiting_open AFTER INSERT ON issues WHEN NEW.status='waiting' BEGIN INSERT INTO waiting_periods(issue_id,started) VALUES(NEW.id,NEW.created_at); END;
CREATE TRIGGER waiting_change AFTER UPDATE OF status,app_id ON issues WHEN OLD.status!=NEW.status OR OLD.app_id!=NEW.app_id BEGIN
 DELETE FROM waiting_periods WHERE issue_id=NEW.id;
 INSERT INTO waiting_periods(issue_id,started) SELECT NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NEW.status='waiting'; END;
CREATE TRIGGER waiting_answer AFTER INSERT ON comments WHEN NEW.internal=0 AND EXISTS(SELECT 1 FROM waiting_periods w JOIN issues i ON i.id=w.issue_id
 WHERE w.issue_id=NEW.issue_id AND NEW.created_at>=w.started AND json_extract(NEW.author,'$.id')=json_extract(i.author,'$.id')) BEGIN DELETE FROM waiting_periods WHERE issue_id=NEW.issue_id; END;
CREATE TABLE nudge_events(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,created_at TEXT NOT NULL);
CREATE INDEX nudges_issue ON nudge_events(issue_id,created_at);
CREATE INDEX apps_nudges_enabled ON apps(id) WHERE nudge_days IS NOT NULL;
CREATE VIEW due_nudges AS SELECT w.period,w.issue_id,p.id sub,p.address FROM apps a CROSS JOIN issues i ON i.app_id=a.id
 CROSS JOIN waiting_periods w ON w.issue_id=i.id CROSS JOIN mail_people p ON p.issue_id=i.id WHERE i.status='waiting' AND i.hidden IS NULL AND a.nudge_days IS NOT NULL
 AND unixepoch(w.started)+a.nudge_days*86400<=unixepoch() AND p.state='on' AND (p.actor_id=json_extract(i.author,'$.id') OR p.owner_alias=json_extract(i.author,'$.id'))
 AND (p.reason='manual' OR (p.reason='opened' AND p.opened) OR (p.reason='replied' AND p.replied) OR (p.reason='mentioned' AND p.mentions) OR (p.reason='assigned' AND p.assigned)) AND NOT EXISTS(SELECT 1 FROM nudge_events n WHERE n.id=w.period);
