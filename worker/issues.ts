import type {
  Activity,
  Actor,
  Attachment,
  Comment,
  Issue,
  IssueEvent,
  IssueList,
  IssueRef,
  IssueSummary,
  Relation,
  TimelineItem
} from "../shared/api"
import { bad, choice, missing, now, rows, sql, str } from "./core"

const fields = `i.id,i.number,i.title,i.status,i.close_reason,i.created_at,i.updated_at,i.author,i.assignee,i.activity,
  (SELECT count(*) FROM comments WHERE issue_id=i.id) AS comment_count,
  (SELECT json_group_array(json_object('id',l.id,'name',l.name,'color',l.color,'description',l.description))
    FROM issue_labels il JOIN labels l ON l.id=il.label_id WHERE il.issue_id=i.id ORDER BY l.name) AS labels`
type StoredSummary = Omit<IssueSummary, "author" | "assignee" | "activity" | "labels"> & {
  author: string
  assignee: string | null
  activity: string | null
  labels: string
}
function normalizeActor(actor: Actor): Actor {
  if (actor.type === "guest") actor.name ??= null
  return actor
}
const parseActor = (json: string) => normalizeActor(JSON.parse(json))
export function currentActivity(json: string | null): Activity | null {
  const activity: Activity | null = json && JSON.parse(json)
  return activity && activity.expires_at > now() ? { ...activity, actor: normalizeActor(activity.actor) } : null
}
function summary(r: StoredSummary): IssueSummary {
  const { id, number, title, status, close_reason, created_at, updated_at, comment_count } = r
  return {
    id,
    number,
    title,
    status,
    close_reason,
    created_at,
    updated_at,
    comment_count,
    author: parseActor(r.author),
    assignee: r.assignee ? parseActor(r.assignee) : null,
    activity: currentActivity(r.activity),
    labels: JSON.parse(r.labels)
  }
}
export function ref(i: IssueRef): IssueRef {
  const { id, number, title, status, close_reason } = i
  return { id, number, title, status, close_reason }
}
export async function issueSummary(env: Env, appId: string, number: number) {
  const r = await sql(
    env,
    `SELECT ${fields} FROM issues i WHERE i.app_id=? AND i.number=?`,
    appId,
    number
  ).first<StoredSummary>()
  return r ? summary(r) : missing()
}
export function issueNumber(n: unknown) {
  if (
    (typeof n !== "number" && typeof n !== "string") ||
    !/^[1-9]\d*$/.test(String(n)) ||
    !Number.isSafeInteger(Number(n))
  )
    missing()
  return Number(n)
}
export async function listIssues(
  env: Env,
  appId: string,
  options: { state?: unknown; label?: unknown; query?: unknown; cursor?: unknown; limit?: number; allStates?: boolean }
): Promise<IssueList> {
  const where = ["i.app_id=?"],
    values: unknown[] = [appId]
  if (options.label) {
    where.push(
      "EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id=il.label_id WHERE il.issue_id=i.id AND l.name=?)"
    )
    values.push(str(options.label, "label", 60))
  }
  if (options.query) {
    const words = str(options.query, "query", 512)
      .match(/[\p{L}\p{N}\p{M}_]+/gu)
      ?.slice(0, 24)
    if (words?.length) {
      const phrase = words.map((w) => `"${w}"*`).join(" AND ")
      where.push(`(i.rowid IN (SELECT rowid FROM issue_fts WHERE issue_fts MATCH ?) OR i.id IN
        (SELECT c.issue_id FROM comments c JOIN comment_fts f ON f.rowid=c.rowid WHERE comment_fts MATCH ?))`)
      values.push(phrase, phrase)
    } else where.push("0")
  }
  const base = ` FROM issues i WHERE ${where.join(" AND ")}`
  const totals = sql(
    env,
    `SELECT count(*) FILTER (WHERE i.status!='closed') AS open,count(*) FILTER (WHERE i.status='closed') AS closed${base}`,
    ...values
  )
  const state = choice(options.state ?? "open", ["open", "closed"] as const, "state")
  const cursor = options.cursor ? issueNumber(options.cursor) : null,
    limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 30)))
  const list = sql(
    env,
    `SELECT ${fields}${base} ${options.allStates ? "" : `AND i.status${state === "open" ? "!=" : "="}'closed'`} ${cursor ? "AND i.number<?" : ""} ORDER BY i.number DESC LIMIT ?`,
    ...values,
    ...(cursor ? [cursor] : []),
    limit + 1
  )
  const [items, counts] = await Promise.all([rows<StoredSummary>(list), totals.first<IssueList["counts"]>()])
  return {
    issues: items.slice(0, limit).map(summary),
    counts: counts!,
    next_cursor: items.length > limit ? String(items[limit - 1]!.number) : null
  }
}
export type AttachmentRow = Omit<Attachment, "url">
export function attachment(a: AttachmentRow): Attachment {
  const { id, name, mime, size, kind } = a
  return { id, name, mime, size, kind, url: `/media/${id}/${encodeURIComponent(name)}` }
}
export async function getIssue(
  env: Env,
  appId: string,
  number: number,
  viewer: Actor,
  privileged: boolean,
  guestId?: string
): Promise<Issue> {
  const r = await sql(
    env,
    `SELECT ${fields},i.body,i.template_id,i.system_info FROM issues i WHERE i.app_id=? AND i.number=?`,
    appId,
    number
  ).first<StoredSummary & { body: string; template_id: string | null; system_info: string | null }>()
  if (!r) missing()
  const [files, comments, events, relations] = await Promise.all([
    rows<AttachmentRow & { comment_id: string | null }>(
      sql(
        env,
        `SELECT a.id,a.name,a.mime,a.size,a.kind,l.comment_id FROM attachment_links l JOIN attachments a ON a.id=l.attachment_id WHERE l.issue_id=? ORDER BY l.rowid`,
        r.id
      )
    ),
    rows<Pick<Comment, "id" | "body" | "created_at" | "updated_at"> & { author: string }>(
      sql(
        env,
        "SELECT id,body,created_at,updated_at,author FROM comments WHERE issue_id=? ORDER BY created_at,rowid",
        r.id
      )
    ),
    rows<Omit<IssueEvent, "actor" | "data"> & { actor: string; data: string }>(
      sql(
        env,
        "SELECT id,type,actor,data,created_at FROM issue_events WHERE issue_id=? ORDER BY created_at,rowid",
        r.id
      )
    ),
    rows<IssueRef & { relation_id: string; type: Relation["type"]; direction: Relation["direction"] }>(
      sql(
        env,
        `SELECT rel.id relation_id,rel.type,CASE WHEN rel.source_id=? THEN 'outgoing' ELSE 'incoming' END direction,
      i.id,i.number,i.title,i.status,i.close_reason FROM relations rel JOIN issues i ON i.id=CASE WHEN rel.source_id=? THEN rel.target_id ELSE rel.source_id END
      WHERE rel.source_id=? OR rel.target_id=? ORDER BY rel.rowid`,
        r.id,
        r.id,
        r.id,
        r.id
      )
    )
  ])
  const byParent = new Map<string | null, Attachment[]>()
  for (const a of files) {
    const group = byParent.get(a.comment_id) ?? []
    group.push(attachment(a))
    byParent.set(a.comment_id, group)
  }
  const s = summary(r),
    timeline: TimelineItem[] = []
  for (const c of comments) {
    const author = parseActor(c.author)
    timeline.push({
      kind: "comment",
      comment: { ...c, author, by_issue_author: author.id === s.author.id, attachments: byParent.get(c.id) ?? [] }
    })
  }
  for (const e of events)
    timeline.push({ kind: "event", event: { ...e, actor: parseActor(e.actor), data: JSON.parse(e.data) } })
  const time = (item: TimelineItem) => (item.kind === "event" ? item.event.created_at : item.comment.created_at)
  timeline.sort((a, b) => time(a).localeCompare(time(b)))
  return {
    ...s,
    body: r.body,
    template_id: r.template_id,
    system_info: r.system_info ? (privileged ? JSON.parse(r.system_info) : "hidden") : null,
    viewer_is_author: viewer.id === s.author.id || guestId === s.author.id,
    attachments: byParent.get(null) ?? [],
    timeline,
    relations: relations.map(({ relation_id: id, direction, type, ...issue }) => ({ id, direction, type, issue }))
  }
}
export function summaryOf(issue: Issue): IssueSummary {
  const { body, template_id, system_info, viewer_is_author, attachments, timeline, relations, ...s } = issue
  return s
}
