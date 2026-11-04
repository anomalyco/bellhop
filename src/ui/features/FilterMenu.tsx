import { useState, type ReactNode } from "react"
import type { IssueSort, Mentionable } from "../../../shared/api"
import { api, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { ChevronDownIcon } from "../icons"
import { Menu } from "../Menu"
import { Button } from "../primitives"
import "../../styles/insights.css"

// The search box's qualifiers, edited as text: each control adds, swaps or removes one `key:value` token and leaves
// the rest of the query (is:open, label:, free text) alone.

const tokenRe = /(\w+):("[^"]*"|\S+)|("[^"]*"|\S+)/g
interface Token {
  raw: string
  key: string | null
  value: string
}
function tokens(q: string): Token[] {
  return [...q.matchAll(tokenRe)].map((m) => ({ raw: m[0], key: m[1]?.toLowerCase() ?? null, value: (m[2] ?? "").replace(/^"|"$/g, "") }))
}
const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v)

/** True when the query has `key:value` (any value when `value` is omitted). */
export function hasQualifier(q: string, key: string, value?: string) {
  return tokens(q).some((t) => t.key === key && (value === undefined || t.value.toLowerCase() === value.toLowerCase()))
}
function valueOf(q: string, key: string) {
  return tokens(q).find((t) => t.key === key)?.value ?? null
}

/**
 * The query with every `key:` token matching `drop` removed, then `add` (if any) placed after the last qualifier,
 * before the free text.
 */
export function editQuery(q: string, drop: (t: Token) => boolean, add?: string) {
  const list = tokens(q).filter((t) => !drop(t))
  if (add) {
    const last = list.map((t) => t.key !== null).lastIndexOf(true)
    list.splice(last + 1, 0, { raw: add, key: add.split(":")[0]!, value: "" })
  }
  return list.map((t) => t.raw).join(" ")
}

const setOne = (q: string, key: string, value: string | null, also: (t: Token) => boolean = () => false) =>
  editQuery(q, (t) => t.key === key || also(t), value === null ? undefined : `${key}:${quote(value)}`)
const toggle = (q: string, key: string, value: string) =>
  hasQualifier(q, key, value) ? editQuery(q, (t) => t.key === key && t.value.toLowerCase() === value) : editQuery(q, () => false, `${key}:${value}`)

type Scope = "workspace" | "feed"

const statuses: [string, string][] = [
  ["open", "Open"],
  ["in_progress", "In progress"],
  ["waiting", "Waiting"],
  ["closed", "Closed"],
]
const reasons: [string, string][] = [
  ["completed", "Completed"],
  ["not_planned", "Not planned"],
  ["duplicate", "Duplicate"],
]
const sorts: [IssueSort, string][] = [
  ["newest", "Newest"],
  ["oldest", "Oldest"],
  ["votes", "Most votes"],
  ["updated", "Recently updated"],
  ["comments", "Most comments"],
]

/** Which qualifiers this menu manages, to count and to clear. */
function managed(t: Token, scope: Scope) {
  if (t.key === null) return false
  if (["status", "reason", "assignee", "author", "has"].includes(t.key)) return true
  if (t.key === "no") return t.value === "label" || t.value === "assignee"
  if (t.key === "is") return ["private", "locked", "pinned"].includes(t.value)
  if (t.key === "sort") return scope === "feed"
  return false
}

export function activeFilters(q: string, scope: Scope = "workspace") {
  return tokens(q).filter((t) => managed(t, scope)).length
}

const help: { q: string; text: string; scope: Scope[] }[] = [
  { q: "is:open · is:closed", text: "Open or closed", scope: ["workspace", "feed"] },
  { q: "status:in_progress", text: "open, in_progress, waiting or closed", scope: ["workspace", "feed"] },
  { q: "reason:not_planned", text: "completed, not_planned or duplicate", scope: ["workspace", "feed"] },
  { q: "label:bug", text: "Has the label (repeat for all of several)", scope: ["workspace", "feed"] },
  { q: 'label:"needs info"', text: "Quote names with spaces", scope: ["workspace", "feed"] },
  { q: "no:label · no:assignee", text: "Without any label, or unassigned", scope: ["workspace", "feed"] },
  { q: "assignee:@me", text: "Assigned to you, or to @handle", scope: ["workspace"] },
  { q: "author:@me", text: "Opened by you (this browser or account), or by @handle", scope: ["workspace"] },
  { q: "has:metadata", text: "Has diagnostics from an app", scope: ["workspace", "feed"] },
  { q: "is:private · is:locked · is:pinned", text: "Private (team and reporter), locked or pinned", scope: ["workspace"] },
  { q: "is:locked · is:pinned", text: "Locked or pinned", scope: ["feed"] },
  { q: "is:hidden", text: "Hidden by a moderator (team only)", scope: ["workspace"] },
  { q: "sort:votes", text: "newest, oldest, votes, updated or comments", scope: ["workspace", "feed"] },
]

