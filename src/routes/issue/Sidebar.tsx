import { useState, type FormEvent, type ReactNode } from "react"
import { Link } from "wouter"
import type { Actor, AppDetail, AppSettings, Issue, IssueStatus, Me, Relation, RelationType } from "../../../shared/api"
import { api, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { visibleState } from "../../lib/issues"
import { ActorAvatar, ActorName, actorName } from "../../ui/Actor"
import { SettingsIcon, StatusIcon, XIcon } from "../../ui/icons"
import { Menu, MenuItem } from "../../ui/Menu"
import { Button, Label } from "../../ui/primitives"
import { AttachmentList } from "./Timeline"

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

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="sidebar-section">
      <div className="sidebar-heading">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

const gear = (props: object, label: string) => (
  <button type="button" className="sidebar-gear" aria-label={label} {...props}>
    <SettingsIcon size={14} />
  </button>
)

const statusOptions: { status: IssueStatus; label: string; description: string }[] = [
  { status: "open", label: "Open", description: "Not started yet" },
  { status: "in_progress", label: "In progress", description: "Someone is working on it" },
  { status: "waiting", label: "Waiting on reporter", description: "Needs more information" },
]

export function Sidebar({ app, issue, me, actions }: { app: AppDetail; issue: Issue; me: Me | undefined; actions: IssueActions }) {
  const member = !!app.role
  const groups = relationKinds
    .map((k) => ({ ...k, items: issue.relations.filter((r) => relationKind(r) === k.kind) }))
    .filter((g) => g.items.length)
  const allAttachments = [
    ...issue.attachments,
    ...issue.timeline.flatMap((t) => (t.kind === "comment" ? t.comment.attachments : [])),
  ]

  return (
    <aside className="issue-sidebar">
      {member && issue.status !== "closed" && (
        <Section
          title="Status"
          action={
            <Menu align="end" width={260} trigger={(p) => gear(p, "Change status")}>
              {(close) =>
                statusOptions.map((o) => (
                  <MenuItem
                    key={o.status}
                    checked={issue.status === o.status}
                    description={o.description}
                    onSelect={() => {
                      close()
                      if (issue.status !== o.status) actions.setStatus(o.status)
                    }}
                  >
                    {o.label}
                  </MenuItem>
                ))
              }
            </Menu>
          }
        >
          <div className="sidebar-value">
            <span className="state-icon" data-state={visibleState(issue)}>
              {(() => {
                const G = StatusIcon[visibleState(issue)]
                return <G size={16} />
              })()}
            </span>
            {statusOptions.find((o) => o.status === issue.status)?.label}
          </div>
        </Section>
      )}

      <Section title="Assignee" action={member ? <AssignMenu app={app} issue={issue} onAssign={actions.assign} /> : undefined}>
        {issue.assignee ? (
          <div className="sidebar-value">
            <ActorAvatar actor={issue.assignee} size={20} />
            <ActorName actor={issue.assignee} />
          </div>
        ) : member && me?.user ? (
          <div className="sidebar-empty">
            No one ·{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => actions.assign({ type: "member", id: me.user!.id, name: me.user!.name, avatar_url: me.user!.avatar_url })}
            >
              assign yourself
            </button>
          </div>
        ) : (
          <div className="sidebar-empty">No one</div>
        )}
      </Section>

      <Section
        title="Labels"
        action={
          member ? (
            <LabelMenu app={app} selected={issue.labels.map((l) => l.id)} onToggle={actions.toggleLabel} />
          ) : undefined
        }
      >
        {issue.labels.length ? (
          <div className="sidebar-labels">
            {issue.labels.map((l) => (
              <Link key={l.id} href={`/${app.slug}?q=${encodeURIComponent(`is:open label:${/\s/.test(l.name) ? `"${l.name}"` : l.name}`)}`} title={l.description}>
                <Label name={l.name} color={l.color} />
              </Link>
            ))}
          </div>
        ) : (
          <div className="sidebar-empty">None yet</div>
        )}
      </Section>

      <Section title="Relationships" action={member ? <RelationAdd onAdd={actions.addRelation} /> : undefined}>
        {groups.length === 0 && <div className="sidebar-empty">None yet</div>}
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
                  <Link href={`/${app.slug}/issues/${r.issue.number}`} className="relation-link">
                    {r.issue.title} <span className="mono relation-number">#{r.issue.number}</span>
                  </Link>
                  {member && (
                    <button type="button" className="relation-remove" aria-label={`Remove relation to #${r.issue.number}`} onClick={() => actions.removeRelation(r)}>
                      <XIcon size={12} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </Section>

      {issue.system_info && (
        <Section title="System info">
          {issue.system_info === "hidden" ? (
            <div className="sidebar-empty">Attached. Only members can see it.</div>
          ) : (
            <dl className="sysinfo">
              {Object.entries(issue.system_info).map(([k, v]) => (
                <div key={k} className="sysinfo-row">
                  <dt>{k}</dt>
                  <dd className="mono">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </Section>
      )}

      {allAttachments.length > 0 && (
        <Section title="Attachments">
          <AttachmentList attachments={allAttachments} />
        </Section>
      )}
    </aside>
  )
}

function AssignMenu({ app, issue, onAssign }: { app: AppDetail; issue: Issue; onAssign: (a: Actor | null) => void }) {
  const [open, setOpen] = useState(false)
  const { data: settings, error } = useResource<AppSettings>(open ? keys.settings(app.slug) : null, () => api.settings(app.slug), 30_000)
  const members = settings?.members
  const failed = !!error && !members
  return (
    <Menu
      align="end"
      width={260}
      onOpenChange={setOpen}
      trigger={(p) => gear(p, "Assign")}
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

function LabelMenu({ app, selected, onToggle }: { app: AppDetail; selected: string[]; onToggle: (id: string) => void }) {
  const [query, setQuery] = useState("")
  const shown = app.labels.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()))
  return (
    <Menu align="end" width={280} onOpenChange={(o) => !o && setQuery("")} trigger={(p) => gear(p, "Edit labels")}>
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
                No labels. {app.role && <Link href={`/${app.slug}/settings/labels`}>Manage labels</Link>}
              </div>
            )}
          </div>
        </>
      )}
    </Menu>
  )
}

function RelationAdd({ onAdd }: { onAdd: (kind: RelationKind, number: number) => Promise<void> }) {
  const [kind, setKind] = useState<RelationKind>("related")
  const [number, setNumber] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  return (
    <Menu align="end" width={260} trigger={(p) => gear(p, "Add relationship")} onOpenChange={() => setError(null)}>
      {(close) => {
        const submit = async (e: FormEvent) => {
          e.preventDefault()
          const n = Number(number.replace(/^#/, ""))
          if (!Number.isInteger(n) || n < 1) return setError("Enter an issue number.")
          setSaving(true)
          setError(null)
          try {
            await onAdd(kind, n)
            setNumber("")
            close()
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
              <input
                id="relation-number"
                className="mono"
                inputMode="numeric"
                value={number}
                onChange={(e) => setNumber(e.target.value)}
                placeholder="123"
                autoFocus
              />
            </div>
            {error && <p className="field-error">{error}</p>}
            <Button type="submit" size="small" variant="primary" disabled={saving}>
              {saving ? "Adding…" : "Add"}
            </Button>
          </form>
        )
      }}
    </Menu>
  )
}
