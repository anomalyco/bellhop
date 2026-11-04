import type {
  Activity,
  Actor,
  Attachment,
  Comment,
  FeedApp,
  FeedIssue,
  FeedList,
  Issue,
  IssueEvent,
  IssueList,
  IssueRef,
  IssueSummary,
  Member,
  Relation,
  TimelineItem
} from "../shared/api"
import { bad, choice, missing, now, rows, scopedGuestId, sql, str } from "./core"
import { appIdSQL, appKey, readBatch } from "./read-scope"
import type { ReadScope } from "./read-scope"
import { can } from "./permissions"

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
type TeamRow = { user_id: string; role: Member["role"] }
const teamQuery = (env: Env, scope: ReadScope) =>
  sql(env, `SELECT user_id,role FROM members WHERE app_id=${appIdSQL(scope)} AND user_id IS NOT NULL`, appKey(scope))
const roleMap = (team: TeamRow[]) => new Map(team.map(({ user_id, role }) => [user_id, role]))
export async function appRoles(env: Env, appId: string) {
  return roleMap(await rows<TeamRow>(teamQuery(env, appId)))
}
type Roles = Awaited<ReturnType<typeof appRoles>>
function normalizeActor(actor: Actor, roles: Roles): Actor {
  if (actor.type === "guest") actor.name ??= null
  if (actor.type === "member") actor.role = roles.get(actor.id) ?? null
  return actor
}
const parseActor = (json: string, roles: Roles) => normalizeActor(JSON.parse(json), roles)
function currentActivity(json: string | null, roles: Roles): Activity | null {
  const activity: Activity | null = json && JSON.parse(json)
  return activity && activity.expires_at > now() ? { ...activity, actor: normalizeActor(activity.actor, roles) } : null
}
export async function readPresence(env: Env, issueId: string, appId?: string, publicOnly = false) {
  const row = await sql(
    env,
    `SELECT i.activity,m.user_id,m.role,a.public FROM issues i JOIN apps a ON ${visibleIssues("a.id")} LEFT JOIN members m
    ON m.app_id=i.app_id AND m.user_id=json_extract(i.activity,'$.actor.id') WHERE i.id=? ${appId ? "AND i.app_id=?" : ""} ${publicOnly ? "AND a.public=1" : ""}`,
    issueId,
    ...(appId ? [appId] : [])
  ).first<{ activity: string | null; user_id: string | null; role: Member["role"] | null; public: number }>()
  return row
    ? {
        activity: currentActivity(row.activity, new Map(row.user_id && row.role ? [[row.user_id, row.role]] : [])),
        public: !!row.public
      }
    : null
}
function summary(r: StoredSummary, roles: Roles): IssueSummary {
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
    author: parseActor(r.author, roles),
    assignee: r.assignee ? parseActor(r.assignee, roles) : null,
    activity: currentActivity(r.activity, roles),
    labels: JSON.parse(r.labels)
  }
}
export function ref(i: IssueRef): IssueRef {
  const { id, number, title, status, close_reason } = i
  return { id, number, title, status, close_reason }
}
export async function issueSummary(env: Env, appId: string, number: number, team = appRoles(env, appId)) {
  const [r, roles] = await Promise.all([
    sql(env, `SELECT ${fields} FROM issues i WHERE i.app_id=? AND i.number=?`, appId, number).first<StoredSummary>(),
    team
  ])
  return r ? summary(r, roles) : missing()
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
const pageSize = 30
// Issue visibility within a selected workspace. Discovery additionally requires a public
// workspace; direct links intentionally do not. Add future issue-level visibility rules here.
export const visibleIssues = (workspace: string) => `i.app_id=${workspace}`
function issueFilter(workspace: string, options: { label?: unknown; query?: unknown }) {
  const where = [visibleIssues(workspace)],
    values: unknown[] = []
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
  return { where: where.join(" AND "), values }
}
export async function listIssues(
  env: Env,
  scope: ReadScope,
  options: { state?: unknown; label?: unknown; query?: unknown; cursor?: unknown; limit?: number; allStates?: boolean }
): Promise<IssueList> {
  const filter = issueFilter(appIdSQL(scope), options),
    values = [appKey(scope), ...filter.values]
  const base = ` FROM issues i WHERE ${filter.where}`
  const totals = sql(
    env,
    `SELECT count(*) FILTER (WHERE i.status!='closed') AS open,count(*) FILTER (WHERE i.status='closed') AS closed${base}`,
    ...values
  )
  const state = choice(options.state ?? "open", ["open", "closed"] as const, "state")
  const cursor = options.cursor ? issueNumber(options.cursor) : null,
    limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? pageSize)))
  const list = sql(
    env,
    `SELECT ${fields}${base} ${options.allStates ? "" : `AND i.status${state === "open" ? "!=" : "="}'closed'`} ${cursor ? "AND i.number<?" : ""} ORDER BY i.number DESC LIMIT ?`,
    ...values,
    ...(cursor ? [cursor] : []),
    limit + 1
  )
  const {
    data: [items, counts, team]
  } = await readBatch<[StoredSummary, IssueList["counts"], TeamRow]>(env, scope, [list, totals, teamQuery(env, scope)])
  const roles = roleMap(team)
  return {
    issues: items.slice(0, limit).map((r) => summary(r, roles)),
    counts: counts[0]!,
    next_cursor: items.length > limit ? String(items[limit - 1]!.number) : null
  }
}
const feedAppFields = `a.slug,a.name app_name,'/icon/'||a.slug||'/'||a.icon_version icon_url`
// Resolve the three displayed actors' roles in *their issue's* workspace, not in a global
// roster. Only enrich the bounded final page, after its global ordering and limit.
const feedFields = `${fields},${feedAppFields},(SELECT json_group_object(m.user_id,m.role) FROM members m
  WHERE m.app_id=i.app_id AND m.user_id IN (json_extract(i.author,'$.id'),json_extract(i.assignee,'$.id'),json_extract(i.activity,'$.actor.id'))) roles`
