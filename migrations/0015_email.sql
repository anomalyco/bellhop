ALTER TABLE comments ADD COLUMN via TEXT NOT NULL DEFAULT 'web' CHECK(via IN ('web','email','mcp'));
UPDATE comments SET via='mcp' WHERE json_extract(author,'$.type')='agent';
-- Old writers during a rolling deploy omit via.
CREATE TRIGGER mail_agent_via AFTER INSERT ON comments WHEN NEW.via='web' AND json_extract(NEW.author,'$.type')='agent' BEGIN
  UPDATE comments SET via='mcp' WHERE id=NEW.id;
END;

CREATE TABLE mail_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, opened INTEGER NOT NULL DEFAULT 1,
 replied INTEGER NOT NULL DEFAULT 1, mentions INTEGER NOT NULL DEFAULT 1, assigned INTEGER NOT NULL DEFAULT 1);
CREATE TABLE mail_suppressed(address TEXT PRIMARY KEY COLLATE NOCASE, reason TEXT NOT NULL);
CREATE TABLE mail_subs(id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(12)))), nonce TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
 issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE, actor_id TEXT NOT NULL, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
 guest_hash TEXT, address TEXT NOT NULL COLLATE NOCASE, state TEXT NOT NULL CHECK(state IN ('on','off','pending')), reason TEXT NOT NULL,
 requested INTEGER NOT NULL DEFAULT 0, UNIQUE(issue_id,actor_id));
CREATE INDEX mail_address ON mail_subs(address);
CREATE INDEX mail_guest_actor ON mail_subs(actor_id) WHERE user_id IS NULL;
CREATE VIEW mail_people AS SELECT s.*,i.app_id,i.number,i.title,i.private,i.hidden,m.role,ga.actor_id owner_alias,
 coalesce(p.opened,1) opened,coalesce(p.replied,1) replied,coalesce(p.mentions,1) mentions,coalesce(p.assigned,1) assigned
 FROM mail_subs s JOIN issues i ON i.id=s.issue_id LEFT JOIN users u ON u.id=s.user_id
 LEFT JOIN guest_report_authors ga ON ga.actor_id=json_extract(i.author,'$.id') AND ga.guest_hash=s.guest_hash AND s.user_id IS NULL
 LEFT JOIN members m ON m.app_id=i.app_id AND m.user_id=s.user_id LEFT JOIN mail_settings p ON p.user_id=s.user_id
 WHERE (s.user_id IS NULL OR u.email=s.address) AND NOT EXISTS(SELECT 1 FROM mail_suppressed x WHERE x.address=s.address)
 AND (m.role IS NOT NULL OR (i.hidden IS NULL AND (i.private=0 OR json_extract(i.author,'$.id')=s.actor_id OR ga.actor_id IS NOT NULL)))
 AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.app_id=i.app_id AND (b.actor_id=s.actor_id OR b.actor_id=ga.actor_id OR b.actor_id=(SELECT id FROM users WHERE email=s.address)));
CREATE TRIGGER mail_transfer AFTER UPDATE OF app_id ON issues WHEN OLD.app_id!=NEW.app_id BEGIN DELETE FROM mail_subs WHERE issue_id=NEW.id; END;
-- A mute survives future comments. Deleting a subscription revokes its tokens and work.
CREATE TABLE mail_batches(id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),sub_id TEXT NOT NULL REFERENCES mail_subs(id) ON DELETE CASCADE,
 issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,address TEXT NOT NULL COLLATE NOCASE,
 due INTEGER NOT NULL DEFAULT (unixepoch()+180), sealed INTEGER NOT NULL DEFAULT 0, wake INTEGER NOT NULL DEFAULT 0,lease INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX mail_open_batch ON mail_batches(issue_id,address) WHERE sealed=0;
CREATE INDEX mail_batches_sub ON mail_batches(sub_id);
CREATE INDEX mail_wake ON mail_batches(wake);
CREATE TABLE mail_items(id INTEGER PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES mail_batches(id) ON DELETE CASCADE,kind TEXT NOT NULL,ref TEXT NOT NULL,actor TEXT NOT NULL, UNIQUE(batch_id,kind,ref));
CREATE TRIGGER mail_cancel AFTER UPDATE OF state,address,nonce ON mail_subs BEGIN DELETE FROM mail_batches WHERE sub_id=NEW.id; END;
CREATE TRIGGER mail_disable AFTER INSERT ON mail_suppressed BEGIN UPDATE mail_subs SET state='off',nonce=lower(hex(randomblob(16))) WHERE address=NEW.address; END;
CREATE TRIGGER mail_unsubscribe_settings AFTER INSERT ON mail_suppressed WHEN NEW.reason='unsubscribe' BEGIN
 INSERT INTO mail_settings(user_id,opened,replied,mentions,assigned) SELECT id,0,0,0,0 FROM users WHERE email=NEW.address
 ON CONFLICT(user_id) DO UPDATE SET opened=0,replied=0,mentions=0,assigned=0;
