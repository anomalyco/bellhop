import type { Activity, Actor, AppDetail, Issue, IssueList, IssueRef, IssueSummary, TimelineItem } from "../../shared/api"
import type { VisibleState } from "../ui/primitives"
import { api, keys } from "./api"
import { entries, load, peek, prefetch, setData, updateAll } from "./cache"

export interface Filter {
  state: "open" | "closed"
  label: string
  text: string
}

const token = /(\w+):("[^"]*"|\S+)|("[^"]*"|\S+)/g

/** Parses GitHub-style search: `is:open`, `is:closed`, `label:bug` or `label:"needs info"`, then free text. */
export function parseQuery(q: string): Filter {
  const filter: Filter = { state: "open", label: "", text: "" }
  const words: string[] = []
  for (const m of q.matchAll(token)) {
    const [, key, value, word] = m
    const unquoted = (value ?? "").replace(/^"|"$/g, "")
    if (key === "is" && (unquoted === "open" || unquoted === "closed")) filter.state = unquoted
    else if (key === "label") filter.label = unquoted
    else words.push(word ?? m[0])
  }
  filter.text = words.join(" ")
  return filter
}

export function formatQuery(f: Filter) {
  const parts = [`is:${f.state}`]
  if (f.label) parts.push(`label:${/\s/.test(f.label) ? `"${f.label}"` : f.label}`)
  if (f.text) parts.push(f.text)
  return parts.join(" ")
}

export const listKey = (slug: string, f: Filter) => `${keys.lists(slug)}${f.state}|${f.label}|${f.text}`

export function visibleState(issue: Pick<IssueRef, "status" | "close_reason">): VisibleState {
  if (issue.status !== "closed") return issue.status
  return issue.close_reason === "completed" || !issue.close_reason ? "closed" : "not_planned"
}

export function stateText(issue: Pick<IssueRef, "status" | "close_reason">) {
  if (issue.status === "closed" && issue.close_reason === "duplicate") return "Duplicate"
  return undefined
}

function matches(issue: IssueSummary, key: string, slug: string, anyState = false) {
  const [state, label, text] = key.slice(keys.lists(slug).length).split("|")
  if (!anyState && (issue.status === "closed") !== (state === "closed")) return false
  if (label && !issue.labels.some((l) => l.name.toLowerCase() === label.toLowerCase())) return false
  if (text && !issue.title.toLowerCase().includes(text.toLowerCase())) return false
  return true
}

function summaryOf(issue: Issue | IssueSummary): IssueSummary {
  const { id, number, title, status, close_reason, labels, author, assignee, comment_count, created_at, updated_at, activity } = issue
  return { id, number, title, status, close_reason, labels, author, assignee, comment_count, created_at, updated_at, activity }
}

function bumpCounts(slug: string, from: IssueSummary["status"] | null, issue: IssueSummary) {
  const to = issue.status
  const side = (s: IssueSummary["status"]) => (s === "closed" ? "closed" : "open")
  if (from && side(from) === side(to)) return
  const apply = (c: { open: number; closed: number }) => {
    const next = { ...c }
    if (from) next[side(from)] = Math.max(0, next[side(from)] - 1)
    next[side(to)]++
    return next
  }
  updateAll<IssueList>(keys.lists(slug), (list, key) =>
    matches(issue, key, slug, true) ? { ...list, counts: apply(list.counts) } : undefined,
  )
  setData<AppDetail>(keys.app(slug), (app) => (app ? { ...app, counts: apply(app.counts) } : app))
}

/** Keeps every cached list of the app and the cached issue in step with one changed issue. */
export function applySummary(slug: string, summary: IssueSummary, created = false) {
  const previous =
    peek<Issue>(keys.issue(slug, summary.number)) ??
    entries<IssueList>(keys.lists(slug))
      .flatMap(([, l]) => l.issues)
      .find((i) => i.id === summary.id)
  if (created || previous) bumpCounts(slug, created ? null : (previous?.status ?? null), summary)

  updateAll<IssueList>(keys.lists(slug), (list, key) => {
    const at = list.issues.findIndex((i) => i.id === summary.id)
    const fits = matches(summary, key, slug)
    if (at >= 0 && !fits) return { ...list, issues: list.issues.filter((i) => i.id !== summary.id) }
    if (at >= 0) return { ...list, issues: list.issues.map((i) => (i.id === summary.id ? summary : i)) }
    if (!fits) return undefined
    // Lists are newest first; only insert when the issue falls within the loaded range.
    const last = list.issues[list.issues.length - 1]
    if (list.next_cursor && last && summary.number < last.number) return undefined
    const issues = [...list.issues, summary].sort((a, b) => b.number - a.number)
    return { ...list, issues }
  })
  setData<Issue>(keys.issue(slug, summary.number), (issue) => (issue ? { ...issue, ...summary } : issue))
}

