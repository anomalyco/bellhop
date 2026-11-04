import { useState, type FormEvent } from "react"
import type { Actor, AppDetail, AppSettings, Issue, IssueStatus, Relation, RelationType, SystemInfo } from "../../../shared/api"
import { api, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { visibleState } from "../../lib/issues"
import { appPath } from "../../lib/site"
import { ActorAvatar, actorName } from "../../ui/Actor"
import { StatusIcon, XIcon } from "../../ui/icons"
import { Menu, MenuItem } from "../../ui/Menu"
import { Button } from "../../ui/primitives"
import { AppLink } from "../../ui/SiteLink"

type Trigger = Parameters<typeof Menu>[0]["trigger"]

export interface IssueActions {
  setStatus(status: IssueStatus): void
  toggleLabel(id: string): void
  assign(actor: Actor | null): void
  addRelation(kind: RelationKind, number: number): Promise<void>
  removeRelation(relation: Relation): void
}

export type RelationKind = "duplicate_of" | "duplicated_by" | "related" | "blocks" | "blocked_by"

export const relationKinds: { kind: RelationKind; label: string }[] = [
  { kind: "duplicate_of", label: "Duplicate of" },
  { kind: "duplicated_by", label: "Duplicated by" },
  { kind: "related", label: "Related" },
  { kind: "blocks", label: "Blocks" },
  { kind: "blocked_by", label: "Blocked by" },
]

export function relationKind(r: Relation): RelationKind {
  if (r.type === "related") return "related"
  if (r.type === "duplicate_of") return r.direction === "outgoing" ? "duplicate_of" : "duplicated_by"
  return r.direction === "outgoing" ? "blocks" : "blocked_by"
}

/** How a kind is stored: the type, and whether this issue is the source. */
export function relationRequest(kind: RelationKind): { type: RelationType; outgoing: boolean } {
  switch (kind) {
    case "duplicate_of":
      return { type: "duplicate_of", outgoing: true }
    case "duplicated_by":
      return { type: "duplicate_of", outgoing: false }
    case "blocks":
      return { type: "blocks", outgoing: true }
    case "blocked_by":
      return { type: "blocks", outgoing: false }
    default:
      return { type: "related", outgoing: true }
  }
}

export const statusOptions: { status: IssueStatus; label: string; description: string }[] = [
  { status: "open", label: "Open", description: "Not started yet" },
  { status: "in_progress", label: "In progress", description: "Someone is working on it" },
  { status: "waiting", label: "Waiting on reporter", description: "Needs more information" },
]

export function StatusMenu({ issue, onSet, trigger }: { issue: Issue; onSet: (s: IssueStatus) => void; trigger: Trigger }) {
  return (
    <Menu width={260} trigger={trigger}>
      {(close) =>
        statusOptions.map((o) => (
          <MenuItem
            key={o.status}
            checked={issue.status === o.status}
            description={o.description}
            onSelect={() => {
              close()
              if (issue.status !== o.status) onSet(o.status)
            }}
          >
            {o.label}
          </MenuItem>
        ))
      }
    </Menu>
  )
}

/** Relations grouped by kind; members get a remove button on each. */
export function RelationList({ app, issue, onRemove }: { app: AppDetail; issue: Issue; onRemove?: (r: Relation) => void }) {
  const groups = relationKinds
    .map((k) => ({ ...k, items: issue.relations.filter((r) => relationKind(r) === k.kind) }))
    .filter((g) => g.items.length)
  if (!groups.length) return <div className="sidebar-empty">None yet</div>
  return (
    <>
      {groups.map((g) => (
        <div key={g.kind} className="relation-group">
          <div className="relation-kind">{g.label}</div>
          {g.items.map((r) => {
            const G = StatusIcon[visibleState(r.issue)]
            return (
              <div key={r.id} className="relation-row">
                <span className="state-icon" data-state={visibleState(r.issue)}>
                  <G size={14} />
                </span>
                <AppLink slug={app.slug} href={appPath(app.slug, `/issues/${r.issue.number}`)} className="relation-link">
                  {r.issue.title} <span className="mono relation-number">#{r.issue.number}</span>
                </AppLink>
                {onRemove && (
                  <button type="button" className="relation-remove" aria-label={`Remove relation to #${r.issue.number}`} onClick={() => onRemove(r)}>
                    <XIcon size={12} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}

export function SystemInfoList({ info }: { info: SystemInfo | "hidden" }) {
  if (info === "hidden") return <div className="sidebar-empty">Attached. Only members can see it.</div>
  return (
    <dl className="sysinfo">
      {Object.entries(info).map(([k, v]) => (
        <div key={k} className="sysinfo-row">
          <dt>{k}</dt>
          <dd className="mono">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

export function AssignMenu({ app, issue, onAssign, trigger }: { app: AppDetail; issue: Issue; onAssign: (a: Actor | null) => void; trigger: Trigger }) {
  const [open, setOpen] = useState(false)
  const { data: settings, error } = useResource<AppSettings>(open ? keys.settings(app.slug) : null, () => api.settings(app.slug), 30_000)
  const members = settings?.members
  const failed = !!error && !members
  return (
    <Menu
      align="end"
      width={260}
      onOpenChange={setOpen}
      trigger={trigger}
    >
      {(close) => (
        <>
          {issue.assignee && (
            <MenuItem
              onSelect={() => {
                close()
                onAssign(null)
              }}
            >
              Unassign {actorName(issue.assignee)}
            </MenuItem>
          )}
          {!members && !failed && <div className="menu-empty">Loading…</div>}
          {failed && <div className="menu-empty">Couldn't load members.</div>}
          {members
            ?.filter((m) => m.joined)
            .map((m) => {
              const actor: Actor = { type: "member", id: m.id, name: m.name ?? m.email, avatar_url: m.avatar_url }
              return (
                <MenuItem
                  key={m.id}
                  checked={issue.assignee?.id === m.id}
                  onSelect={() => {
                    close()
                    if (issue.assignee?.id !== m.id) onAssign(actor)
                  }}
                >
                  <ActorAvatar actor={actor} size={18} />
                  {actor.name}
                </MenuItem>
              )
            })}
        </>
      )}
    </Menu>
  )
}

export function LabelMenu({ app, selected, onToggle, trigger }: { app: AppDetail; selected: string[]; onToggle: (id: string) => void; trigger: Trigger }) {
  const [query, setQuery] = useState("")
  const shown = app.labels.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()))
  return (
    <Menu align="end" width={280} onOpenChange={(o) => !o && setQuery("")} trigger={trigger}>
      {() => (
        <>
          <div className="menu-filter">
            <div className="input" data-size="small">
              <input placeholder="Filter labels" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter labels" />
            </div>
          </div>
          <div className="menu-scroll">
            {shown.map((l) => (
              <MenuItem key={l.id} checked={selected.includes(l.id)} description={l.description || undefined} onSelect={() => onToggle(l.id)}>
                <span className="label-dot" style={{ background: `#${l.color}` }} />
                {l.name}
              </MenuItem>
            ))}
            {shown.length === 0 && (
              <div className="menu-empty">
                No labels. {app.role && <AppLink slug={app.slug} href={appPath(app.slug, "/settings/labels")}>Manage labels</AppLink>}
              </div>
            )}
          </div>
        </>
      )}
    </Menu>
  )
}

export function RelationForm({ onAdd, onDone }: { onAdd: (kind: RelationKind, number: number) => Promise<void>; onDone?: () => void }) {
  const [kind, setKind] = useState<RelationKind>("related")
  const [number, setNumber] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const n = Number(number.replace(/^#/, ""))
    if (!Number.isInteger(n) || n < 1) return setError("Enter an issue number.")
    setSaving(true)
    setError(null)
    try {
      await onAdd(kind, n)
      setNumber("")
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add that relationship.")
    } finally {
      setSaving(false)
    }
  }
  return (
    <form className="relation-form" onSubmit={submit}>
      <label className="field-label" htmlFor="relation-kind">
        Relationship
      </label>
      <select id="relation-kind" className="select" value={kind} onChange={(e) => setKind(e.target.value as RelationKind)}>
        {relationKinds.map((k) => (
          <option key={k.kind} value={k.kind}>
            {k.label}
          </option>
        ))}
      </select>
      <label className="field-label" htmlFor="relation-number">
        Issue
      </label>
      <div className="input" data-size="small">
        <span className="input-prefix mono">#</span>
        <input id="relation-number" className="mono" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="123" autoFocus />
      </div>
      {error && <p className="field-error">{error}</p>}
      <Button type="submit" size="small" variant="primary" disabled={saving}>
        {saving ? "Adding…" : "Add"}
      </Button>
    </form>
  )
}