END;
CREATE TABLE mail_sent(provider_id TEXT PRIMARY KEY,address TEXT NOT NULL COLLATE NOCASE);
CREATE TABLE mail_feedback(email_id TEXT PRIMARY KEY, reason TEXT NOT NULL, at INTEGER NOT NULL DEFAULT (unixepoch()));
CREATE TRIGGER mail_feedback_arrives AFTER INSERT ON mail_feedback BEGIN
 INSERT INTO mail_suppressed SELECT address,NEW.reason FROM mail_sent WHERE provider_id=NEW.email_id ON CONFLICT(address) DO UPDATE SET reason=excluded.reason;
END;
CREATE TRIGGER mail_receipt_arrives AFTER INSERT ON mail_sent BEGIN
 INSERT INTO mail_suppressed SELECT NEW.address,reason FROM mail_feedback WHERE email_id=NEW.provider_id ON CONFLICT(address) DO UPDATE SET reason=excluded.reason;
END;
CREATE TABLE mail_cursor(id INTEGER PRIMARY KEY CHECK(id=1), cursor TEXT NOT NULL);
INSERT INTO mail_cursor VALUES(1,'0');
CREATE TABLE mail_inbound(id TEXT PRIMARY KEY,sub_id TEXT NOT NULL);
CREATE TABLE mail_hook_seen(channel TEXT NOT NULL,id TEXT NOT NULL,at INTEGER NOT NULL DEFAULT(unixepoch()),PRIMARY KEY(channel,id));
CREATE TABLE mail_feedback_cursor(status TEXT PRIMARY KEY,cursor TEXT);
INSERT INTO mail_feedback_cursor VALUES('bounced',NULL),('complained',NULL);

-- Transient signal: resolve the audience in the same D1 transaction as the mutation.
-- Only references enter the outbox, never a snapshot of a private title or a note body.
CREATE TABLE mail_signal(id INTEGER PRIMARY KEY,issue_id TEXT NOT NULL,kind TEXT NOT NULL,ref TEXT NOT NULL,actor TEXT NOT NULL,target TEXT);
CREATE VIEW mail_audience AS SELECT signal,sub FROM (SELECT g.id signal,p.id sub,row_number() OVER(PARTITION BY g.id,p.address ORDER BY p.user_id IS NULL,p.id) pick FROM mail_signal g JOIN mail_people p ON p.issue_id=g.issue_id
 WHERE p.state='on' AND p.actor_id!=g.actor AND NOT EXISTS(SELECT 1 FROM users sender WHERE sender.id=g.actor AND sender.email=p.address)
 AND NOT EXISTS(SELECT 1 FROM mail_subs sender WHERE sender.issue_id=g.issue_id AND sender.actor_id=g.actor AND sender.state='on' AND sender.address=p.address)
 AND ((p.role IS NULL AND g.target IS NULL AND NOT EXISTS(SELECT 1 FROM members m WHERE m.app_id=p.app_id AND m.email=p.address AND m.user_id IS NOT NULL) AND ((p.reason='opened' AND p.opened) OR (p.reason='replied' AND p.replied) OR p.reason='manual'))
 OR (p.role IS NOT NULL AND g.target=p.actor_id AND ((g.kind='mention' AND p.mentions) OR (g.kind='assigned' AND p.assigned))))) WHERE pick=1;
