import type { AgentAccess, App, ConnectedAgent } from "../../../shared/api"
import { agentRoleLabel } from "../../lib/roles"
import type { AccessApp } from "./AccessEditor"

/** The account's workspaces that an agent can be given (ones where the account has a role). */
export const accessApps = (apps: App[] | undefined): AccessApp[] =>
  (apps ?? []).flatMap((a) => (a.role ? [{ id: a.id, slug: a.slug, name: a.name, icon_url: a.icon_url, role: a.role }] : []))

/** An agent's current access, as the editor's value. */
export function accessOf(agent: ConnectedAgent): AgentAccess {
  const all = agent.all_workspaces
  return {
    all_workspaces: all,
    apps: [
      ...agent.apps.filter((a) => a.override || !all).map((a) => ({ id: a.id, role: a.role })),
      ...agent.excluded.map((a) => ({ id: a.id, role: null })),
    ],
    create_workspaces: agent.create_workspaces,
  }
}

/** "All workspaces · Member, Acme as Admin, except Beta" or "OpenCode · Member, Acme · Viewer". */
export function accessSummary(agent: ConnectedAgent): string {
  const role = (r: keyof typeof agentRoleLabel) => agentRoleLabel[r].toLowerCase()
  if (agent.all_workspaces) {
    const parts = [`All workspaces · ${role(agent.all_workspaces)}`]
    const overrides = agent.apps.filter((a) => a.override && a.role !== agent.all_workspaces)
    if (overrides.length) parts.push(overrides.map((a) => `${a.name} as ${role(a.role)}`).join(", "))
    if (agent.excluded.length) parts.push(`except ${agent.excluded.map((a) => a.name).join(", ")}`)
    return parts.join(", ")
  }
  if (!agent.apps.length) return agent.create_workspaces ? "No workspaces yet" : "No workspaces"
  return agent.apps.map((a) => `${a.name} · ${role(a.role)}`).join(", ")
}
