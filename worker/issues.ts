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
import { ApiFailure, appUrl, bad, choice, fail, missing, now, rows, sql, str } from "./core"
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
import { voteCount } from "./conversation"
import { projectTiers, tierBag } from "./tier-actors"
import { appIdSQL, appKey, readBatch } from "./read-scope"
import type { ReadScope } from "./read-scope"
import { can } from "./permissions"
import { reportQuery, decodeReport, type ReportRow } from "./report-data"

const viewerCTE = "viewer AS (SELECT ? voter,? ids)"
const viewerArgs = (v: Viewer) => [v.voter ?? v.actorId, JSON.stringify(actorIds(v))]
const fields = (
  team: boolean,
  personal = true,
  full = false
) => `i.id,i.number,i.title,i.status,i.close_reason,i.created_at,i.updated_at,i.author,i.assignee,i.activity,i.private,i.hidden,i.locked,i.pinned,
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
export const visibleIssues = (workspace: string, v: Viewer = outsider) => `i.app_id=${workspace} AND ${visibleSQL(v)}`
export const myAuthorFilter = (q: unknown) => typeof q === "string" && /(?:^|\s)author:@me(?=\s|$)/i.test(q)
function issueFilter(
  workspace: string,
  options: { label?: unknown; query?: unknown },
  v: Viewer = outsider,
  mine = false
) {
  const where = [visibleIssues(workspace, v)],
    values: unknown[] = [...actorBindings(v)]
  if (options.label) {
    where.push(
      "EXISTS (SELECT 1 FROM issue_labels il JOIN labels l ON l.id=il.label_id WHERE il.issue_id=i.id AND l.name=?)"
    )
    values.push(str(options.label, "label", 60))
  }
  if (options.query) {
    let query = str(options.query, "query", 512)
    if (mine) {
      where.push("i.hidden IS NULL AND json_extract(i.author,'$.id') IN (SELECT value FROM json_each(?))")
      values.push(JSON.stringify(actorIds(v)))
      query = query.replace(/(?:^|\s)author:@me(?=\s|$)/gi, " ").trim()
    }
    const hidden = /(?:^|\s)is:hidden(?=\s|$)/i.test(query)
    if (hidden) {
      where.push("i.hidden IS NOT NULL")
      query = query.replace(/(?:^|\s)is:hidden(?=\s|$)/gi, " ").trim()
    }
    const words = query.match(/[\p{L}\p{N}\p{M}_]+/gu)?.slice(0, 24)
    if (words?.length) {
      const phrase = words.map((w) => `"${w}"*`).join(" AND ")
      where.push(`(i.rowid IN (SELECT rowid FROM issue_fts WHERE issue_fts MATCH ?) OR i.id IN
        (SELECT c.issue_id FROM comments c JOIN comment_fts f ON f.rowid=c.rowid WHERE comment_fts MATCH ? ${v.team ? "" : "AND c.hidden IS NULL AND c.internal=0"}))`)
      values.push(phrase, phrase)
    } else if ((!hidden && !mine) || query) where.push("0")
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
  },
  viewer: Viewer = outsider
): Promise<IssueList> {
  const mine = myAuthorFilter(options.query),
    filter = issueFilter(appIdSQL(scope), options, viewer, mine),
    values = [appKey(scope), ...filter.values]
  const base = ` FROM issues i WHERE ${filter.where}`
  const totals = sql(
    env,
    `SELECT count(*) FILTER (WHERE i.status!='closed') AS open,count(*) FILTER (WHERE i.status='closed') AS closed${base}`,
    ...values
  )
  const state = choice(options.state ?? "open", ["open", "closed"] as const, "state")
  const sort = choice(options.sort ?? "newest", ["newest", "oldest", "updated", "votes", "comments"] as const, "sort"),
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
  const list = sql(
    env,
    `WITH ${viewerCTE} SELECT * FROM (SELECT ${fields(viewer.team)}${base} ${options.allStates ? "" : `AND i.status${state === "open" ? "!=" : "="}'closed'`}) WHERE 1 ${boundary} ORDER BY ${metric} ${asc ? "ASC" : "DESC"}${metric === "number" ? "" : ",number DESC"} LIMIT ?`,
    ...viewerArgs(viewer),
    ...values,
    ...cursorArgs,
    limit + 1
  )
  const {
    data: [items, counts, team, pins]
  } = await readBatch<[StoredSummary, IssueList["counts"], TeamRow, StoredSummary]>(env, scope, [
    list,
    totals,
    teamQuery(env, scope),
    sql(
      env,
      `WITH ${viewerCTE} SELECT ${fields(viewer.team)} FROM issues i WHERE i.pinned=1 AND ${mine ? filter.where : visibleIssues(appIdSQL(scope), viewer)} ORDER BY i.number DESC LIMIT ?`,
      ...viewerArgs(viewer),
      appKey(scope),
      ...(mine ? filter.values : actorBindings(viewer)),
      options.cursor === undefined ? 3 : 0
    )
  ])
  const roles = roleMap(team)
  return {
    issues: items.slice(0, limit).map((r) => summary(r, roles)),
    pinned: pins.map((r) => summary(r, roles)),
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
  voter: string | null = null,
  reportIds?: string[]
): Promise<FeedList> {
  const closed = Number(choice(options.state ?? "open", ["open", "closed"] as const, "state") === "closed"),
    filter = reportIds
      ? {
          where: "i.hidden IS NULL AND json_extract(i.author,'$.id') IN (SELECT value FROM json_each(?))",
          values: [JSON.stringify(reportIds)]
        }
      : issueFilter("a.id", { query: options.q })
  let boundary = "",
    keys: string[] = []
  if (options.cursor !== undefined) {
    const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)~([\w-]{1,80})$/.exec(options.cursor)
    if (!match) bad("Invalid feed cursor")
    boundary = "AND (i.updated_at,i.id)<(?,?)"
    keys = [match[1]!, match[2]!]
  }
  // Personal discovery starts at the indexed author IDs, not the workspace directory.
  // Public discovery seeks one page per listed workspace so private backlogs don't dominate it.
  const candidates = reportIds
    ? `SELECT i.id,i.updated_at FROM issues i WHERE ${filter.where} AND (i.status='closed')=? ${boundary}
      ORDER BY i.updated_at DESC,i.id DESC LIMIT ?`
    : `SELECT candidate.id,candidate.updated_at FROM apps a CROSS JOIN issues candidate
      WHERE a.public=1 AND candidate.rowid IN (SELECT i.rowid FROM issues i WHERE ${filter.where} AND (i.status='closed')=? ${boundary}
        ORDER BY i.updated_at DESC,i.id DESC LIMIT ?) ORDER BY candidate.updated_at DESC,candidate.id DESC LIMIT ?`
  const [page, totals] = await env.DB.batch<unknown>([
    sql(
      env,
      `WITH ${viewerCTE}, page AS MATERIALIZED (${candidates})
      SELECT ${feedFields(true)} FROM page p JOIN issues i ON i.id=p.id JOIN apps a ON a.id=i.app_id
      ORDER BY p.updated_at DESC,p.id DESC`,
      voter,
      JSON.stringify(reportIds ?? []),
      ...filter.values,
      closed,
      ...keys,
      ...(reportIds ? [] : [pageSize + 1]),
      pageSize + 1
    ),
    sql(
      env,
      `SELECT count(*) FILTER(WHERE i.status!='closed') open,count(*) FILTER(WHERE i.status='closed') closed
      FROM ${reportIds ? "issues i WHERE" : "apps a CROSS JOIN issues i WHERE a.public=1 AND"} ${filter.where}`,
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
  scope: string,
  number: number,
  v: Viewer = outsider,
  moved?: { origin: string; viewer: (slug: string) => Promise<Viewer | null> }
): Promise<Issue> {
  const where = `app_id=${appIdSQL(scope)} AND number=?`,
    target = `SELECT id FROM issues WHERE ${where}`,
    key = appKey(scope)
  const {
    data: [items, team, files, comments, events, relations, reports]
  } = await readBatch<
    [
      StoredSummary & {
        body: string
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
      ReportRow
    ]
  >(env, scope, [
    sql(
      env,
      `WITH ${viewerCTE} SELECT ${fields(v.team, true, true)},i.body,i.template_id,i.system_info,i.edited_at,i.mentions FROM issues i WHERE ${where}`,
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
         FROM tier_issue_events e JOIN issues i ON i.id=e.issue_id AND i.app_id=e.app_id WHERE e.issue_id=(${target}) ORDER BY created_at`
           : "ORDER BY e.created_at,e.rowid"
       }`,
      key,
      number,
      ...(v.team ? [key, number] : [])
    ),
    sql(
      env,
      `WITH target AS (${target}) SELECT rel.id relation_id,rel.type,CASE WHEN rel.source_id=t.id THEN 'outgoing' ELSE 'incoming' END direction,
      i.id,i.number,i.title,i.status,i.close_reason,json_extract(i.author,'$.id') ref_author,i.private ref_private,i.hidden ref_hidden FROM target t JOIN relations rel ON rel.source_id=t.id OR rel.target_id=t.id
      JOIN issues i ON i.id=CASE WHEN rel.source_id=t.id THEN rel.target_id ELSE rel.source_id END ORDER BY rel.rowid`,
      key,
      number
    ),
    reportQuery(env, scope, v, "issue", number)
  ])
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
  const s = summary(r, roles),
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
        { ...e, actor: parseActor(e.actor, roles), data },
        tier_bag ? JSON.parse(tier_bag) : undefined
      )
    })
  }
  const time = (item: TimelineItem) => (item.kind === "event" ? item.event.created_at : item.comment.created_at)
  timeline.sort((a, b) => time(a).localeCompare(time(b)))
  return {
    ...s,
    edited_at: r.edited_at,
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
