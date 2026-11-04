ALTER TABLE comments ADD COLUMN internal INTEGER NOT NULL DEFAULT 0 CHECK(internal IN (0,1));
ALTER TABLE comments ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE issues ADD COLUMN mentions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE issues ADD COLUMN locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0,1));
ALTER TABLE issues ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1));
CREATE INDEX issue_pins ON issues(app_id,number DESC) WHERE pinned=1;
CREATE TRIGGER limit_issue_pins BEFORE UPDATE OF pinned,app_id ON issues WHEN NEW.pinned=1 AND
  (SELECT count(*) FROM issues WHERE app_id=NEW.app_id AND pinned=1 AND id!=NEW.id)>=3
BEGIN SELECT RAISE(ABORT,'workspace pin limit'); END;
CREATE TABLE issue_votes (issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,voter TEXT NOT NULL,PRIMARY KEY(issue_id,voter));
CREATE TABLE comment_helpful (comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,voter TEXT NOT NULL,PRIMARY KEY(comment_id,voter));
CREATE INDEX votes_by_voter ON issue_votes(voter);
CREATE INDEX helpful_by_voter ON comment_helpful(voter);
CREATE TABLE mention_handles (app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,actor_id TEXT NOT NULL,handle TEXT NOT NULL,
  PRIMARY KEY(app_id,actor_id),UNIQUE(app_id,handle));
CREATE TABLE issue_moves (from_app TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,from_number INTEGER NOT NULL,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,PRIMARY KEY(from_app,from_number));
CREATE INDEX moves_issue ON issue_moves(issue_id,from_app);
-- Apply lock/note policy at commit as well as at the HTTP boundary (including a concurrent lock).
CREATE TRIGGER locked_issue_comment BEFORE INSERT ON comments WHEN EXISTS(SELECT 1 FROM issues i WHERE i.id=NEW.issue_id AND i.locked=1
 AND json_extract(NEW.author,'$.type')!='agent' AND NOT EXISTS(SELECT 1 FROM members WHERE app_id=i.app_id AND user_id=json_extract(NEW.author,'$.id')))
BEGIN SELECT RAISE(ABORT,'issue is locked'); END;
CREATE TRIGGER internal_note_permission BEFORE INSERT ON comments WHEN NEW.internal=1 AND json_extract(NEW.author,'$.type')!='agent'
 AND NOT EXISTS(SELECT 1 FROM issues i JOIN members m ON m.app_id=i.app_id WHERE i.id=NEW.issue_id AND m.user_id=json_extract(NEW.author,'$.id'))
BEGIN SELECT RAISE(ABORT,'internal notes require team'); END;
CREATE TRIGGER preserve_moved_numbers BEFORE DELETE ON issues BEGIN
 INSERT OR IGNORE INTO issue_tombstones SELECT from_app,from_number FROM issue_moves WHERE issue_id=OLD.id;
END;
-- Resolve a browser's original per-workspace guest identities without walking the target's
-- entire issue history on every read. The old addresses always follow the latest transfer.
ALTER TABLE issue_moves ADD COLUMN current_app TEXT REFERENCES apps(id) ON DELETE CASCADE;
UPDATE issue_moves SET current_app=(SELECT app_id FROM issues WHERE id=issue_id);
CREATE INDEX moves_current_sources ON issue_moves(current_app,from_app);
CREATE TRIGGER update_move_scope AFTER UPDATE OF app_id ON issues BEGIN
 UPDATE issue_moves SET current_app=NEW.app_id WHERE issue_id=NEW.id;
END;
CREATE TRIGGER reserved_move_insert BEFORE INSERT ON issues WHEN EXISTS(SELECT 1 FROM issue_moves WHERE from_app=NEW.app_id AND from_number=NEW.number)
BEGIN SELECT RAISE(ABORT,'moved issue number is reserved'); END;
CREATE TRIGGER reserved_move_update BEFORE UPDATE OF app_id,number ON issues WHEN EXISTS(SELECT 1 FROM issue_moves WHERE from_app=NEW.app_id AND from_number=NEW.number)
BEGIN SELECT RAISE(ABORT,'moved issue number is reserved'); END;
CREATE TRIGGER limit_new_issue_pins BEFORE INSERT ON issues WHEN NEW.pinned=1 AND
  (SELECT count(*) FROM issues WHERE app_id=NEW.app_id AND pinned=1)>=3
BEGIN SELECT RAISE(ABORT,'workspace pin limit'); END;

-- B3a writers ignore the internal input field. During a rolling upgrade reject their
-- comment inserts instead of silently turning a requested note into a public reply.
ALTER TABLE comments ADD COLUMN writer_version INTEGER NOT NULL DEFAULT 0;
CREATE TRIGGER require_conversation_writer BEFORE INSERT ON comments WHEN NEW.writer_version!=1
BEGIN SELECT RAISE(ABORT,'outdated comment writer'); END;
-- Enable only after ALL API readers and Room classes are B3b. Older readers cannot safely
-- read the comments table once internal notes exist. Do not roll those readers back.
CREATE TABLE conversation_release (id INTEGER PRIMARY KEY CHECK(id=1), notes_ready INTEGER NOT NULL CHECK(notes_ready IN (0,1)));
INSERT INTO conversation_release VALUES(1,0);
CREATE TRIGGER gate_internal_notes BEFORE INSERT ON comments WHEN NEW.internal=1 AND NOT EXISTS
 (SELECT 1 FROM conversation_release WHERE id=1 AND notes_ready=1)
BEGIN SELECT RAISE(ABORT,'internal notes not enabled'); END;
