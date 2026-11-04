-- Token-endpoint revocations bypass the Worker audit helper. Keep the same
-- operator and workspace gates, and snapshot only the agent's display fields.
DROP TRIGGER audit_oauth_revoke;
CREATE TRIGGER audit_oauth_revoke BEFORE UPDATE OF revoked_at ON agents WHEN OLD.kind='oauth' AND OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM audit_agent_scope WHERE agent_id=OLD.id) BEGIN
 INSERT INTO audit_log(app_id,actor,action,target,data)
 SELECT m.app_id,json_object('type','agent','id',OLD.id,'name',OLD.name),'agent.revoked',json_object('type','agent','id',OLD.id,'name',OLD.name,'kind',OLD.kind),json_object('kind',OLD.kind)
 FROM members m LEFT JOIN agent_apps ga ON ga.app_id=m.app_id AND ga.agent_id=OLD.id WHERE m.user_id=OLD.user_id AND (CASE WHEN ga.agent_id IS NULL THEN OLD.all_workspaces ELSE ga.role END) IS NOT NULL;
END;
