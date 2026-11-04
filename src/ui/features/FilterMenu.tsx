import { useState, type ReactNode } from "react"
import type { IssueSort, Mentionable } from "../../../shared/api"
import { api, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { ChevronDownIcon } from "../icons"
import { Menu } from "../Menu"
import { Button } from "../primitives"
import "../../styles/insights.css"
import { tKey, useT, type PlainKey } from "../../i18n/core"
import { useT as useDeskT } from "../../i18n/helpdesk"

/** The help desk review queue's counts (null: not a help desk team). */
type Review = { heldCount: number | null; approvalCount: number | null } | null

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

const statuses: [string, PlainKey][] = [
  ["open", "state.open"],
  ["in_progress", "state.in_progress"],
  ["waiting", "filter.waiting"],
  ["closed", "state.closed"],
]
const reasons: [string, PlainKey][] = [
  ["completed", "filter.completed"],
  ["not_planned", "state.not_planned"],
  ["duplicate", "state.duplicate"],
]
export const sorts: [IssueSort, PlainKey][] = [
  ["newest", "sort.newest"],
  ["oldest", "sort.oldest"],
  ["votes", "sort.votes"],
  ["updated", "sort.updated"],
  ["comments", "sort.comments"],
]
const label = tKey

/** Which qualifiers this menu manages, to count and to clear. */
function managed(t: Token, scope: Scope) {
  if (t.key === null) return false
  if (["status", "reason", "assignee", "author", "has"].includes(t.key)) return true
  if (t.key === "no") return t.value === "label" || t.value === "assignee"
  if (t.key === "is") return ["private", "locked", "pinned", "held", "awaiting-approval"].includes(t.value)
  if (t.key === "sort") return scope === "feed"
  return false
}

export function activeFilters(q: string, scope: Scope = "workspace") {
  return tokens(q).filter((t) => managed(t, scope)).length
}

const help: { q: string; text: PlainKey; scope: Scope[] }[] = [
  { q: "is:open · is:closed", text: "filter.help.state", scope: ["workspace", "feed"] },
  { q: "status:in_progress", text: "filter.help.status", scope: ["workspace", "feed"] },
  { q: "reason:not_planned", text: "filter.help.reason", scope: ["workspace", "feed"] },
  { q: "label:bug", text: "filter.help.label", scope: ["workspace", "feed"] },
  { q: 'label:"needs info"', text: "filter.help.quote", scope: ["workspace", "feed"] },
  { q: "no:label · no:assignee", text: "filter.help.no", scope: ["workspace", "feed"] },
  { q: "assignee:@me", text: "filter.help.assignee", scope: ["workspace"] },
  { q: "author:@me", text: "filter.help.author", scope: ["workspace"] },
  { q: "has:metadata", text: "filter.help.metadata", scope: ["workspace", "feed"] },
  { q: "is:private · is:locked · is:pinned", text: "filter.help.isWorkspace", scope: ["workspace"] },
  { q: "is:locked · is:pinned", text: "filter.help.isFeed", scope: ["feed"] },
  { q: "is:hidden", text: "filter.help.hidden", scope: ["workspace"] },
  { q: "sort:votes", text: "filter.help.sort", scope: ["workspace", "feed"] },
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
  review = null,
  disabled,
}: {
  query: string
  onChange?: (next: string) => void
  scope?: Scope
  /** The workspace, for assignee and author handles (team only). */
  slug?: string
  /** On this workspace's team: shows assignees, handles and is:private. */
  member?: boolean
  /** Help desk team: the review queue's counts, for the "Needs review" filters (null elsewhere). */
  review?: Review
  /** The loading skeleton: the button holds its place. */
  disabled?: boolean
}) {
  const t = useT()
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
          aria-label={count ? t("filter.buttonOn", { count }) : t("filter.button")}
          disabled={disabled}
          {...p}
        >
          <FilterIcon />
          <span className="filter-text">{t("filter.button")}</span>
          {count > 0 && <span className="filter-count">{count}</span>}
          <ChevronDownIcon size={14} />
        </button>
      )}
    >
      {() =>
        helping ? (
          <Help scope={scope} desk={!!review} onBack={() => setHelping(false)} />
        ) : (
          <Groups query={query} scope={scope} slug={slug} member={member} review={review} onChange={change} onHelp={() => setHelping(true)} />
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
  review,
  onChange,
  onHelp,
}: {
  query: string
  scope: Scope
  slug?: string
  member: boolean
  review: Review
  onChange: (next: string) => void
  onHelp: () => void
}) {
  const td = useDeskT()
  const t = useT()
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
      {review && (
        <Group title={td("queue.title")}>
          <Chip on={hasQualifier(query, "is", "held")} onClick={() => onChange(toggle(query, "is", "held"))}>
            {td("queue.held")}
            {review.heldCount !== null && <span className="filter-chip-count">{review.heldCount}</span>}
          </Chip>
          <Chip on={hasQualifier(query, "is", "awaiting-approval")} onClick={() => onChange(toggle(query, "is", "awaiting-approval"))}>
            {td("queue.approvals")}
            {review.approvalCount !== null && <span className="filter-chip-count">{review.approvalCount}</span>}
          </Chip>
        </Group>
      )}
      <Group title={t("filter.status")}>
        <Chip on={!status} onClick={() => onChange(setOne(query, "status", null))} radio>
          {t("filter.any")}
        </Chip>
        {statuses.map(([v, name]) => (
          <Chip key={v} on={status === v} onClick={() => onChange(setOne(query, "status", status === v ? null : v))} radio>
            {label(name)}
          </Chip>
        ))}
      </Group>
      <Group title={t("filter.closedAs")}>
        <Chip on={!reason} onClick={() => onChange(setOne(query, "reason", null))} radio>
          {t("filter.any")}
        </Chip>
        {reasons.map(([v, name]) => (
          <Chip key={v} on={reason === v} onClick={() => onChange(setOne(query, "reason", reason === v ? null : v))} radio>
            {label(name)}
          </Chip>
        ))}
      </Group>
      <Group title={t("filter.assignee")}>
        <Chip on={!assignee} onClick={() => onChange(setOne(query, "assignee", null, (t) => t.key === "no" && t.value === "assignee"))} radio>
          {t("filter.anyone")}
        </Chip>
        {team && (
          <Chip on={assignee === "@me"} onClick={() => onChange(setOne(query, "assignee", "@me", (t) => t.key === "no" && t.value === "assignee"))} radio>
            {t("filter.me")}
          </Chip>
        )}
        <Chip
          on={assignee === "-"}
          onClick={() => onChange(assignee === "-" ? editQuery(query, (t) => t.key === "no" && t.value === "assignee") : editQuery(query, (t) => t.key === "assignee" || (t.key === "no" && t.value === "assignee"), "no:assignee"))}
          radio
        >
          {t("filter.noOne")}
        </Chip>
        {team &&
          handles.map((m) => (
            <Chip key={m.id} on={assignee === m.handle} onClick={() => onChange(setOne(query, "assignee", m.handle, (t) => t.key === "no" && t.value === "assignee"))} radio>
              @{m.handle}
            </Chip>
          ))}
      </Group>
      {scope === "workspace" && (
        <Group title={t("filter.author")}>
          <Chip on={!author} onClick={() => onChange(setOne(query, "author", null))} radio>
            {t("filter.anyone")}
          </Chip>
          <Chip on={author === "@me"} onClick={() => onChange(setOne(query, "author", author === "@me" ? null : "@me"))} radio>
            {t("filter.me")}
          </Chip>
          {team &&
            handles.map((m) => (
              <Chip key={m.id} on={author === m.handle} onClick={() => onChange(setOne(query, "author", author === m.handle ? null : m.handle))} radio>
                @{m.handle}
              </Chip>
            ))}
        </Group>
      )}
      <Group title={t("filter.has")}>
        <Chip on={hasQualifier(query, "no", "label")} onClick={() => onChange(toggle(query, "no", "label"))}>
          {t("filter.noLabel")}
        </Chip>
        <Chip on={hasQualifier(query, "has", "metadata")} onClick={() => onChange(toggle(query, "has", "metadata"))}>
          {t("filter.diagnostics")}
        </Chip>
        {scope === "workspace" && member && (
          <Chip on={hasQualifier(query, "is", "private")} onClick={() => onChange(toggle(query, "is", "private"))}>
            {t("filter.private")}
          </Chip>
        )}
        <Chip on={hasQualifier(query, "is", "locked")} onClick={() => onChange(toggle(query, "is", "locked"))}>
          {t("filter.locked")}
        </Chip>
        <Chip on={hasQualifier(query, "is", "pinned")} onClick={() => onChange(toggle(query, "is", "pinned"))}>
          {t("filter.pinned")}
        </Chip>
      </Group>
      {scope === "feed" && (
        <Group title={t("filter.sort")}>
          {sorts.map(([v, name]) => (
            <Chip key={v} on={sort === v} onClick={() => onChange(setOne(query, "sort", v === "newest" ? null : v))} radio>
              {label(name)}
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
              {t("filter.clear")}
            </Button>
          )}
          <Button size="small" variant="ghost-muted" iconOnly aria-label={t("filter.qualifiers")} title={t("filter.qualifiers")} onClick={onHelp}>
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

function Help({ scope, desk, onBack }: { scope: Scope; desk: boolean; onBack: () => void }) {
  const t = useT()
  const td = useDeskT()
  return (
    <div className="filter-help">
      <p className="filter-group-title">{t("filter.qualifiers")}</p>
      {help
        .filter((h) => h.scope.includes(scope))
        .map((h) => (
          <div key={h.q} className="filter-help-row">
            <code>{h.q}</code>
            <span>{label(h.text)}</span>
          </div>
        ))}
      {desk && (
        <>
          <div className="filter-help-row">
            <code>is:held</code>
            <span>{td("queue.helpHeld")}</span>
          </div>
          <div className="filter-help-row">
            <code>is:awaiting-approval</code>
            <span>{td("queue.helpApproval")}</span>
          </div>
        </>
      )}
      <p className="filter-help-note">{t("filter.helpNote")}</p>
      <div className="filter-foot">
        <span />
        <Button size="small" variant="invisible" role="menuitem" onClick={onBack}>
          {t("filter.backToFilters")}
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
