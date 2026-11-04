ALTER TABLE comments ADD COLUMN sent_by TEXT;
ALTER TABLE mail_settings ADD COLUMN approvals INTEGER CHECK(approvals IN (0,1));

CREATE VIEW suggest_issues AS SELECT i.id,i.app_id FROM issues i JOIN apps a ON a.id=i.app_id
 LEFT JOIN request_answers b ON b.issue_id=i.id AND b.app_id=i.app_id LEFT JOIN request_types t ON t.id=b.type_id AND t.app_id=i.app_id
 WHERE a.mode='helpdesk' AND coalesce(t.autonomy,a.default_autonomy)='suggest';
-- Applies to old writers too, and closes the race between reading the mode and inserting a reply.
CREATE TRIGGER agent_reply_review BEFORE INSERT ON comments WHEN NEW.internal=0 AND NEW.github_id IS NULL AND NEW.sent_by IS NULL
 AND json_extract(NEW.author,'$.type')='agent' AND EXISTS(SELECT 1 FROM suggest_issues WHERE id=NEW.issue_id)
 BEGIN SELECT RAISE(ABORT,'public reply requires review'); END;
CREATE TABLE held_replies(id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 author TEXT NOT NULL, body TEXT NOT NULL, mentions TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX held_issue ON held_replies(issue_id,created_at);
CREATE INDEX held_author ON held_replies(json_extract(author,'$.id'),created_at);
CREATE TRIGGER held_limit BEFORE INSERT ON held_replies WHEN (SELECT count(*) FROM held_replies WHERE json_extract(author,'$.id')=json_extract(NEW.author,'$.id') AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour'))>=60
 BEGIN SELECT RAISE(ABORT,'rate limited'); END;
-- Never put pre-publication text in public edit history (including for older readers).
CREATE TABLE held_edits(comment_id TEXT PRIMARY KEY REFERENCES comments(id) ON DELETE CASCADE,body TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE VIEW team_comments AS SELECT id,issue_id,author,body,mentions,created_at,updated_at,hidden,edited_at,internal,via,sent_by,NULL held_at FROM comments
 UNION ALL SELECT h.id,h.issue_id,h.author,h.body,h.mentions,h.created_at,h.created_at,NULL,NULL,0,'mcp',NULL,h.created_at FROM held_replies h JOIN issues i ON i.id=h.issue_id JOIN apps a ON a.id=i.app_id AND a.mode='helpdesk';

CREATE TABLE approval_keys(app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,kid TEXT NOT NULL UNIQUE,x TEXT NOT NULL,cipher TEXT NOT NULL);
CREATE TABLE approvals(id TEXT PRIMARY KEY,issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 action TEXT NOT NULL,summary TEXT NOT NULL,details TEXT NOT NULL,requested_by TEXT NOT NULL,created_at TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','approved','rejected','used')),decided_by TEXT,decided_at TEXT,note TEXT,expires INTEGER NOT NULL);
CREATE INDEX approvals_issue ON approvals(issue_id,state,expires);
CREATE VIEW approval_docs AS SELECT p.id,p.issue_id,i.app_id,p.created_at,p.decided_at,p.decided_by,p.requested_by,
 json_object('id',p.id,'issue_number',i.number,'action',p.action,'summary',p.summary,'details',json(p.details),
 'state',CASE WHEN p.state IN ('pending','approved') AND p.expires<=unixepoch() THEN 'expired' ELSE p.state END,
 'requested_by',json(p.requested_by),'decided_by',json(p.decided_by),'decided_at',p.decided_at,'note',p.note,
 'expires_at',strftime('%Y-%m-%dT%H:%M:%fZ',p.expires,'unixepoch'),'created_at',p.created_at) doc
 FROM approvals p JOIN issues i ON i.id=p.issue_id JOIN apps a ON a.id=i.app_id AND a.mode='helpdesk';
CREATE VIEW approval_events AS SELECT id,issue_id,'approval.requested' type,requested_by actor,json_object('approval',json(doc)) data,created_at FROM approval_docs
 UNION ALL SELECT id||'-decision',issue_id,'approval.decided',decided_by,json_object('approval',json(doc)),decided_at FROM approval_docs WHERE decided_at IS NOT NULL;
DROP VIEW api_workspace_items;
CREATE VIEW api_review_items(issue_id,id,created_at,actor,type,body,edited_at,data,internal,hidden) AS
 SELECT issue_id,id,created_at,author,'held',body,NULL,NULL,0,0 FROM team_comments WHERE held_at IS NOT NULL
 UNION ALL SELECT issue_id,id,created_at,actor,type,NULL,NULL,data,1,0 FROM approval_events;
CREATE VIEW api_workspace_items AS SELECT *,0 internal,0 hidden FROM api_items
 UNION ALL SELECT id,id,created_at,author,'message',body,edited_at,NULL,0,1 FROM issues WHERE hidden IS NOT NULL
 UNION ALL SELECT issue_id,id,created_at,author,'message',body,edited_at,NULL,internal,hidden IS NOT NULL FROM comments WHERE internal=1 OR hidden IS NOT NULL
 UNION ALL SELECT * FROM api_workspace_events
 UNION ALL SELECT * FROM api_review_items;

-- Queue references, never email addresses or draft contents. Recheck role/preferences at delivery.
CREATE TABLE review_mail(id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,ref TEXT NOT NULL,kind TEXT NOT NULL,wake INTEGER NOT NULL DEFAULT 0,UNIQUE(ref,user_id));
CREATE INDEX review_mail_due ON review_mail(wake);
CREATE VIEW review_recipients AS SELECT i.id issue_id,u.id user_id,u.email FROM issues i JOIN apps a ON a.id=i.app_id AND a.mode='helpdesk'
 JOIN members m ON m.app_id=i.app_id JOIN users u ON u.id=m.user_id LEFT JOIN mail_settings p ON p.user_id=u.id
 WHERE coalesce(p.approvals,m.role IN ('owner','admin') OR coalesce(json_extract(i.assignee,'$.id')=m.user_id,0))
 AND NOT EXISTS(SELECT 1 FROM mail_suppressed x WHERE x.address=u.email);
CREATE TRIGGER held_notice AFTER INSERT ON held_replies BEGIN INSERT INTO review_mail(issue_id,user_id,ref,kind) SELECT issue_id,user_id,NEW.id,'held' FROM review_recipients WHERE issue_id=NEW.issue_id; END;
CREATE TRIGGER approval_notice AFTER INSERT ON approvals BEGIN INSERT INTO review_mail(issue_id,user_id,ref,kind) SELECT issue_id,user_id,NEW.id,'approval' FROM review_recipients WHERE issue_id=NEW.issue_id; END;
CREATE TRIGGER held_cleanup AFTER DELETE ON held_replies BEGIN DELETE FROM review_mail WHERE ref=OLD.id; END;
CREATE TRIGGER approval_cleanup AFTER UPDATE OF state ON approvals BEGIN DELETE FROM review_mail WHERE ref=NEW.id; END;
CREATE TRIGGER review_transfer AFTER UPDATE OF app_id ON issues WHEN NEW.app_id!=OLD.app_id BEGIN
 DELETE FROM held_replies WHERE issue_id=NEW.id; DELETE FROM approvals WHERE issue_id=NEW.id; DELETE FROM review_mail WHERE issue_id=NEW.id;
 DELETE FROM held_edits WHERE comment_id IN(SELECT id FROM comments WHERE issue_id=NEW.id); END;
CREATE TRIGGER review_erasure BEFORE DELETE ON contacts BEGIN
 DELETE FROM held_replies WHERE issue_id IN(SELECT id FROM issues WHERE app_id=OLD.app_id AND json_extract(author,'$.id')=OLD.id);
 DELETE FROM review_mail WHERE issue_id IN(SELECT id FROM issues WHERE app_id=OLD.app_id AND json_extract(author,'$.id')=OLD.id);
 DELETE FROM approvals WHERE issue_id IN(SELECT id FROM issues WHERE app_id=OLD.app_id AND json_extract(author,'$.id')=OLD.id);
 DELETE FROM held_edits WHERE comment_id IN(SELECT c.id FROM comments c JOIN issues i ON i.id=c.issue_id WHERE i.app_id=OLD.app_id AND json_extract(i.author,'$.id')=OLD.id); END;
ALTER TABLE held_replies ADD COLUMN metadata_id TEXT;