const sameActivity = (a: Activity | null, b: Activity | null) =>
  a === b ||
  (!!a &&
    !!b &&
    a.actor.id === b.actor.id &&
    a.actor.type === b.actor.type &&
    a.text === b.text &&
    a.expires_at === b.expires_at)

export function applyActivity(slug: string, issueId: string, activity: Activity | null) {
  updateAll<IssueList>(keys.lists(slug), (list) => {
    const hit = list.issues.find((i) => i.id === issueId)
    return hit && !sameActivity(hit.activity, activity)
      ? { ...list, issues: list.issues.map((i) => (i.id === issueId ? { ...i, activity } : i)) }
      : undefined
  })
  updateAll<Issue>(`issue:${slug}:`, (issue) =>
    issue.id === issueId && !sameActivity(issue.activity, activity) ? { ...issue, activity } : undefined,
  )
}

const itemId = (item: TimelineItem) => (item.kind === "comment" ? item.comment.id : item.event.id)

export function appendTimeline(slug: string, number: number, item: TimelineItem) {
  setData<Issue>(keys.issue(slug, number), (issue) => {
    if (!issue || issue.timeline.some((t) => itemId(t) === itemId(item))) return undefined
    const isComment = item.kind === "comment"
    const next = {
      ...issue,
      timeline: [...issue.timeline, item],
      comment_count: issue.comment_count + (isComment ? 1 : 0),
      // A posted comment ends the author's activity on the server too.
      activity: isComment && issue.activity?.actor.id === item.comment.author.id ? null : issue.activity,
    }
    return next
  })
  const issue = peek<Issue>(keys.issue(slug, number))
  if (issue && item.kind === "comment") applySummary(slug, summaryOf(issue))
}

/** Replaces the cached issue with a server response and spreads its summary to the lists. */
export function storeIssue(slug: string, issue: Issue) {
  setData<Issue>(keys.issue(slug, issue.number), issue)
  applySummary(slug, summaryOf(issue))
}

export function findSummary(slug: string, number: number): IssueSummary | undefined {
  for (const [, list] of entries<IssueList>(keys.lists(slug))) {
    const hit = list.issues.find((i) => i.number === number)
    if (hit) return hit
  }
  return undefined
}

export function prefetchIssue(slug: string, number: number) {
  prefetch(keys.issue(slug, number), () => api.issue(slug, number))
}

export function prefetchList(slug: string, filter: Filter) {
  prefetch(listKey(slug, filter), () => api.issues(slug, { state: filter.state, label: filter.label, q: filter.text }))
}

const isActor = (v: unknown): v is Actor =>
  !!v && typeof v === "object" && "id" in v && "type" in v && ["guest", "member", "agent"].includes((v as Actor).type)

/**
 * `actor.updated`: a guest renamed, or their posts moved to an account. Swaps that actor in every cached list and
 * issue (authors, assignees, activity, comments, events and actors inside event data), keeping untouched objects
 * as they are so nothing re-renders that didn't change. Refreshes `me` when it's this browser's own guest.
 */
export function applyActorUpdate(slug: string, previousId: string, actor: Actor) {
  const swap = <T extends Actor | null>(a: T): T => (a && a.id === previousId ? (actor as T) : a)
  const swapActivity = (a: Activity | null) => (a && a.actor.id === previousId ? { ...a, actor } : a)
  const swapSummary = <T extends IssueSummary>(i: T): T => {
    const author = swap(i.author)
    const assignee = swap(i.assignee)
    const activity = swapActivity(i.activity)
    return author === i.author && assignee === i.assignee && activity === i.activity ? i : { ...i, author, assignee, activity }
  }
  const swapItem = (t: TimelineItem): TimelineItem => {
    if (t.kind === "comment") {
      const author = swap(t.comment.author)
      return author === t.comment.author ? t : { kind: "comment", comment: { ...t.comment, author } }
    }
    const e = t.event
    let data = e.data
    for (const [k, v] of Object.entries(e.data)) if (isActor(v) && v.id === previousId) data = { ...data, [k]: actor }
    const by = swap(e.actor)
    return by === e.actor && data === e.data ? t : { kind: "event", event: { ...e, actor: by, data } }
  }

  updateAll<IssueList>(keys.lists(slug), (list) => {
    const issues = list.issues.map(swapSummary)
    return issues.some((i, n) => i !== list.issues[n]) ? { ...list, issues } : undefined
  })
  updateAll<Issue>(`issue:${slug}:`, (issue) => {
    const next = swapSummary(issue)
    const timeline = issue.timeline.map(swapItem)
    const changed = timeline.some((t, n) => t !== issue.timeline[n])
    if (next === issue && !changed) return undefined
    return { ...next, timeline: changed ? timeline : issue.timeline }
  })

  const me = peek<{ guest: { id: string } }>(keys.me)
  if (me?.guest.id === previousId) {
    load(keys.me, api.me).catch(() => {})
    load(keys.app(slug), () => api.app(slug)).catch(() => {})
  }
}
