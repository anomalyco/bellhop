import type { AgentRole, Role } from "../shared/api"
import { choice, denied, fail } from "./core"
import type { Ctx } from "./core"

const ranks = { viewer: 0, responder: 1, member: 2, admin: 3, owner: 4 } as const
const actions = { read: 0, respond: 1, triage: 2, setup: 3, ownership: 4 } as const
export type Action = keyof typeof actions
export function can(role: Role | AgentRole | null, action: Action) {
  return role !== null && ranks[role] >= actions[action]
}
export function requireTeam(c: Ctx, action: Action) {
  if (!c.var.user) fail(401, "sign_in", "Sign in to continue")
  if (!can(c.var.app.role, action)) denied()
}
export const teamRole = (v: unknown) => choice(v, ["viewer", "member", "admin", "owner"] as const, "team role")
export const agentRole = (v: unknown) => choice(v, ["viewer", "responder", "member", "admin"] as const, "agent role")
export function agentCap(role: Role): AgentRole {
  return can(role, "setup") ? "admin" : can(role, "triage") ? "member" : "responder"
}
const cases = (pairs: [string, string | number][], column: string) =>
  `CASE ${column} ${pairs.map(([k, v]) => `WHEN '${k}' THEN ${typeof v === "string" ? `'${v}'` : v}`).join(" ")} END`
const capSQL = (team: string) =>
  cases(
    (["owner", "admin", "member", "viewer"] as Role[]).map((r) => [r, agentCap(r)]),
    team
  )
// For atomic grant writes: bind the user's current membership and check the identical cap in SQL.
export function withinCapSQL(assigned: string, team: string) {
  return `(${cases(Object.entries(ranks), assigned)} <= ${cases(Object.entries(ranks), capSQL(team))})`
}
// Shared live resolver for authentication, both settings views and sensitive mutations. Keep
// explicit NULLs distinguishable from absent overrides; only actual current memberships join.
export const agentAccessSQL = `SELECT s.*,${capSQL("team")} max_role,
  CASE WHEN assigned IS NULL THEN NULL WHEN ${withinCapSQL("assigned", "team")} THEN assigned ELSE ${capSQL("team")} END role FROM
  (SELECT g.id agent_id,g.user_id,m.app_id,m.role team,ga.agent_id IS NOT NULL override,
     CASE WHEN ga.agent_id IS NULL THEN g.all_workspaces ELSE ga.role END assigned,
     CASE WHEN ga.agent_id IS NULL THEN g.all_workspaces='admin' ELSE ga.delegated_admin END delegated_admin
   FROM agents g JOIN members m ON m.user_id=g.user_id LEFT JOIN agent_apps ga ON ga.agent_id=g.id AND ga.app_id=m.app_id
   WHERE g.revoked_at IS NULL AND (g.all_workspaces IS NOT NULL OR ga.agent_id IS NOT NULL)) s`
