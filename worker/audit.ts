import type { Actor, AuditEntry, AuditPage } from "../shared/api"
import { bad, now, sql, str } from "./core"
import { agentAccessSQL } from "./permissions"

// Only explicit target/data fields belong here. Never serialize a request, webhook URL,
// credential, message body, or whole model into the log. Keep the historical actor name.
export function auditActor(a: Actor) {
  return JSON.stringify(
    a.type === "agent"
      ? { type: a.type, id: a.id, name: a.name }
      : a.type === "member"
        ? { type: a.type, id: a.id, name: a.name, avatar_url: null }
        : { type: a.type, id: a.id, name: a.name, handle: a.handle }
  )
}
export function entry(
  env: Env,
  app: string,
  actor: Actor,
  action: string,
  target: Record<string, unknown>,
  data: Record<string, unknown> = {},
  condition = "changes()>0",
  args: unknown[] = []
) {
  return sql(
    env,
    `INSERT INTO audit_log(app_id,actor,action,target,data) SELECT ?,?,?,?,? WHERE ${condition}`,
    app,
    auditActor(actor),
    action,
    JSON.stringify(target),
    JSON.stringify(data),
    ...args
  )
}
export async function recorded<T = unknown>(
  env: Env,
  write: D1PreparedStatement,
  app: string,
  actor: Actor,
  action: string,
  target: Record<string, unknown>,
  data?: Record<string, unknown>
) {
  const [r] = await env.DB.batch<T>([write, entry(env, app, actor, action, target, data)])
  return r!
}
// Grants can span several workspaces. Log only scopes the agent actually gained, had,
// or lost. A workspace admin never learns the other workspaces selected by the owner.
export async function agentBatch(
  env: Env,
  actor: Actor,
  id: string,
  scope: { user?: string; app?: string },
  action: string,
  writes: D1PreparedStatement[]
) {
  const acl = `SELECT agent_id,app_id,role,override,coalesce(delegated_admin,0) delegated_admin FROM (${agentAccessSQL}) WHERE agent_id=? AND role IS NOT NULL AND ${scope.user ? "user_id" : "app_id"}=? ${action === "agent.rotated" ? "AND EXISTS(SELECT 1 FROM agents WHERE id=agent_id AND kind='token')" : ""}`,
    key = scope.user ?? scope.app!,
    previous = sql(env, `INSERT INTO audit_agent_scope ${acl}`, id, key)
  const result = await env.DB.batch([
    previous,
    ...writes,
    sql(
      env,
      `WITH cur AS MATERIALIZED (${acl}), prev AS (SELECT * FROM audit_agent_scope WHERE agent_id=?),
    apps AS (SELECT app_id FROM prev UNION SELECT app_id FROM cur), delta AS (SELECT a.app_id,p.role old,c.role new,p.override IS NOT c.override OR p.delegated_admin IS NOT c.delegated_admin OR p.role IS NOT c.role changed FROM apps a LEFT JOIN prev p USING(app_id) LEFT JOIN cur c USING(app_id))
    INSERT INTO audit_log(app_id,actor,action,target,data) SELECT app_id,?,CASE WHEN ?='agent.updated' AND changed THEN 'agent.access_changed' ELSE ? END,json_object('type','agent','id',?),json_object('from',old,'to',new) FROM delta WHERE ?!='agent.access_changed' OR changed`,
      id,
      key,
      id,
      auditActor(actor),
      action,
      action,
      id,
      action
    ),
    sql(env, "DELETE FROM audit_agent_scope WHERE agent_id=?", id)
  ])
  return result.slice(1, 1 + writes.length)
}
export async function auditPage(
  env: Env,
  app: string,
  opts: { actor?: string; action?: string; cursor?: string }
): Promise<AuditPage> {
  const where = ["app_id=?", "created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')"],
    args: unknown[] = [app]
  if (opts.actor) {
    where.push("json_extract(actor,'$.id')=?")
    args.push(str(opts.actor, "actor id", 80))
  }
  if (opts.action) {
    where.push("action=?")
    args.push(str(opts.action, "action", 80))
  }
  if (opts.cursor !== undefined) {
    const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)~([0-9a-f]{32})$/.exec(opts.cursor)
    if (!m) bad("Invalid audit cursor")
    where.push("(created_at,id)<(?,?)")
    args.push(m[1], m[2])
  }
  const rs = await sql(
    env,
    `SELECT id,actor,action,target,data,created_at FROM audit_log WHERE ${where.join(" AND ")} ORDER BY created_at DESC,id DESC LIMIT 51`,
    ...args
  ).all<Omit<AuditEntry, "actor" | "data" | "target"> & { actor: string; target: string | null; data: string }>()
  const entries = rs.results
      .slice(0, 50)
      .map((r) => ({
        ...r,
        actor: JSON.parse(r.actor),
        data: JSON.parse(r.data),
        target: r.target && JSON.parse(r.target)
      })),
    last = entries.at(-1)
  return { entries, next_cursor: rs.results.length > 50 ? `${last!.created_at}~${last!.id}` : null }
}
export const pruneAudit = (env: Env) =>
  sql(env, "DELETE FROM audit_log WHERE created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')").run()
