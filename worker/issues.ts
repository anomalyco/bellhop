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
  Mention,
  IssueSort,
  Moderation,
  Relation,
  TimelineItem
} from "../shared/api"
import { ApiFailure, appUrl, bad, choice, fail, missing, now, rows, scopedGuestId, sql, str } from "./core"
import {
  actorIds,
  owns,
  includesComment,
  actorBindings,
  commentView,
  gateOf,
  outsider,
  sees,
  visibleSQL,
  type Viewer
} from "./visibility"
import { mentionables, voteCount } from "./conversation"
import { parseSearch, sorts } from "./search"
import { projectTiers, tierBag } from "./tier-actors"
import { appIdSQL, appKey, readBatch, type Read } from "./read-scope"
import type { ReadScope } from "./read-scope"
import { can } from "./permissions"
import { reportQuery, decodeReport, type ReportRow } from "./report-data"
import { contactQuery, proofQuery, verification, requesterActor, type ContactRow, type ProofRow } from "./helpdesk-data"
import { requestJson, typeInfo } from "./request-types"

const viewerCTE = "viewer AS (SELECT ? voter,? ids)"
const viewerArgs = (v: Viewer) => [v.voter ?? v.actorId, JSON.stringify(actorIds(v))]
const fields = (
  team: boolean,
  personal = true,
  full = false
) => `i.id,i.number,i.title,i.status,i.close_reason,i.created_at,i.updated_at,i.author,i.assignee,i.activity,i.private,i.hidden,i.locked,i.pinned,i.reporter_locale,
  ${team ? tierBag("i.app_id", ["i.author", "i.assignee", "json_extract(i.activity,'$.actor')", "json_extract(i.hidden,'$.by')"], full ? "i.mentions" : undefined) : "NULL"} tier_bag,
  ${voteCount(team ? "1" : "0", personal ? "(SELECT ids FROM viewer)" : "'[]'")} votes,
  ${personal ? "EXISTS(SELECT 1 FROM issue_votes WHERE issue_id=i.id AND voter=(SELECT voter FROM viewer))" : "0"} viewer_voted,
  (SELECT count(*) FROM comments WHERE issue_id=i.id ${team ? "" : "AND internal=0"}) AS comment_count,
  (SELECT json_group_array(json_object('id',l.id,'name',l.name,'color',l.color,'description',l.description))
    FROM issue_labels il JOIN labels l ON l.id=il.label_id WHERE il.issue_id=i.id ORDER BY l.name) AS labels`
type StoredSummary = Omit<
  IssueSummary,
  "author" | "assignee" | "activity" | "labels" | "private" | "hidden" | "locked" | "pinned" | "viewer_voted"
