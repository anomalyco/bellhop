import type { AgentRole, Role } from "../../../shared/api"
import { agentRoleLabel, roleLabel } from "../../lib/roles"
import { ChevronDownIcon } from "../icons"
import { Menu, MenuItem } from "../Menu"
import "../../styles/agents.css"

export interface RoleOption<T extends string> {
  value: T
  label: string
  description?: string
  disabled?: boolean
  danger?: boolean
}

/** A compact select for a role: a small pill that opens a menu with one line per option. */
export function RoleSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  align = "end",
}: {
  value: T
  options: RoleOption<T>[]
  onChange: (value: T) => void
  /** What's being chosen, for screen readers ("Role for Alex"). */
  label: string
  disabled?: boolean
  align?: "start" | "end"
}) {
  const current = options.find((o) => o.value === value)
  return (
    <Menu
      align={align}
      width={280}
      trigger={(p) => (
        <button
          type="button"
          className="btn role-select"
          data-variant="default"
          data-size="small"
          aria-label={`${label}: ${current?.label ?? value}`}
          disabled={disabled}
          {...p}
        >
          <span className="role-select-value">{current?.label ?? value}</span>
          <ChevronDownIcon size={12} />
        </button>
      )}
    >
      {(close) =>
        options.map((o) => (
          <MenuItem
            key={o.value}
            checked={o.value === value}
            description={o.description}
            disabled={o.disabled}
            danger={o.danger}
            onSelect={() => {
              close()
              if (o.value !== value) onChange(o.value)
            }}
          >
            {o.label}
          </MenuItem>
        ))
      }
    </Menu>
  )
}

/** A team role as a quiet badge. */
export function RoleBadge({ role }: { role: Role }) {
  return <span className="role-badge">{roleLabel[role]}</span>
}

/** An agent role as a quiet badge. */
export function AgentRoleBadge({ role }: { role: AgentRole }) {
  return <span className="role-badge">{agentRoleLabel[role]}</span>
}
