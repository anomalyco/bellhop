import { sql } from "../core"
import type { Scope } from "./access"

// A credential is the operator; a named member/contact is the author of the post.
// Fetch audit identity and recheck privileges in the actual D1 write transaction.
export function serverGuard(env: Env, s: Scope, condition = "1", args: unknown[] = []) {
  return sql(
    env,
    `INSERT INTO api_guard SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM api_keys k JOIN apps a ON a.id=k.app_id WHERE k.id=? AND k.app_id=? AND k.kind='secret' AND a.mode='helpdesk' AND (${condition}))`,
    s.key,
    s.app,
    ...args
  )
}
export function keyAudit(
  env: Env,
  app: string,
  key: string,
  action: string,
  type: string,
  id: string,
  data: Record<string, unknown> = {},
  bySubject = false
) {
  return sql(
    env,
    `INSERT INTO audit_log(app_id,actor,action,target,data) SELECT k.app_id,json_object('type','agent','id','api-key:'||k.id,'name',k.name,'preview',k.preview),?,json_object('type',?,'id',${bySubject ? "(SELECT id FROM contacts WHERE app_id=k.app_id AND external_id=?)" : "?"}),json_set(json(?),'$.api_key',json_object('id',k.id,'name',k.name,'preview',k.preview)) FROM api_keys k WHERE k.app_id=? AND k.id=? AND k.kind='secret'`,
    action,
    type,
    id,
    JSON.stringify(data),
    app,
    key
  )
}