> & {
  locked: number
  pinned: number
  viewer_voted: number
  private: number
  hidden: string | null
  author: string
  assignee: string | null
  activity: string | null
  labels: string
  tier_bag: string | null
  reporter_locale: Issue["reporter_locale"]
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
export const parseActor = (json: string, roles: Roles) => normalizeActor(JSON.parse(json), roles)
const parseMentions = (json: string, roles: Roles) =>
  (JSON.parse(json) as Mention[]).map((m) => ({ ...m, actor: normalizeActor(m.actor, roles) }))
function moderation(json: string | null, roles: Roles): Moderation | null {
  if (!json) return null
  const m: Moderation = JSON.parse(json)
  return { ...m, by: m.by ? normalizeActor(m.by, roles) : null }
}
function currentActivity(json: string | null, roles: Roles): Activity | null {
  const activity: Activity | null = json && JSON.parse(json)
  return activity && activity.expires_at > now() ? { ...activity, actor: normalizeActor(activity.actor, roles) } : null
}
export async function readPresence(env: Env, issueId: string, appId?: string, publicOnly = false) {
  const row = await sql(
    env,
    `SELECT i.activity,i.private,i.hidden IS NOT NULL hidden,json_extract(i.author,'$.id') reporter,m.user_id,m.role,(a.public=1 AND (${visibleSQL(outsider)})) public FROM issues i JOIN apps a ON i.app_id=a.id LEFT JOIN members m
    ON m.app_id=i.app_id AND m.user_id=json_extract(i.activity,'$.actor.id') WHERE i.id=? ${appId ? "AND i.app_id=?" : ""} ${publicOnly ? `AND a.public=1 AND ${visibleSQL(outsider)}` : ""}`,
    issueId,
    ...(appId ? [appId] : [])
  ).first<{
    activity: string | null
    user_id: string | null
    role: Member["role"] | null
    public: number
    private: number
    hidden: number
    reporter: string
  }>()
  return row
    ? {
        activity: currentActivity(row.activity, new Map(row.user_id && row.role ? [[row.user_id, row.role]] : [])),
        public: !!row.public,
        gate: { private: !!row.private, hidden: !!row.hidden, reporter: row.reporter }
      }
    : null
}
function summary(r: StoredSummary, roles: Roles): IssueSummary {
  const { id, number, title, status, close_reason, created_at, updated_at, comment_count } = r
  return projectTiers(
    {
      id,
      number,
      title,
      status,
      close_reason,
      created_at,
      updated_at,
      comment_count,
      votes: r.votes,
      viewer_voted: !!r.viewer_voted,
      pinned: !!r.pinned,
      locked: !!r.locked,
      private: !!r.private,
      hidden: moderation(r.hidden, roles),
      author: parseActor(r.author, roles),
      assignee: r.assignee ? parseActor(r.assignee, roles) : null,
      activity: currentActivity(r.activity, roles),
      labels: JSON.parse(r.labels)
    },
    r.tier_bag ? JSON.parse(r.tier_bag) : undefined
  )
}
// Issue detail, agent lists and webhook snapshots carry the reporter's language.
// Public discovery and ordinary list summaries keep their existing projections.
function reporterSummary(r: StoredSummary, roles: Roles) {
  return { ...summary(r, roles), reporter_locale: r.reporter_locale }
}
export function ref(i: IssueRef): IssueRef {
  const { id, number, title, status, close_reason } = i
  return { id, number, title, status, close_reason }
}
export async function issueSummary(
  env: Env,
  appId: string,
  number: number,
  team = appRoles(env, appId),
  v: Viewer = { team: true, actorId: null }
) {
  const [r, roles] = await Promise.all([
    sql(
      env,
      `WITH ${viewerCTE} SELECT ${fields(v.team)} FROM issues i WHERE i.app_id=? AND i.number=?`,
      ...viewerArgs(v),
      appId,
      number
    ).first<StoredSummary>(),
    team
  ])
  return r ? reporterSummary(r, roles) : missing()
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
export const visibleIssues = (workspace: string, v: Viewer = outsider) => `i.app_id=${workspace} AND ${visibleSQL(v)}`
export const myAuthorFilter = (q: unknown) => parseSearch(q).terms.some((t) => t.key === "author" && t.value === "@me")
function issueFilter(
  workspace: string,
  options: { label?: unknown; query?: unknown },
  v: Viewer = outsider,
  parsed = parseSearch(options.query),
  handles: Map<string, string> = new Map(),
  feedUser?: string | null,
  feedIds: string[] = []
) {
  const where = [visibleIssues(workspace, v)],
    values: unknown[] = [...actorBindings(v)]
  if (options.label) {
    where.push(
      "EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id=il.label_id WHERE il.issue_id=i.id AND l.name=?)"
    )
    values.push(str(options.label, "label", 60))
  }
  for (const { key, value } of parsed.terms) {
    switch (key) {
      case "is":
        if (value === "hidden") {
          if (v.team) where.push("i.hidden IS NOT NULL")
        } else if (value === "closed" || value === "open")
          where.push(`(i.status='closed')=${value === "closed" ? 1 : 0}`)
        else where.push(`i.${value}=1`)
        break
      case "reason":
      case "status":
        where.push(`i.${key === "reason" ? "close_reason" : "status"}=?`)
        values.push(value)
        break
      case "label":
        where.push(
          `EXISTS(SELECT 1 FROM issue_labels il WHERE il.issue_id=i.id AND il.label_id=(SELECT l.id FROM labels l WHERE l.app_id=i.app_id AND l.name=?))`
        )
        values.push(value)
        break
      case "no":
        where.push(
          value === "label"
            ? "NOT EXISTS(SELECT 1 FROM issue_labels il WHERE il.issue_id=i.id)"
            : "json_extract(i.assignee,'$.id') IS NULL"
        )
        break
      case "author":
      case "assignee":
        if (value === "@me") {
          where.push(`json_extract(i.${key},'$.id') IN (SELECT value FROM json_each(?))`)
          values.push(JSON.stringify(actorIds(v)))
          if (key === "author" && !parsed.terms.some((t) => t.key === "is" && t.value === "hidden" && v.team))
            where.push("i.hidden IS NULL")
        } else if (key === "author" && /^@?guest-[a-f0-9]{4}$/.test(value)) {
          // Guests have a workspace-scoped public handle but aren't mentionable team members.
          where.push(
            "(json_extract(i.author,'$.id')=? OR (json_extract(i.author,'$.type')='guest' AND json_extract(i.author,'$.handle')=?))"
          )
          const handle = value.replace(/^@/, "")
          values.push(handles.get(handle) ?? null, handle)
        } else {
          where.push(`json_extract(i.${key},'$.id')=?`)
          values.push(handles.get(value.replace(/^@/, "")) ?? null)
        }
        break
      case "has": {
        // The existence of diagnostics on someone else's post (especially an internal note)
        // is not public. Use the same post-author/parent visibility as Issue.metadata.
        const check = v.team
          ? "1"
          : `${feedUser ? "EXISTS(SELECT 1 FROM members m WHERE m.app_id=i.app_id AND m.user_id=?) OR " : ""}(i.hidden IS NULL AND (c.id IS NULL OR (c.internal=0 AND c.hidden IS NULL)) AND json_extract(coalesce(c.author,i.author),'$.id') IN(SELECT value FROM json_each(?)))`
        where.push(
          `EXISTS(SELECT 1 FROM report_metadata md LEFT JOIN comments c ON c.id=md.comment_id WHERE md.issue_id=i.id AND md.app_id=i.app_id AND md.ready=1 AND (${check}))`
        )
        if (!v.team) {
          if (feedUser) values.push(feedUser)
          values.push(JSON.stringify(feedUser !== undefined ? feedIds : actorIds(v)))
        }
        break
      }
    }
  }
  if (parsed.text) {
    const query = parsed.text
    const words = query.match(/[\p{L}\p{N}\p{M}_]+/gu)?.slice(0, 24)
    if (words?.length) {
      const phrase = words.map((w) => `"${w}"*`).join(" AND ")
      where.push(`(i.rowid IN (SELECT rowid FROM issue_fts WHERE issue_fts MATCH ?) OR i.id IN
        (SELECT c.issue_id FROM comments c JOIN comment_fts f ON f.rowid=c.rowid WHERE comment_fts MATCH ? ${v.team ? "" : "AND c.hidden IS NULL AND c.internal=0"}))`)
      values.push(phrase, phrase)
    } else where.push("0")
  }
  return { where: where.join(" AND "), values }
}
export async function listIssues(
  env: Env,
  scope: ReadScope,
  options: {
    state?: unknown
    label?: unknown
    query?: unknown
    cursor?: unknown
    limit?: number
    allStates?: boolean
    sort?: unknown
    requesterDetails?: boolean
    contactId?: string
  },
  viewer: Viewer = outsider,
  read?: Read
): Promise<IssueList> {
  const parsed = parseSearch(options.query),
    mine = parsed.terms.some((t) => t.key === "author" && t.value === "@me"),
    needsHandles = parsed.terms.some((t) => (t.key === "author" || t.key === "assignee") && t.value !== "@me"),
    handles = needsHandles
      ? new Map(
          (
            await mentionables(
              env,
              typeof scope === "string"
                ? scope
                : ((await sql(env, "SELECT id FROM apps WHERE slug=?", scope.slug).first<string>("id")) ?? missing())
            )
          ).map((m) => [m.handle, m.id])
        )
      : new Map<string, string>(),
    filter = issueFilter(appIdSQL(scope), options, viewer, parsed, handles),
    values = [appKey(scope), ...filter.values]
  if (options.contactId) {
    filter.where += " AND json_extract(i.author,'$.id')=?"
    values.push(options.contactId)
    filter.values.push(options.contactId)
  }
  const base = ` FROM issues i WHERE ${filter.where}`
  const totals = sql(
    env,
    `SELECT count(*) FILTER (WHERE i.status!='closed') AS open,count(*) FILTER (WHERE i.status='closed') AS closed${base}`,
    ...values
  )
  const state = parsed.tab ?? choice(options.state ?? "open", ["open", "closed"] as const, "state")
  const sort = parsed.sort ?? choice(options.sort ?? "newest", sorts, "sort"),
    limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? pageSize)))
  const metric =
      sort === "votes" ? "votes" : sort === "comments" ? "comment_count" : sort === "updated" ? "updated_at" : "number",
    asc = sort === "oldest"
  let boundary = "",
    cursorArgs: unknown[] = []
  if (options.cursor !== undefined) {
    if (metric === "number") {
      boundary = `AND number${asc ? ">" : "<"}?`
      cursorArgs = [issueNumber(options.cursor)]
    } else {
      const parts = str(options.cursor, "cursor", 100).split("~")
      if (
        parts.length !== 3 ||
        parts[0] !== sort ||
        !(sort === "updated" ? /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/ : /^\d+$/).test(parts[1]!)
      )
        bad("Invalid issue cursor")
      boundary = `AND (${metric},number)<(?,?)`
      cursorArgs = [sort === "updated" ? parts[1] : Number(parts[1]), issueNumber(parts[2])]
    }
  }
  const formCols = options.requesterDetails && viewer.team ? `,${requestJson(true)} request_info` : ""
  const list = sql(
    env,
    `WITH ${viewerCTE} SELECT * FROM (SELECT ${fields(viewer.team)}${formCols}${base} ${options.allStates ? "" : `AND i.status${state === "open" ? "!=" : "="}'closed'`}) WHERE 1 ${boundary} ORDER BY ${metric} ${asc ? "ASC" : "DESC"}${metric === "number" ? "" : ",number DESC"} LIMIT ?`,
    ...viewerArgs(viewer),
    ...values,
    ...cursorArgs,
    limit + 1
  )
  const {
    data: [items, counts, team, pins]
  } = await readBatch<[StoredSummary, IssueList["counts"], TeamRow, StoredSummary]>(
    env,
    scope,
    [
      list,
      totals,
      teamQuery(env, scope),
      sql(
        env,
        `WITH ${viewerCTE} SELECT ${fields(viewer.team)}${formCols} FROM issues i WHERE i.pinned=1 AND ${mine ? filter.where : visibleIssues(appIdSQL(scope), viewer)} ORDER BY i.number DESC LIMIT ?`,
        ...viewerArgs(viewer),
        appKey(scope),
        ...(mine ? filter.values : actorBindings(viewer)),
        options.cursor === undefined ? 3 : 0
      )
    ],
    read
  )
  const roles = roleMap(team),
    project = options.requesterDetails ? reporterSummary : summary
  const visible = items.slice(0, limit),
    extra = new Map<string, { contact: Issue["contact"]; verifications: Issue["verifications"] }>()
  if (viewer.team && options.requesterDetails && typeof scope === "string") {
    const ids = JSON.stringify([...new Set([...visible, ...pins].map((i) => i.id))])
    const [cs, vs] = await env.DB.batch([
      contactQuery(env, scope, "SELECT value FROM json_each(?)", ids),
      proofQuery(env, scope, "SELECT value FROM json_each(?)", ids)
    ])
    for (const i of [...visible, ...pins]) extra.set(i.id, { contact: null, verifications: [] })
    for (const { issue_id, ...c } of cs!.results as ContactRow[]) extra.get(issue_id)!.contact = c
    for (const v of vs!.results as ProofRow[]) extra.get(v.issue_id)!.verifications.push(verification(v))
  }
  const item = (r: StoredSummary & { request_info?: string | null }) => ({
    ...project(r, roles),
    ...extra.get(r.id),
    ...(options.requesterDetails && viewer.team ? typeInfo(r.request_info ?? null) : {})
  })
  return {
    issues: visible.map(item),
    pinned: pins.map(item),
    counts: counts[0]!,
    next_cursor:
      items.length > limit
        ? (metric === "number" ? "" : `${sort}~${items[limit - 1]![metric]}~`) + items[limit - 1]!.number
        : null
  }
}
const feedAppFields = `a.slug,a.name app_name,'/icon/'||a.slug||'/'||a.icon_version icon_url`
// Resolve the three displayed actors' roles in *their issue's* workspace, not in a global
// roster. Only enrich the bounded final page, after its global ordering and limit.
const feedFields = (
  personal = false
) => `${fields(false, personal)},${feedAppFields},(SELECT json_group_object(m.user_id,m.role) FROM members m
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
    `SELECT ${feedFields()} FROM issues i JOIN apps a ON ${visibleIssues("a.id")} WHERE i.id=? AND a.public=1`,
    id
  ).first<FeedRow>()
  return r ? feedIssue(r) : null
}
export async function feed(
  env: Env,
  options: { state?: string; q?: string; cursor?: string },
  voter: string | null | { sessionHash: string; guest: string; user: Promise<{ id: string } | null> } = null,
  reportIds?: string[],
  guestCookie?: string | null,
  read?: Read,
  reportApp?: string
): Promise<FeedList> {
  const parsed = parseSearch(options.q, true),
    sort = parsed.sort ?? "updated",
    // A page already has a session lookup in flight. Ordinary feed rows only need
    // its voter ID, so resolve it in the same SELECT rather than waiting a D1 trip.
    // The metadata filter also needs scoped actor IDs; use the verified user there.
    deferred = voter && typeof voter === "object" ? voter : null,
    metadata = parsed.terms.some((t) => t.key === "has"),
    voterId =
      typeof voter === "string"
        ? voter
        : deferred
          ? ((metadata ? (await deferred.user)?.id : null) ?? deferred.guest)
          : null,
    lookup = deferred && !metadata,
    user = voterId && !voterId.startsWith("g:") ? voterId : null,
    ids = user ? [user] : []
  if (!user && guestCookie && metadata) {
    // Derive scoped IDs only for publishable report-bearing guest posts, including moved
    // issues. Never widen the feed's public issue gate, even for team/account viewers.
    const origins = await rows<{ id: string }>(
      sql(
        env,
        `WITH eligible AS (SELECT DISTINCT i.id,i.app_id FROM report_metadata md JOIN issues i ON i.id=md.issue_id JOIN apps a ON a.id=i.app_id LEFT JOIN comments c ON c.id=md.comment_id WHERE a.public=1 AND i.private=0 AND i.hidden IS NULL AND (c.id IS NULL OR (c.hidden IS NULL AND c.internal=0)) AND json_extract(coalesce(c.author,i.author),'$.type')='guest') SELECT app_id id FROM eligible UNION SELECT mv.from_app FROM eligible e JOIN issue_moves mv ON mv.issue_id=e.id`
      )
    )
    ids.push(...(await Promise.all(origins.map((o) => scopedGuestId(guestCookie, o.id)))))
  }
  const closed = Number(
      (parsed.tab ?? choice(options.state ?? "open", ["open", "closed"] as const, "state")) === "closed"
    ),
    filter = reportIds
      ? {
          where:
            "i.hidden IS NULL AND json_extract(i.author,'$.id') IN (SELECT value FROM json_each(?)) AND " +
            (reportApp ? "i.app_id=?" : "i.app_id IN (SELECT id FROM apps WHERE mode='tracker')"),
          values: [JSON.stringify(reportIds), ...(reportApp ? [reportApp] : [])]
        }
      : issueFilter("a.id", { query: options.q }, outsider, parsed, undefined, user, ids)
  let boundary = "",
    keys: string[] = []
  if (options.cursor !== undefined) {
    const parts = options.cursor.split("~")
    if (sort !== "updated" && parts.shift() !== sort) bad("Invalid feed cursor")
    const match = (
      sort === "votes" || sort === "comments"
        ? /^(\d+)~([\w-]{1,80})$/
        : /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)~([\w-]{1,80})$/
    ).exec(parts.join("~"))
    if (!match) bad("Invalid feed cursor")
    boundary =
      sort === "updated" ? "AND (i.updated_at,i.id)<(?,?)" : `AND (sort_key,i.id)${sort === "oldest" ? ">" : "<"}(?,?)`
    keys = [match[1]!, match[2]!]
  }
  // Personal discovery starts at the indexed author IDs, not the workspace directory.
  // Public discovery seeks one page per listed workspace so private backlogs don't dominate it.
  const direction = sort === "oldest" ? "ASC" : "DESC",
    metric =
      sort === "comments"
        ? `(SELECT count(*) FROM comments WHERE issue_id=i.id AND internal=0)`
        : sort === "votes"
          ? voteCount("0", "'[]'")
          : "i.created_at"
  const candidates =
    sort !== "updated"
      ? `SELECT i.id,${metric} sort_key FROM apps a JOIN issues i ON i.app_id=a.id WHERE a.public=1 AND ${filter.where} AND (i.status='closed')=? ${boundary} ORDER BY sort_key ${direction},i.id ${direction} LIMIT ?`
      : reportIds
        ? `SELECT i.id,i.updated_at FROM issues i WHERE ${filter.where} AND (i.status='closed')=? ${boundary}
      ORDER BY i.updated_at DESC,i.id DESC LIMIT ?`
        : `SELECT candidate.id,candidate.updated_at FROM apps a CROSS JOIN issues candidate
      WHERE a.public=1 AND candidate.rowid IN (SELECT i.rowid FROM issues i WHERE ${filter.where} AND (i.status='closed')=? ${boundary}
        ORDER BY i.updated_at DESC,i.id DESC LIMIT ?) ORDER BY candidate.updated_at DESC,candidate.id DESC LIMIT ?`
  const queries = [
    sql(
      env,
      `WITH ${lookup ? "viewer AS (SELECT coalesce((SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?),?) voter,? ids)" : viewerCTE}, page AS MATERIALIZED (${candidates})
      SELECT ${feedFields(true)}${sort === "updated" ? "" : ",p.sort_key"} FROM page p JOIN issues i ON i.id=p.id JOIN apps a ON a.id=i.app_id
      ORDER BY p.${sort === "updated" ? "updated_at" : "sort_key"} ${direction},p.id ${direction}`,
      ...(lookup ? [deferred.sessionHash, now()] : []),
      voterId,
      JSON.stringify(reportIds ?? []),
      ...filter.values,
      closed,
      ...keys.map((s, i) => (i === 0 && (sort === "comments" || sort === "votes") ? Number(s) : s)),
      ...(reportIds || sort !== "updated" ? [] : [pageSize + 1]),
      pageSize + 1
    ),
    sql(
      env,
      `SELECT count(*) FILTER(WHERE i.status!='closed') open,count(*) FILTER(WHERE i.status='closed') closed
      FROM ${reportIds ? "issues i WHERE" : "apps a CROSS JOIN issues i WHERE a.public=1 AND"} ${filter.where}`,
      ...filter.values
    )
  ]
  const [page, totals] = await (read ? read(queries) : env.DB.batch(queries))
  const items = page!.results as (FeedRow & { sort_key?: number | string })[],
    last = items[pageSize - 1]
  return {
    issues: items.slice(0, pageSize).map(feedIssue),
    counts: totals!.results[0] as FeedList["counts"],
    next_cursor:
      items.length > pageSize
        ? `${sort === "updated" ? last!.updated_at : `${sort}~${last!.sort_key}`}~${last!.id}`
        : null
  }
}
const latest = (closed: number) =>
  `(SELECT i.updated_at FROM issues i WHERE ${visibleIssues("a.id")} AND (i.status='closed')=${closed} ORDER BY i.updated_at DESC,i.id DESC LIMIT 1)`
export const workspaceActivitySQL = `max(a.created_at,coalesce(${latest(0)},''),coalesce(${latest(1)},''))`
export async function feedApps(env: Env, read?: Read) {
  const q = sql(
    env,
    `SELECT a.slug,a.name,a.description,'/icon/'||a.slug||'/'||a.icon_version icon_url,
    (SELECT count(*) FROM issues i WHERE ${visibleIssues("a.id")} AND (i.status='closed')=0) open_count
    FROM apps a WHERE a.public=1 ORDER BY ${workspaceActivitySQL} DESC,a.slug`
  )
  return read ? ((await read([q]))[0]!.results as FeedApp[]) : rows<FeedApp>(q)
}
export type AttachmentRow = Omit<Attachment, "url">
export function attachment(a: AttachmentRow): Attachment {
  const { id, name, mime, size, kind } = a
  return { id, name, mime, size, kind, url: `/media/${id}/${encodeURIComponent(name)}` }
}
export async function getIssue(
  env: Env,
  scope: string,
  number: number,
  v: Viewer = outsider,
  moved?: { origin: string; viewer: (slug: string) => Promise<Viewer | null> },
  read?: Read
): Promise<Issue> {
  const where = `app_id=${appIdSQL(scope)} AND number=?`,
    target = `SELECT id FROM issues WHERE ${where}`,
    key = appKey(scope)
  const {
    data: [items, team, files, comments, events, relations, reports, contacts, proofs]
  } = await readBatch<
    [
      StoredSummary & {
        request_info: string | null
        body: string
        github_repo: string | null
        github_number: number | null
        template_id: string | null
        system_info: string | null
        edited_at: string | null
        mentions: string
      },
      TeamRow,
      AttachmentRow & { comment_id: string | null },
      Pick<Comment, "id" | "body" | "created_at" | "updated_at" | "edited_at" | "via"> & {
        author: string
        hidden: string | null
        internal: number
        helpful: number
        viewer_helpful: number
        tier_bag: string | null
        mentions: string
      },
      Omit<IssueEvent, "actor" | "data"> & {
        tier_bag: string | null
        actor: string
        data: string
        ref_author: string | null
        ref_private: number | null
        ref_hidden: string | null
      },
      IssueRef & {
        relation_id: string
        type: Relation["type"]
        direction: Relation["direction"]
        ref_author: string
        ref_private: number
        ref_hidden: string | null
      },
      ReportRow,
      ContactRow,
      ProofRow
    ]
  >(
    env,
    scope,
    [
      sql(
        env,
        `WITH ${viewerCTE} SELECT ${fields(v.team, true, true)},${requestJson(v.team)} request_info,i.github_repo,i.github_number,i.body,i.template_id,i.system_info,i.edited_at,i.mentions FROM issues i WHERE ${where}`,
        ...viewerArgs(v),
        key,
        number
      ),
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
        `SELECT c.id,c.body,c.created_at,c.updated_at,c.author,c.hidden,c.edited_at,c.internal,c.mentions,c.via,
        ${v.team ? tierBag("(SELECT app_id FROM issues WHERE id=c.issue_id)", ["c.author", "json_extract(c.hidden,'$.by')"], "c.mentions") : "NULL"} tier_bag,
       (SELECT count(*) FROM comment_helpful WHERE comment_id=c.id) helpful,EXISTS(SELECT 1 FROM comment_helpful WHERE comment_id=c.id AND voter=?) viewer_helpful
       FROM comments c WHERE issue_id=(${target}) ${v.team ? "" : "AND internal=0"} ORDER BY c.created_at,c.rowid`,
        v.voter ?? v.actorId,
        key,
        number
      ),
      sql(
        env,
        `SELECT e.id,e.type,e.actor,e.data,e.created_at,${v.team ? tierBag("(SELECT app_id FROM issues WHERE id=e.issue_id)", ["e.actor", "json_extract(e.data,'$.assignee')"]) : "NULL"} tier_bag,
        json_extract(other.author,'$.id') ref_author,other.private ref_private,other.hidden ref_hidden
       FROM issue_events e LEFT JOIN issues other ON other.id=json_extract(e.data,'$.relation.issue.id') AND other.app_id=(SELECT app_id FROM issues WHERE id=e.issue_id) WHERE e.issue_id=(${target})
       ${
         v.team
           ? `UNION ALL SELECT e.id,e.type,i.author,e.data,i.created_at,${tierBag("i.app_id", ["i.author", "json_extract(e.data,'$.assignee')"])},NULL,NULL,NULL
         FROM tier_issue_events e JOIN issues i ON i.id=e.issue_id AND i.app_id=e.app_id WHERE e.issue_id=(${target})
         UNION ALL SELECT n.id,'nudged','{"type":"agent","id":"bellhop","name":"Bellhop"}','{}',n.created_at,NULL,NULL,NULL,NULL FROM nudge_events n WHERE n.issue_id=(${target})
         UNION ALL SELECT e.id,'routed',e.actor,e.data,e.created_at,NULL,NULL,NULL,NULL FROM request_route_events e JOIN apps a ON a.id=e.app_id AND a.mode='helpdesk' WHERE e.issue_id=(${target}) ORDER BY created_at`
           : "ORDER BY e.created_at,e.rowid"
       }`,
        key,
        number,
        ...(v.team ? [key, number, key, number, key, number] : [])
      ),
      sql(
        env,
        `WITH target AS (${target}) SELECT rel.id relation_id,rel.type,CASE WHEN rel.source_id=t.id THEN 'outgoing' ELSE 'incoming' END direction,
      i.id,i.number,i.title,i.status,i.close_reason,json_extract(i.author,'$.id') ref_author,i.private ref_private,i.hidden ref_hidden FROM target t JOIN relations rel ON rel.source_id=t.id OR rel.target_id=t.id
      JOIN issues i ON i.id=CASE WHEN rel.source_id=t.id THEN rel.target_id ELSE rel.source_id END ORDER BY rel.rowid`,
        key,
        number
      ),
      reportQuery(env, scope, v, "issue", number),
      contactQuery(env, scope, `${target} AND ?`, key, number, Number(v.team)),
      proofQuery(
        env,
        scope,
        `${target} AND (? OR json_extract(author,'$.id') IN(SELECT value FROM json_each(?)))`,
        key,
        number,
        Number(v.team),
        JSON.stringify(actorIds(v))
      )
    ],
    read
  )
  const r = items[0],
    roles = roleMap(team)
  if (!r) {
    if (moved) {
      const dest = await sql(
        env,
        `SELECT a.slug,i.number,i.private,i.hidden,json_extract(i.author,'$.id') reporter FROM issue_moves mv JOIN issues i ON i.id=mv.issue_id JOIN apps a ON a.id=i.app_id WHERE mv.from_app=? AND mv.from_number=?`,
        key,
        number
      ).first<{ slug: string; number: number; private: number; hidden: string | null; reporter: string }>()
      if (dest) {
        const who = await moved.viewer(dest.slug)
        if (who && sees(who, { reporter: dest.reporter, private: !!dest.private, hidden: !!dest.hidden }))
          throw new ApiFailure(404, "moved", "Issue transferred", {
            slug: dest.slug,
            number: dest.number,
            url: appUrl(env, moved.origin, dest.slug, `/issues/${dest.number}`)
          })
      }
    }
    if (await sql(env, `SELECT 1 FROM public_issue_tombstones WHERE ${where}`, key, number).first())
      fail(410, "deleted", "Issue permanently deleted")
    missing()
  }
  const byParent = new Map<string | null, Attachment[]>()
  for (const a of files) {
    const group = byParent.get(a.comment_id) ?? []
    group.push(attachment(a))
    byParent.set(a.comment_id, group)
  }
  const metadata = reports.map(decodeReport)
  for (const m of metadata) {
    const parent = m.attached_to!.comment_id
    byParent.set(parent, [...(byParent.get(parent) ?? []), ...m.logs])
  }
  const s = reporterSummary(r, roles),
    timeline: TimelineItem[] = []
  const privileged = v.team
  if (!sees(v, gateOf(s))) missing()
  for (const { tier_bag, ...c } of comments) {
    const author = parseActor(c.author, roles)
    timeline.push({
      kind: "comment",
      comment: projectTiers(
        commentView(
          {
            ...c,
            internal: !!c.internal,
            helpful: c.helpful,
            viewer_helpful: !!c.viewer_helpful,
            mentions: parseMentions(c.mentions, roles),
            author,
            by_issue_author: author.id === s.author.id,
            attachments: byParent.get(c.id) ?? [],
            hidden: moderation(c.hidden, roles),
            viewer_is_author: false
          },
          v
        ),
        tier_bag ? JSON.parse(tier_bag) : undefined
      )
    })
  }
  for (const { ref_author, ref_private, ref_hidden, tier_bag, ...e } of events) {
    if (!privileged && (e.type === "hidden" || e.type === "unhidden")) continue
    if (
      (e.type === "related" || e.type === "unrelated") &&
      (!ref_author || !sees(v, { reporter: ref_author, private: !!ref_private, hidden: !!ref_hidden }))
    )
      continue
    const data = JSON.parse(e.data)
    if (e.type === "assigned" && data.assignee) normalizeActor(data.assignee, roles)
    timeline.push({
      kind: "event",
      event: projectTiers(
        { ...e, actor: privileged ? parseActor(e.actor, roles) : requesterActor(parseActor(e.actor, roles)), data },
        tier_bag ? JSON.parse(tier_bag) : undefined
      )
    })
  }
  const time = (item: TimelineItem) => (item.kind === "event" ? item.event.created_at : item.comment.created_at)
  const verifications = proofs
    .map(verification)
    .map((v) => (privileged ? v : { ...v, requested_by: requesterActor(v.requested_by) }))
  for (const proof of verifications)
    if (proof.state === "verified")
      timeline.push({
        kind: "event",
        event: {
          id: proof.id,
          type: "verified",
          actor: s.author,
          created_at: proof.verified_at!,
          data: { verification_id: proof.id }
        }
      })
  timeline.sort((a, b) => time(a).localeCompare(time(b)))
  return {
    ...s,
    contact: contacts.length ? (({ issue_id, ...c }) => c)(contacts[0]!) : null,
    ...typeInfo(r.request_info),
    verifications,
    edited_at: r.edited_at,
    imported: r.github_repo
      ? {
          source: "github",
          url: `https://github.com/${r.github_repo}/issues/${r.github_number}`,
          number: r.github_number!
        }
      : null,
    mentions: projectTiers(parseMentions(r.mentions, roles), r.tier_bag ? JSON.parse(r.tier_bag) : undefined),
    body: r.body,
    template_id: r.template_id,
    metadata,
    system_info: r.system_info
      ? privileged || metadata.some((m) => m.attached_to?.comment_id === null)
        ? JSON.parse(r.system_info)
        : "hidden"
      : null,
    viewer_is_author: owns(v, s.author.id),
    attachments: byParent.get(null) ?? [],
    timeline,
    relations: relations.flatMap(
      ({ relation_id: id, direction, type, ref_author, ref_private, ref_hidden, ...issue }) =>
        sees(v, { reporter: ref_author, private: !!ref_private, hidden: !!ref_hidden })
          ? [{ id, direction, type, issue }]
          : []
    )
  }
}
export function summaryOf(issue: Issue): IssueSummary {
  const {
    request_type,
    fields,
    effective_autonomy,
    contact,
    verifications,
    imported,
    body,
    template_id,
    system_info,
    metadata,
    viewer_is_author,
    attachments,
    timeline,
    relations,
    edited_at,
    mentions,
    ...s
  } = issue
  return s
}