type FeedRow = StoredSummary & { slug: string; app_name: string; icon_url: string | null; roles: string }
function feedIssue(r: FeedRow): FeedIssue {
  return {
    ...summary(r, new Map(Object.entries(JSON.parse(r.roles) as Record<string, Member["role"]>))),
    app: { slug: r.slug, name: r.app_name, icon_url: r.icon_url }
  }
}
export async function publicFeedIssue(env: Env, id: string) {
  const r = await sql(
    env,
    `SELECT ${feedFields} FROM issues i JOIN apps a ON ${visibleIssues("a.id")} WHERE i.id=? AND a.public=1`,
    id
  ).first<FeedRow>()
  return r ? feedIssue(r) : null
}
export async function feed(env: Env, options: { state?: string; q?: string; cursor?: string }): Promise<FeedList> {
  const closed = Number(choice(options.state ?? "open", ["open", "closed"] as const, "state") === "closed"),
    filter = issueFilter("a.id", { query: options.q })
  let boundary = "",
    keys: string[] = []
  if (options.cursor !== undefined) {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)~([\w-]{1,80})$/.exec(options.cursor)
    if (!match) bad("Invalid feed cursor")
    boundary = "AND (i.updated_at,i.id)<(?,?)"
    keys = [match[1]!, match[2]!]
  }
  // Seek at most one page per public workspace. A global updated_at index would walk
  // arbitrarily many private issues when there are few publicly listed workspaces.
  const [page, totals] = await env.DB.batch<unknown>([
    sql(
      env,
      `WITH page AS MATERIALIZED (SELECT candidate.id,candidate.updated_at FROM apps a CROSS JOIN issues candidate
      WHERE a.public=1 AND candidate.rowid IN (SELECT i.rowid FROM issues i WHERE ${filter.where} AND (i.status='closed')=? ${boundary}
        ORDER BY i.updated_at DESC,i.id DESC LIMIT ?) ORDER BY candidate.updated_at DESC,candidate.id DESC LIMIT ?)
      SELECT ${feedFields} FROM page p JOIN issues i ON i.id=p.id JOIN apps a ON a.id=i.app_id
      ORDER BY p.updated_at DESC,p.id DESC`,
      ...filter.values,
      closed,
      ...keys,
      pageSize + 1,
      pageSize + 1
    ),
    sql(
      env,
      `SELECT count(*) FILTER(WHERE i.status!='closed') open,count(*) FILTER(WHERE i.status='closed') closed
      FROM apps a CROSS JOIN issues i WHERE a.public=1 AND ${filter.where}`,
      ...filter.values
    )
  ])
  const items = page!.results as FeedRow[],
    last = items[pageSize - 1]
  return {
    issues: items.slice(0, pageSize).map(feedIssue),
    counts: totals!.results[0] as FeedList["counts"],
    next_cursor: items.length > pageSize ? `${last!.updated_at}~${last!.id}` : null
  }
}
const latest = (closed: number) =>
  `(SELECT i.updated_at FROM issues i WHERE ${visibleIssues("a.id")} AND (i.status='closed')=${closed} ORDER BY i.updated_at DESC,i.id DESC LIMIT 1)`
