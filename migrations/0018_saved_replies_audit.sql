CREATE TABLE saved_replies(id TEXT PRIMARY KEY NOT NULL,app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 name TEXT NOT NULL COLLATE NOCASE,body TEXT NOT NULL,created_by TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(app_id,name));
CREATE TABLE audit_log(id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT,data TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE INDEX audit_app_page ON audit_log(app_id,created_at DESC,id DESC);
CREATE INDEX audit_actor_page ON audit_log(app_id,json_extract(actor,'$.id'),created_at DESC,id DESC);
CREATE INDEX audit_action_page ON audit_log(app_id,action,created_at DESC,id DESC);
CREATE INDEX audit_retention ON audit_log(created_at);
-- Before/after ACL snapshots are transaction-local in practice: inserted and cleared in
-- the same serialized D1 batch. Never infer actor identity from the last HTTP request.
CREATE TABLE audit_agent_scope(agent_id TEXT NOT NULL,app_id TEXT NOT NULL,role TEXT NOT NULL,override INTEGER NOT NULL,
 delegated_admin INTEGER NOT NULL,PRIMARY KEY(agent_id,app_id));
-- OAuth token revocation and refresh-token reuse revoke a grant without a browser actor.
-- Account-initiated revocations instead carry their authenticated operator's snapshot.
CREATE TRIGGER audit_oauth_revoke BEFORE UPDATE OF revoked_at ON agents WHEN OLD.kind='oauth' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM audit_agent_scope WHERE agent_id=OLD.id) BEGIN
 INSERT INTO audit_log(app_id,actor,action,target,data)
 SELECT m.app_id,json_object('type','agent','id',OLD.id,'name',OLD.name),'agent.revoked',json_object('type','agent','id',OLD.id),json_object('kind',OLD.kind)
 FROM members m LEFT JOIN agent_apps ga ON ga.app_id=m.app_id AND ga.agent_id=OLD.id WHERE m.user_id=OLD.user_id AND (CASE WHEN ga.agent_id IS NULL THEN OLD.all_workspaces ELSE ga.role END) IS NOT NULL;
END;
-- Previously assignee triage walked every issue of the workspace, even for a single handle.
CREATE INDEX issues_app_assignee_number ON issues(app_id,json_extract(assignee,'$.id'),number DESC);
