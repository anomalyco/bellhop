import type { InboxItem, InboxList, IssueSummary } from "../../shared/api"
import { api, keys } from "./api"
import { updateAll } from "./cache"

// The org inbox's query: the state (open/closed) is its own parameter; q holds the list qualifiers plus the inbox's
// own (app:, platform:, version:, meta:<key>=<value>, has:screenshot, has:email, source:) and free text. Filters
// edit q as text, one token at a time, and leave the rest alone.

export type InboxState = "open" | "closed"

const tokenRe = /(\w+):("[^"]*"|\S+)|("[^"]*"|\S+)/g
export interface Token {
  raw: string
  key: string | null
  value: string
}
export function tokens(q: string): Token[] {
  return [...q.matchAll(tokenRe)].map((m) => ({ raw: m[0], key: m[1]?.toLowerCase() ?? null, value: (m[2] ?? "").replace(/^"|"$/g, "") }))
}
const quote = (v: string) => (/[\s"]/.test(v) ? `"${v.replace(/"/g, "")}"` : v)

/** The query without the tokens `drop` matches, then `add` after the last qualifier (before free text). */
export function editQuery(q: string, drop: (t: Token) => boolean, add?: string) {
  const list = tokens(q).filter((t) => !drop(t))
  if (add) {
    const last = list.map((t) => t.key !== null).lastIndexOf(true)
    list.splice(last + 1, 0, { raw: add, key: add.split(":")[0]!, value: "" })
  }
  return list.map((t) => t.raw).join(" ")
}
export const has = (q: string, key: string, value?: string) =>
  tokens(q).some((t) => t.key === key && (value === undefined || t.value.toLowerCase() === value.toLowerCase()))
export const valueOf = (q: string, key: string) => tokens(q).find((t) => t.key === key)?.value ?? null
/** One value for `key` (replacing any), or none. */
export const setOne = (q: string, key: string, value: string | null) => editQuery(q, (t) => t.key === key, value === null ? undefined : `${key}:${quote(value)}`)
/** has:<value> and similar on/off qualifiers. */
export const toggle = (q: string, key: string, value: string) =>
  has(q, key, value) ? editQuery(q, (t) => t.key === key && t.value.toLowerCase() === value.toLowerCase()) : editQuery(q, () => false, `${key}:${value}`)

/** meta:<key>=<value> pairs in the query. */
export function metaFilters(q: string) {
  return tokens(q)
    .filter((t) => t.key === "meta" && t.value.includes("="))
    .map((t) => ({ raw: t.raw, key: t.value.slice(0, t.value.indexOf("=")), value: t.value.slice(t.value.indexOf("=") + 1) }))
}
/** The query with a meta:<key>=<value> filter added (replacing one for the same key). */
export function withMeta(q: string, key: string, value: string) {
  return editQuery(q, (t) => t.key === "meta" && t.value.startsWith(`${key}=`), `meta:${quote(`${key}=${value}`)}`)
}
/** Free text (words that aren't qualifiers). */
export const textOf = (q: string) => tokens(q).filter((t) => t.key === null).map((t) => t.raw).join(" ")

/** What the server gets: the visible query, plus app:<slug> on an app's own view. */
export const serverQuery = (q: string, app: string | null) => (app ? `app:${app} ${q}`.trim() : q.trim())

export const inboxKey = (org: string, state: InboxState, q: string) => `${keys.inbox(org)}${state}|${q}`
export const fetchInbox = (org: string, state: InboxState, q: string, cursor?: string) => api.inbox(org, { state, q: q || undefined, cursor })

/** An issue changed (a summary from the live room or an action's answer): the inbox rows that show it follow. */
export function applyInboxSummary(org: string, summary: Partial<IssueSummary> & { id: string }) {
  updateAll<InboxList>(keys.inbox(org), (list) =>
    list.items.some((i) => i.id === summary.id) ? { ...list, items: list.items.map((i) => (i.id === summary.id ? ({ ...i, ...summary } as InboxItem) : i)) } : undefined,
  )
}

/** Keyboard shortcuts never fire while typing, with a modifier held, or while a menu or dialog has focus. */
export function shortcutAllowed(e: KeyboardEvent) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return false
  const el = e.target as HTMLElement | null
  if (!el) return true
  if (el.isContentEditable || el.closest("input, textarea, select, [contenteditable=true]")) return false
  if (el.closest("[role=menu], [role=dialog], .menu-panel")) return false
  return true
}

/** "hex/12" in the URL: which feedback is open. */
export const itemParam = (i: Pick<InboxItem, "number" | "app">) => `${i.app.slug}/${i.number}`
export function parseItem(v: string | null): { slug: string; number: number } | null {
  const m = v ? /^([a-z0-9-]+)\/([1-9]\d*)$/.exec(v) : null
  return m ? { slug: m[1]!, number: Number(m[2]) } : null
}