/**
 * "Filters": a compact popover over the search query's qualifiers (status, reason, assignee, author, no label, no
 * assignee, diagnostics, private/locked/pinned; in the feed the cross-workspace subset plus sort), with a "?" view
 * listing every qualifier. Each choice rewrites the query at once through `onChange`.
 */
export function FilterMenu({
  query,
  onChange,
  scope = "workspace",
  slug,
  member = false,
  disabled,
}: {
  query: string
  onChange?: (next: string) => void
  scope?: Scope
  /** The workspace, for assignee and author handles (team only). */
  slug?: string
  /** On this workspace's team: shows assignees, handles and is:private. */
  member?: boolean
  /** The loading skeleton: the button holds its place. */
  disabled?: boolean
}) {
  const [helping, setHelping] = useState(false)
  const count = activeFilters(query, scope)
  const change = (next: string) => onChange?.(next)
  return (
    <Menu
      align="end"
      width={340}
      onOpenChange={(open) => !open && setHelping(false)}
      trigger={(p) => (
        <button
          type="button"
          className="btn filter-button"
          data-variant="default"
          data-active={count ? "" : undefined}
          aria-label={count ? `Filters, ${count} on` : "Filters"}
          disabled={disabled}
          {...p}
        >
          <FilterIcon />
          <span className="filter-text">Filters</span>
          {count > 0 && <span className="filter-count">{count}</span>}
          <ChevronDownIcon size={14} />
        </button>
      )}
    >
      {() =>
        helping ? (
          <Help scope={scope} onBack={() => setHelping(false)} />
        ) : (
          <Groups query={query} scope={scope} slug={slug} member={member} onChange={change} onHelp={() => setHelping(true)} />
        )
      }
    </Menu>
  )
}

