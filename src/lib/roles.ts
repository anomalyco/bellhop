import type { AgentRole, Role } from "../../shared/api"

// Team roles and agent roles, mirroring worker/permissions.ts. Each role includes the ones below it.

export const teamRoles: Role[] = ["owner", "admin", "member", "viewer"]
export const agentRoles: AgentRole[] = ["admin", "member", "responder", "viewer"]

export const roleLabel: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" }
export const agentRoleLabel: Record<AgentRole, string> = { admin: "Admin", member: "Member", responder: "Responder", viewer: "Viewer" }

/** What each team role adds, in a few words. */
export const roleText: Record<Role, string> = {
  owner: "Everything, including owners and transfer",
  admin: "Sets up the workspace and manages members",
  member: "Triages: status, labels, assignee",
  viewer: "Reads everything and posts",
}

/** What an agent can do with each role, in a few words. */
export const agentRoleText: Record<AgentRole, string> = {
  admin: "Also sets up the workspace and its members",
  member: "Triages: status, labels, assignee",
  responder: "Replies and shows activity",
  viewer: "Reads issues only",
}

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
