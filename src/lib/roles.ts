import type { AgentRole, Role } from "../../shared/api"
import { tKey, type PlainKey } from "../i18n/core"

// Team roles and agent roles, mirroring worker/permissions.ts. Each role includes the ones below it.

export const teamRoles: Role[] = ["owner", "admin", "member", "viewer"]
export const agentRoles: AgentRole[] = ["admin", "member", "responder", "viewer"]

// Read at render, in the active language (getters, so `roleLabel[role]` keeps working everywhere).
const labels = <K extends string>(keys: Record<K, PlainKey>) =>
  Object.defineProperties({}, Object.fromEntries(Object.entries(keys).map(([k, key]) => [k, { get: () => tKey(key as PlainKey), enumerable: true }]))) as Record<K, string>

export const roleLabel = labels<Role>({ owner: "role.owner", admin: "role.admin", member: "role.member", viewer: "role.viewer" })
export const agentRoleLabel = labels<AgentRole>({ admin: "role.admin", member: "role.member", responder: "role.responder", viewer: "role.viewer" })

/** What each team role adds, in a few words. */
export const roleText = labels<Role>({ owner: "role.ownerText", admin: "role.adminText", member: "role.memberText", viewer: "role.viewerText" })

/** What an agent can do with each role, in a few words. */
export const agentRoleText = labels<AgentRole>({
  admin: "agentRole.adminText",
  member: "agentRole.memberText",
  responder: "agentRole.responderText",
  viewer: "agentRole.viewerText",
})

const rank = { viewer: 0, responder: 1, member: 2, admin: 3, owner: 4 } as const

export const atLeast = (role: Role | AgentRole | null | undefined, min: Role | AgentRole) => !!role && rank[role] >= rank[min]

/** Workspace setup: settings, labels, templates, webhooks, agents, members. */
export const canSetup = (role: Role | null | undefined) => atLeast(role, "admin")

/** The most an agent can be where its account has `role`: owner/admin -> admin, member -> member, viewer -> responder. */
export function agentCap(role: Role): AgentRole {
  return atLeast(role, "admin") ? "admin" : role === "member" ? "member" : "responder"
}

/** `role`, lowered to `cap` if it's above it. */
export const capAgentRole = (role: AgentRole, cap: AgentRole): AgentRole => (rank[role] > rank[cap] ? cap : role)

/** The default role for a newly ticked workspace: member, or less where the account can't give that much. */
export const defaultAgentRole = (team: Role) => capAgentRole("member", agentCap(team))