function Groups({
  query,
  scope,
  slug,
  member,
  onChange,
  onHelp,
}: {
  query: string
  scope: Scope
  slug?: string
  member: boolean
  onChange: (next: string) => void
  onHelp: () => void
}) {
  const team = scope === "workspace" && member && !!slug
  const { data: people } = useResource<Mentionable[]>(team ? keys.mentionables(slug!) : null, () => api.mentionables(slug!), 60_000)
  const status = valueOf(query, "status")
  const reason = valueOf(query, "reason")
  const assignee = hasQualifier(query, "no", "assignee") ? "-" : valueOf(query, "assignee")
  const author = valueOf(query, "author")
  const sort = (valueOf(query, "sort") ?? "newest") as IssueSort
  const handles = (people ?? []).slice(0, 6)

  return (
    <div className="filter-menu">
      <Group title="Status">
        <Chip on={!status} onClick={() => onChange(setOne(query, "status", null))} radio>
          Any
        </Chip>
        {statuses.map(([v, label]) => (
          <Chip key={v} on={status === v} onClick={() => onChange(setOne(query, "status", status === v ? null : v))} radio>
            {label}
          </Chip>
        ))}
      </Group>
      <Group title="Closed as">
        <Chip on={!reason} onClick={() => onChange(setOne(query, "reason", null))} radio>
          Any
        </Chip>
        {reasons.map(([v, label]) => (
          <Chip key={v} on={reason === v} onClick={() => onChange(setOne(query, "reason", reason === v ? null : v))} radio>
            {label}
          </Chip>
        ))}
      </Group>
      <Group title="Assignee">
        <Chip on={!assignee} onClick={() => onChange(setOne(query, "assignee", null, (t) => t.key === "no" && t.value === "assignee"))} radio>
          Anyone
        </Chip>
        {team && (
          <Chip on={assignee === "@me"} onClick={() => onChange(setOne(query, "assignee", "@me", (t) => t.key === "no" && t.value === "assignee"))} radio>
            Me
          </Chip>
        )}
        <Chip
          on={assignee === "-"}
          onClick={() => onChange(assignee === "-" ? editQuery(query, (t) => t.key === "no" && t.value === "assignee") : editQuery(query, (t) => t.key === "assignee" || (t.key === "no" && t.value === "assignee"), "no:assignee"))}
          radio
        >
          No one
        </Chip>
        {team &&
          handles.map((m) => (
            <Chip key={m.id} on={assignee === m.handle} onClick={() => onChange(setOne(query, "assignee", m.handle, (t) => t.key === "no" && t.value === "assignee"))} radio>
              @{m.handle}
            </Chip>
          ))}
      </Group>
      {scope === "workspace" && (
        <Group title="Author">
          <Chip on={!author} onClick={() => onChange(setOne(query, "author", null))} radio>
            Anyone
          </Chip>
          <Chip on={author === "@me"} onClick={() => onChange(setOne(query, "author", author === "@me" ? null : "@me"))} radio>
            Me
          </Chip>
          {team &&
            handles.map((m) => (
              <Chip key={m.id} on={author === m.handle} onClick={() => onChange(setOne(query, "author", author === m.handle ? null : m.handle))} radio>
                @{m.handle}
              </Chip>
            ))}
        </Group>
      )}
      <Group title="Has">
        <Chip on={hasQualifier(query, "no", "label")} onClick={() => onChange(toggle(query, "no", "label"))}>
          No label
        </Chip>
        <Chip on={hasQualifier(query, "has", "metadata")} onClick={() => onChange(toggle(query, "has", "metadata"))}>
          Diagnostics
        </Chip>
        {scope === "workspace" && member && (
          <Chip on={hasQualifier(query, "is", "private")} onClick={() => onChange(toggle(query, "is", "private"))}>
            Private
          </Chip>
        )}
        <Chip on={hasQualifier(query, "is", "locked")} onClick={() => onChange(toggle(query, "is", "locked"))}>
          Locked
        </Chip>
        <Chip on={hasQualifier(query, "is", "pinned")} onClick={() => onChange(toggle(query, "is", "pinned"))}>
          Pinned
        </Chip>
      </Group>
      {scope === "feed" && (
        <Group title="Sort">
          {sorts.map(([v, label]) => (
            <Chip key={v} on={sort === v} onClick={() => onChange(setOne(query, "sort", v === "newest" ? null : v))} radio>
              {label}
            </Chip>
          ))}
        </Group>
      )}
      <div className="filter-foot">
        <span className="filter-query" title={query}>
          {query || "is:open"}
        </span>
        <span className="filter-foot-actions">
          {activeFilters(query, scope) > 0 && (
            <Button size="small" variant="invisible" onClick={() => onChange(editQuery(query, (t) => managed(t, scope)))}>
              Clear
            </Button>
          )}
          <Button size="small" variant="ghost-muted" iconOnly aria-label="Search qualifiers" title="Search qualifiers" onClick={onHelp}>
            ?
          </Button>
        </span>
      </div>
    </div>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="filter-group" role="group" aria-label={title}>
      <p className="filter-group-title">{title}</p>
      <div className="filter-chips">{children}</div>
    </div>
  )
}

function Chip({ on, onClick, radio, children }: { on: boolean; onClick: () => void; radio?: boolean; children: ReactNode }) {
  return (
    <button type="button" className="filter-chip" role={radio ? "menuitemradio" : "menuitemcheckbox"} aria-checked={on} onClick={onClick}>
      {children}
    </button>
  )
}

function Help({ scope, onBack }: { scope: Scope; onBack: () => void }) {
  return (
    <div className="filter-help">
      <p className="filter-group-title">Search qualifiers</p>
      {help
        .filter((h) => h.scope.includes(scope))
        .map((h) => (
          <div key={h.q} className="filter-help-row">
            <code>{h.q}</code>
            <span>{h.text}</span>
          </div>
        ))}
      <p className="filter-help-note">Combine them with words: qualifiers narrow, words search titles, bodies and comments.</p>
      <div className="filter-foot">
        <span />
        <Button size="small" variant="invisible" role="menuitem" onClick={onBack}>
          Back to filters
        </Button>
      </div>
    </div>
  )
}

function FilterIcon() {
  return (
    <svg className="icon" width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3.5h11l-4.25 5v3.75l-2.5 1.25v-5z" />
    </svg>
  )
}