export const workspaceActivitySQL = `max(a.created_at,coalesce(${latest(0)},''),coalesce(${latest(1)},''))`
export function feedApps(env: Env) {
  return rows<FeedApp>(
    sql(
      env,
      `SELECT a.slug,a.name,a.description,'/icon/'||a.slug||'/'||a.icon_version icon_url,
    (SELECT count(*) FROM issues i WHERE ${visibleIssues("a.id")} AND (i.status='closed')=0) open_count
    FROM apps a WHERE a.public=1 ORDER BY ${workspaceActivitySQL} DESC,a.slug`
    )
  )
}
export type AttachmentRow = Omit<Attachment, "url">
export function attachment(a: AttachmentRow): Attachment {
  const { id, name, mime, size, kind } = a
  return { id, name, mime, size, kind, url: `/media/${id}/${encodeURIComponent(name)}` }
}
export async function getIssue(
  env: Env,
  scope: ReadScope,
  number: number,
  viewer?: Pick<Actor, "id" | "type">,
  privileged = false
): Promise<Issue> {
  const where = `app_id=${appIdSQL(scope)} AND number=?`,
    target = `SELECT id FROM issues WHERE ${where}`,
    key = appKey(scope)
  const {
    app,
    data: [items, team, files, comments, events, relations]
  } = await readBatch<
    [
      StoredSummary & { body: string; template_id: string | null; system_info: string | null },
      TeamRow,
      AttachmentRow & { comment_id: string | null },
      Pick<Comment, "id" | "body" | "created_at" | "updated_at"> & { author: string },
      Omit<IssueEvent, "actor" | "data"> & { actor: string; data: string },
      IssueRef & { relation_id: string; type: Relation["type"]; direction: Relation["direction"] }
    ]
  >(env, scope, [
    sql(env, `SELECT ${fields},i.body,i.template_id,i.system_info FROM issues i WHERE ${where}`, key, number),
    teamQuery(env, scope),
    sql(
      env,
      `SELECT a.id,a.name,a.mime,a.size,a.kind,l.comment_id FROM attachment_links l JOIN attachments a ON a.id=l.attachment_id
      WHERE l.issue_id=(${target}) ORDER BY l.rowid`,
      key,
      number
    ),
    sql(
      env,
      `SELECT id,body,created_at,updated_at,author FROM comments WHERE issue_id=(${target}) ORDER BY created_at,rowid`,
      key,
      number
    ),
    sql(
      env,
      `SELECT id,type,actor,data,created_at FROM issue_events WHERE issue_id=(${target}) ORDER BY created_at,rowid`,
      key,
      number
    ),
    sql(
      env,
      `WITH target AS (${target}) SELECT rel.id relation_id,rel.type,CASE WHEN rel.source_id=t.id THEN 'outgoing' ELSE 'incoming' END direction,
      i.id,i.number,i.title,i.status,i.close_reason FROM target t JOIN relations rel ON rel.source_id=t.id OR rel.target_id=t.id
      JOIN issues i ON i.id=CASE WHEN rel.source_id=t.id THEN rel.target_id ELSE rel.source_id END ORDER BY rel.rowid`,
      key,
      number
    )
  ])
  const r = items[0],
    roles = roleMap(team)
  if (!r) missing()
  if (typeof scope !== "string") {
    privileged = can(app!.role, "read")
    viewer = scope.user
      ? { type: "member", id: scope.user }
      : { type: "guest", id: await scopedGuestId(scope.guest, app!.id) }
  }
  const byParent = new Map<string | null, Attachment[]>()
  for (const a of files) {
    const group = byParent.get(a.comment_id) ?? []
    group.push(attachment(a))
    byParent.set(a.comment_id, group)
  }
  const s = summary(r, roles),
    timeline: TimelineItem[] = []
  for (const c of comments) {
    const author = parseActor(c.author, roles)
    timeline.push({
      kind: "comment",
      comment: { ...c, author, by_issue_author: author.id === s.author.id, attachments: byParent.get(c.id) ?? [] }
    })
  }
  for (const e of events) {
    const data = JSON.parse(e.data)
    if (e.type === "assigned" && data.assignee) normalizeActor(data.assignee, roles)
    timeline.push({ kind: "event", event: { ...e, actor: parseActor(e.actor, roles), data } })
  }
  const time = (item: TimelineItem) => (item.kind === "event" ? item.event.created_at : item.comment.created_at)
  timeline.sort((a, b) => time(a).localeCompare(time(b)))
  return {
    ...s,
    body: r.body,
    template_id: r.template_id,
    system_info: r.system_info ? (privileged ? JSON.parse(r.system_info) : "hidden") : null,
    viewer_is_author: viewer?.type === s.author.type && viewer.id === s.author.id,
    attachments: byParent.get(null) ?? [],
    timeline,
    relations: relations.map(({ relation_id: id, direction, type, ...issue }) => ({ id, direction, type, issue }))
  }
}
export function summaryOf(issue: Issue): IssueSummary {
  const { body, template_id, system_info, viewer_is_author, attachments, timeline, relations, ...s } = issue
  return s
}
