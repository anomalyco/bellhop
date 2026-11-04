import type { Member, Role } from "../shared/api"
import { bad, denied, email, missing, rows, sql, uid } from "./core"
import { agentAccessSQL, can } from "./permissions"

export async function roster(env: Env, app: string): Promise<Member[]> {
  const members = await rows<Omit<Member, "joined"> & { joined: number }>(
    sql(
      env,
      `SELECT coalesce(m.user_id,m.id) id,m.email,u.name,u.avatar_url,m.role,m.user_id IS NOT NULL joined FROM members m
     LEFT JOIN users u ON u.id=m.user_id WHERE m.app_id=?1
     UNION ALL SELECT id,email,NULL,NULL,role,0 FROM workspace_invitations WHERE app_id=?1 ORDER BY role DESC,email`,
      app
    )
  )
  return members.map((m) => ({ ...m, joined: !!m.joined }))
}
export type Manager = { user: string; agent?: string }
// Recheck the caller inside sensitive writes, not only when the request was authenticated.
function gate(app: string, manager: Manager, elevated: boolean): [string, string[]] {
  const where = elevated ? "p.role='owner'" : "p.role IN ('admin','owner')"
  if (!manager.agent)
    return [`EXISTS(SELECT 1 FROM members p WHERE p.app_id=? AND p.user_id=? AND ${where})`, [app, manager.user]]
  return [
    `EXISTS(SELECT 1 FROM (${agentAccessSQL}) acl WHERE app_id=? AND user_id=? AND agent_id=? AND role='admin'
    ${elevated ? "AND team='owner' AND delegated_admin=1" : ""})`,
    [app, manager.user, manager.agent]
  ]
}
export async function invite(env: Env, app: string, manager: Manager, address: unknown, role: Role) {
  const e = email(address),
    [allowed, args] = gate(app, manager, can(role, "setup"))
  const r = await sql(
    env,
    `INSERT INTO workspace_invitations(id,app_id,email,role,invited_by) SELECT ?,?,?,?,${manager.agent ? "(SELECT json_object('name',name,'avatar_url',NULL) FROM agents WHERE id=?)" : "(SELECT json_object('name',name,'avatar_url',avatar_url) FROM users WHERE id=?)"}
     WHERE NOT EXISTS(SELECT 1 FROM members WHERE app_id=? AND email=?) AND ${allowed}`,
    uid(),
    app,
    e,
    role,
    manager.agent ?? manager.user,
    app,
    e,
    ...args
  ).run()
  if (!r.meta.changes) denied()
}
export async function changeMember(
  env: Env,
  app: string,
  manager: Manager,
  target: { id: string } | { email: unknown },
  role: Role | null,
  transfer = false
) {
  const byId = "id" in target
  const row = await sql(
    env,
    `SELECT id,role,user_id,0 pending FROM members WHERE app_id=?1 AND ${byId ? "coalesce(user_id,id)" : "email"}=?2
    UNION ALL SELECT id,role,NULL,1 FROM workspace_invitations WHERE app_id=?1 AND ${byId ? "id" : "email"}=?2`,
    app,
    byId ? target.id : email(target.email)
  ).first<{ id: string; role: Role; user_id: string | null; pending: number }>()
  if (!row) missing()
  if (transfer && !row.user_id) bad("Ownership can only be transferred to a joined member")
  const [allowed, args] = gate(app, manager, can(row.role, "setup") || can(role, "setup"))
  const r = await sql(
    env,
    `${role === null ? "DELETE FROM" : "UPDATE"} ${row.pending ? "workspace_invitations" : "members"} ${role === null ? "" : "SET role=?"} WHERE app_id=? AND id=? AND role=? AND ${allowed}`,
    ...(role === null ? [] : [role]),
    app,
    row.id,
    row.role,
    ...args
  ).run()
  if (!r.meta.changes) denied()
}