CREATE TRIGGER mail_dispatch AFTER INSERT ON mail_signal BEGIN
 INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,user_id,address,state,reason)
 SELECT NEW.issue_id,u.id,u.id,u.email,'on',CASE NEW.kind WHEN 'mention' THEN 'mentioned' ELSE 'assigned' END
 FROM users u JOIN members m ON m.user_id=u.id JOIN issues i ON i.app_id=m.app_id AND i.id=NEW.issue_id
 LEFT JOIN mail_settings pref ON pref.user_id=u.id WHERE u.id=NEW.target AND u.id!=NEW.actor AND CASE NEW.kind WHEN 'mention' THEN coalesce(pref.mentions,1) ELSE coalesce(pref.assigned,1) END AND NOT EXISTS(SELECT 1 FROM mail_suppressed x WHERE x.address=u.email);
 INSERT INTO mail_batches(sub_id,issue_id,address) SELECT s.id,s.issue_id,s.address FROM mail_audience a JOIN mail_subs s ON s.id=a.sub WHERE signal=NEW.id
 ON CONFLICT(issue_id,address) WHERE sealed=0 DO UPDATE SET sub_id=excluded.sub_id;
 INSERT OR IGNORE INTO mail_items(batch_id,kind,ref,actor) SELECT b.id,NEW.kind,NEW.ref,NEW.actor FROM mail_audience a JOIN mail_batches b ON b.sub_id=a.sub AND b.sealed=0 WHERE a.signal=NEW.id;
 DELETE FROM mail_signal WHERE id=NEW.id;
END;
CREATE TRIGGER mail_open AFTER INSERT ON issues BEGIN
 INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,user_id,address,state,reason) SELECT NEW.id,u.id,u.id,u.email,'on','opened' FROM users u LEFT JOIN mail_settings p ON p.user_id=u.id WHERE u.id=json_extract(NEW.author,'$.id') AND coalesce(p.opened,1) AND NOT EXISTS(SELECT 1 FROM mail_suppressed WHERE address=u.email);
 INSERT INTO mail_signal(issue_id,kind,ref,actor,target) SELECT NEW.id,'mention',NEW.id,json_extract(NEW.author,'$.id'),json_extract(value,'$.actor.id') FROM json_each(NEW.mentions);
END;
CREATE TRIGGER mail_comment AFTER INSERT ON comments BEGIN
 INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,user_id,address,state,reason) SELECT NEW.issue_id,u.id,u.id,u.email,'on','replied' FROM users u LEFT JOIN mail_settings p ON p.user_id=u.id WHERE u.id=json_extract(NEW.author,'$.id') AND coalesce(p.replied,1) AND NOT EXISTS(SELECT 1 FROM mail_suppressed WHERE address=u.email);
 INSERT INTO mail_signal(issue_id,kind,ref,actor) SELECT NEW.issue_id,'reply',NEW.id,json_extract(NEW.author,'$.id') WHERE NEW.internal=0;
 INSERT INTO mail_signal(issue_id,kind,ref,actor,target) SELECT NEW.issue_id,'mention',NEW.id,json_extract(NEW.author,'$.id'),json_extract(value,'$.actor.id') FROM json_each(NEW.mentions);
END;
CREATE TRIGGER mail_comment_mentions AFTER UPDATE OF mentions ON comments BEGIN
 INSERT INTO mail_signal(issue_id,kind,ref,actor,target) SELECT NEW.issue_id,'mention',NEW.id,json_extract(NEW.author,'$.id'),json_extract(value,'$.actor.id') FROM json_each(NEW.mentions) WHERE json_extract(value,'$.actor.id') NOT IN(SELECT json_extract(value,'$.actor.id') FROM json_each(OLD.mentions));
END;
CREATE TRIGGER mail_issue_event AFTER INSERT ON issue_events WHEN NEW.type IN ('status_changed','assigned','claimed') BEGIN
 INSERT INTO mail_signal(issue_id,kind,ref,actor,target) SELECT NEW.issue_id,'status',NEW.id,json_extract(NEW.actor,'$.id'),NULL WHERE NEW.type='status_changed';
 INSERT INTO mail_signal(issue_id,kind,ref,actor,target) SELECT NEW.issue_id,'assigned',NEW.id,json_extract(NEW.actor,'$.id'),json_extract(NEW.data,'$.assignee.id') WHERE NEW.type='assigned' AND json_extract(NEW.data,'$.assignee.id') IS NOT NULL;
END;
CREATE TRIGGER mail_rule_assignee AFTER INSERT ON tier_issue_events WHEN NEW.type='assigned' BEGIN
 INSERT INTO mail_signal(issue_id,kind,ref,actor,target) SELECT i.id,'assigned',NEW.id,json_extract(i.author,'$.id'),json_extract(NEW.data,'$.assignee.id') FROM issues i WHERE i.id=NEW.issue_id;
END;
INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,user_id,address,state,reason) SELECT i.id,u.id,u.id,u.email,'on','opened' FROM issues i JOIN users u ON u.id=json_extract(i.author,'$.id');
INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,user_id,address,state,reason) SELECT c.issue_id,u.id,u.id,u.email,'on','replied' FROM comments c JOIN users u ON u.id=json_extract(c.author,'$.id');
