import type { AgentAccess, App, ConnectedAgent } from "../../../shared/api"
import { agentRoleLabel } from "../../lib/roles"
import type { AccessApp } from "./AccessEditor"
import { t } from "../../i18n/core"
import { getLocale } from "../../i18n"

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
  // Roles read in lower case mid-sentence, except in German, where nouns keep their capital
  const locale = getLocale()
  const role = (r: keyof typeof agentRoleLabel) => (locale === "de" ? agentRoleLabel[r] : agentRoleLabel[r].toLocaleLowerCase(locale))
  const list = (items: string[]) => items.join(t("list.separator"))
  if (agent.all_workspaces) {
    const parts = [t("access.all", { role: role(agent.all_workspaces) })]
    const overrides = agent.apps.filter((a) => a.override && a.role !== agent.all_workspaces)
    if (overrides.length) parts.push(list(overrides.map((a) => t("access.as", { name: a.name, role: role(a.role) }))))
    if (agent.excluded.length) parts.push(t("access.except", { names: list(agent.excluded.map((a) => a.name)) }))
    return list(parts)
  }
  if (!agent.apps.length) return agent.create_workspaces ? t("access.noneYet") : t("access.none")
  return list(agent.apps.map((a) => t("access.one", { name: a.name, role: role(a.role) })))
}
