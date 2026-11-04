import type { AgentAccess, AgentRole, Role } from "../../../shared/api"
import { agentCap, agentRoleLabel, agentRoleText, agentRoles, atLeast, defaultAgentRole, roleLabel } from "../../lib/roles"
import { AppIcon } from "../primitives"
import { RoleSelect, type RoleOption } from "../roles/RoleSelect"
import "../../styles/agents.css"
import { t, useT } from "../../i18n/core"

/** A workspace the account belongs to, with its team role there (which caps what an agent may get). */
export interface AccessApp {
  id: string
  slug: string
  name: string
  icon_url: string | null
  role: Role
}

export const emptyAccess: AgentAccess = { all_workspaces: null, apps: [], create_workspaces: false }

/** Whether `access` grants anything at all: a workspace, all workspaces, or creating workspaces. */
export const grantsAnything = (access: AgentAccess) =>
  !!access.all_workspaces || access.create_workspaces || access.apps.some((a) => a.role !== null)

const roleOptions = (cap: AgentRole): RoleOption<AgentRole>[] =>
  agentRoles.map((r) => ({
    value: r,
    label: agentRoleLabel[r],
    description: atLeast(cap, r) ? agentRoleText[r] : t("accessEditor.aboveRole"),
    disabled: !atLeast(cap, r),
  }))

type RowValue = AgentRole | "default" | "none"

/**
 * Which workspaces an agent may use and as what: all of them at one role (rows become optional exceptions), or
 * ticked ones each with a role; plus whether it may create workspaces. Roles above the account's own are disabled.
 */
export function AccessEditor({ apps, value, onChange, name = "access" }: { apps: AccessApp[]; value: AgentAccess; onChange: (next: AgentAccess) => void; name?: string }) {
  const t = useT()
  const all = value.all_workspaces
  const entry = (id: string) => value.apps.find((a) => a.id === id)
  const setEntry = (id: string, role: AgentRole | null | undefined) => {
    const rest = value.apps.filter((a) => a.id !== id)
    onChange({ ...value, apps: role === undefined ? rest : [...rest, { id, role }] })
  }

  const toggleAll = (on: boolean) =>
    onChange(
      on
        ? // Ticked workspaces that differ from the new default stay as exceptions.
          { ...value, all_workspaces: "member", apps: value.apps.filter((a) => a.role !== null && a.role !== "member") }
        : { ...value, all_workspaces: null, apps: value.apps.filter((a) => a.role !== null) },
    )

  return (
    <div className="access">
      <div className="access-option">
        <label className="access-check">
          <input type="checkbox" checked={!!all} onChange={(e) => toggleAll(e.target.checked)} />
          <span className="access-check-text">
            <span className="access-check-title">{t("accessEditor.all")}</span>
            <span className="access-hint">{t("accessEditor.allHint")}</span>
          </span>
        </label>
        {all && (
          <RoleSelect
            value={all}
            label={t("accessEditor.roleAll")}
            options={agentRoles.map((r) => ({ value: r, label: agentRoleLabel[r], description: agentRoleText[r] }))}
            onChange={(r) => onChange({ ...value, all_workspaces: r })}
          />
        )}
      </div>

      <div className="access-list" role="group" aria-label={all ? t("accessEditor.exceptions") : t("accessEditor.workspaces")}>
        {all && apps.length > 0 && <p className="access-list-head">{t("accessEditor.exceptionsHead")}</p>}
        {apps.length === 0 && <p className="access-hint access-empty">{t("accessEditor.noWorkspaces")}</p>}
        {apps.map((app) => {
          const cap = agentCap(app.role)
          const current = entry(app.id)
          const team = <span className="access-team">{roleLabel[app.role]}</span>
          if (all) {
            const row: RowValue = current === undefined ? "default" : current.role === null ? "none" : current.role
            return (
              <div key={app.id} className="access-row" data-off={row === "none" || undefined}>
                <span className="access-name">
                  <AppIcon src={app.icon_url} size={20} />
                  <span className="access-name-text">{app.name}</span>
                  {team}
                </span>
                <RoleSelect<RowValue>
                  value={row}
                  label={t("accessEditor.roleIn", { name: app.name })}
                  options={[
                    { value: "default", label: t("accessEditor.defaultRole", { role: agentRoleLabel[all] }), description: t("accessEditor.sameAsAll") },
                    ...roleOptions(cap),
                    { value: "none", label: t("accessEditor.noAccess"), description: t("accessEditor.leaveOut"), danger: true },
                  ]}
                  onChange={(r) => setEntry(app.id, r === "default" ? undefined : r === "none" ? null : r)}
                />
              </div>
            )
          }
          const ticked = current !== undefined && current.role !== null
          const id = `${name}-${app.id}`
          return (
            <div key={app.id} className="access-row" data-off={!ticked || undefined}>
              <label className="access-name" htmlFor={id}>
                <input id={id} type="checkbox" checked={ticked} onChange={(e) => setEntry(app.id, e.target.checked ? defaultAgentRole(app.role) : undefined)} />
                <AppIcon src={app.icon_url} size={20} />
                <span className="access-name-text">{app.name}</span>
                {team}
              </label>
              <RoleSelect
                value={ticked ? current.role! : defaultAgentRole(app.role)}
                label={t("accessEditor.roleIn", { name: app.name })}
                disabled={!ticked}
                options={roleOptions(cap)}
                onChange={(r) => setEntry(app.id, r)}
              />
            </div>
          )
        })}
      </div>

      <div className="access-option">
        <label className="access-check">
          <input type="checkbox" checked={value.create_workspaces} onChange={(e) => onChange({ ...value, create_workspaces: e.target.checked })} />
          <span className="access-check-text">
            <span className="access-check-title">{t("accessEditor.create")}</span>
            <span className="access-hint">{t("accessEditor.createHint")}</span>
          </span>
        </label>
      </div>
    </div>
  )
}
