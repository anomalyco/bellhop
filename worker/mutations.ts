import { Hono } from "hono"
import type {
  Actor,
  AgentRole,
  App,
  CloseReason,
  Comment,
  IssueEvent,
  IssueRef,
  IssueSummary,
  Label,
  LiveEvent,
  Locale,
  Block,
  Moderation,
  Revision,
  Relation,
  SystemInfo,
  TimelineItem
} from "../shared/api"
import { assignee, labelCols, selectedLabels } from "./apps"
import { allowWrite, namedPost, postBody } from "./auth"
import { appUrl, bad, body, choice, denied, fail, ids, input, missing, now, rows, sql, str, uid } from "./core"
import { agentAccessSQL, can, requireTeam } from "./permissions"
import { addedMentions, mentionsIn } from "./conversation"
import type { Bindings, Ctx } from "./core"
import { appRoom, issueRoom, emit, setActivity } from "./events"
import { actorBindings, actorIds, owns, gateOf, sees, seesComment, visibleSQL } from "./visibility"
import type { Change, Work } from "./events"
import { guestWrite } from "./guest-history"
import { appRoles, attachment, getIssue, issueNumber, issueSummary, parseActor, ref, summaryOf } from "./issues"
import type { AttachmentRow } from "./issues"
import { teamProjection } from "./tier-actors"
import { enqueueWebhooks } from "./webhooks"
import { entry, recorded, auditActor, targetEntry } from "./audit"
import { attachReport, getReport } from "./report-data"
import { requestLocale } from "./locale"

export interface Access {
  env: Env
  ctx: Work
  app: Pick<App, "id" | "slug" | "name" | "public">
  actor: Actor
  roles?: ReturnType<typeof appRoles>
  guestHash?: string
  aliases?: string[]
  role: App["role"] | AgentRole
  origin: string
  locale?: Locale
}
function access(c: Ctx): Access {
  return {
    env: c.env,
    ctx: c.executionCtx,
    app: c.var.app,
    actor: c.var.actor,
    guestHash: c.var.guestHash,
    aliases: c.var.aliases,
    role: c.var.app.role,
    locale: requestLocale(c).locale,
    origin: c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin
  }
}
const roles = (a: Access) => (a.roles ??= appRoles(a.env, a.app.id))
const who = (a: Access) => ({
  actorId: a.actor.id,
  aliases: a.aliases,
  team: can(a.role, "read"),
  voter: a.actor.type === "guest" ? "g:" + a.guestHash : a.actor.id
})
const full = (a: Access, n: number) => getIssue(a.env, a.app.id, n, who(a))
const summary = (a: Access, n: number) => issueSummary(a.env, a.app.id, n, roles(a), who(a))
const stillHere = (a: Access, id: string) =>
  sql(a.env, "UPDATE issues SET revision=NULL WHERE id=? AND app_id!=?", id, a.app.id)
// A rename can commit between loading the request actor and writing its JSON snapshot. Usually this
// matches no rows; a stale guest would violate NOT NULL and roll back the entire post or event.
function guestNameGuard(a: Access) {
  const guard = can(a.role, "read")
    ? []
    : [
        sql(
          a.env,
          "UPDATE blocks SET actor_id=NULL WHERE app_id=? AND actor_id IN(SELECT value FROM json_each(?))",
          a.app.id,
          JSON.stringify(actorIds(who(a)))
        )
      ]
  return a.actor.type === "guest"
    ? [
        ...guard,
        sql(a.env, "UPDATE guest_names SET name=NULL WHERE guest_hash=? AND name IS NOT ?", a.guestHash, a.actor.name),
        guestWrite(a.env, a.guestHash!)
      ]
    : guard
}
function notify(
  a: Access,
  payload: Pick<
    Change,
    | "type"
    | "issue"
    | "items"
    | "changes"
    | "comments"
    | "deletedComment"
    | "internalOnly"
    | "mentioned"
    | "removed"
    | "ruleItems"
  >
) {
  emit(a.env, a.ctx, { app: a.app, origin: a.origin, actor: a.actor, ...payload })
}
function record(
  a: Access,
  issueId: string,
  type: IssueEvent["type"],
  data: IssueEvent["data"],
  at: string,
  statements: D1PreparedStatement[],
  items: TimelineItem[]
) {
  const event: IssueEvent = { id: uid(), type, data, actor: a.actor, created_at: at }
  statements.push(
    sql(
      a.env,
      "INSERT INTO issue_events VALUES(?,?,?,?,?,?)",
      event.id,
      issueId,
      type,
      JSON.stringify(a.actor),
      JSON.stringify(data),
      at
    )
  )
  items.push({ kind: "event", event })
}
function attach(env: Env, id: string, commentId: string | null, value: unknown) {
  return ids(value, "attachment_ids").map((key) =>
    sql(env, "INSERT INTO attachment_links VALUES(?,?,?)", key, id, commentId)
  )
}
function systemInfo(value: unknown): SystemInfo | null {
  if (value === undefined) return null
  const entries = Object.entries(input(value))
  if (entries.length > 64) bad("Too many system info fields")
  return Object.fromEntries(
    entries.map(([key, v]) => [str(key, "system info key", 120), str(v, "system info value", 2048, true)])
  )
}
async function createIssue(a: Access, b: Record<string, unknown>) {
  const { env, app, actor } = a,
    id = uid(),
    at = now(),
    title = str(b.title, "title", 256).trim(),
    text = str(b.body, "body", 65536, true),
    info = systemInfo(b.system_info)
  const template = b.template_id === undefined ? null : str(b.template_id, "template_id", 64)
  if (b.private !== undefined && typeof b.private !== "boolean") bad("Invalid private flag")
  let labels: Label[] = []
  if (template) {
    if (!(await sql(env, "SELECT 1 FROM templates WHERE app_id=? AND id=?", app.id, template).first()))
      bad("Unknown template")
    labels = await rows<Label>(
      sql(
        env,
        `SELECT ${labelCols} FROM labels WHERE app_id=? AND id IN(SELECT label_id FROM template_labels WHERE template_id=?)`,
        app.id,
        template
      )
    )
  }
  const mentions = await mentionsIn(env, app.id, text, can(a.role, "read"))
  const q = [
    sql(env, "UPDATE apps SET issue_seq=issue_seq+1 WHERE id=?", app.id),
    sql(
      env,
      `INSERT INTO issues(id,app_id,number,title,body,author,system_info,template_id,created_at,updated_at,reporter_locale,private,mentions,assignee,reply_tier_id)
    SELECT ?,a.id,a.issue_seq,?,?,?,?,?,?,?,?,CASE WHEN t.force_private=1 THEN 1 WHEN (a.reporter_can_choose OR ?) THEN coalesce(?,a.default_private) ELSE a.default_private END,?,
      (SELECT json_object('type','member','id',u.id,'name',u.name,'avatar_url',u.avatar_url,'role',m.role) FROM users u JOIN members m ON m.user_id=u.id AND m.app_id=a.id WHERE u.id=t.assignee_id),
      CASE WHEN t.agents_reply=0 THEN t.id END FROM apps a LEFT JOIN reporter_tiers t ON t.app_id=a.id AND t.actor_id=? WHERE a.id=? RETURNING number`,
      id,
      title,
      text,
      JSON.stringify(actor),
      info ? JSON.stringify(info) : null,
      template,
      at,
      at,
      a.locale ?? null,
      Number(can(a.role, "read")),
      b.private === undefined ? null : Number(b.private),
      JSON.stringify(mentions),
      actor.id,
      app.id
    ),
    ...attach(env, id, null, b.attachment_ids),
    ...attachReport(env, app.id, b.metadata_id, id, null),
    ...guestNameGuard(a)
  ]
  const templateEvents = new Set<string>()
  if (actor.type === "guest")
    q.push(
      sql(
        env,
        "UPDATE guest_report_authors SET guest_hash=?,name=NULL WHERE actor_id=? AND guest_hash IS NULL",
        a.guestHash!,
        actor.id
      )
    )
  for (const label of labels) {
    const eventId = uid()
    templateEvents.add(eventId)
    q.push(sql(env, "INSERT INTO issue_labels VALUES(?,?)", id, label.id))
    q.push(
      sql(
        env,
        `INSERT INTO issue_events SELECT ?,?,'labeled',?,?,? WHERE NOT EXISTS(SELECT 1 FROM reporter_tiers t JOIN tier_labels tl ON tl.tier_id=t.id WHERE t.app_id=? AND t.actor_id=? AND tl.label_id=?)`,
        eventId,
        id,
        JSON.stringify(actor),
        JSON.stringify({ label }),
        at,
        app.id,
        actor.id,
        label.id
      )
    )
  }
  // When tier and template overlap, one team-only rule event replaces the template event.
  const rule = `json_object('tier_id',t.id,'tier_name',t.name)`
  const ruleStart = q.length
  q.push(
    sql(
      env,
      `INSERT INTO tier_issue_events SELECT lower(hex(randomblob(16))),?1,t.app_id,'labeled',json_object('rule',${rule},'label',json_object('id',l.id,'name',l.name,'color',l.color,'description',l.description))
     FROM reporter_tiers t JOIN tier_labels tl ON tl.tier_id=t.id JOIN labels l ON l.id=tl.label_id WHERE t.app_id=?2 AND t.actor_id=?3
     RETURNING id,type,data`,
      id,
      app.id,
      actor.id
    ),
    sql(
      env,
      `INSERT INTO tier_issue_events SELECT ?,i.id,t.app_id,'assigned',json_object('rule',${rule},'assignee',json(i.assignee))
      FROM issues i JOIN reporter_tiers t ON t.app_id=i.app_id AND t.actor_id=? WHERE i.id=? AND i.assignee IS NOT NULL RETURNING id,type,data`,
      uid(),
      actor.id,
      id
    ),
    sql(
      env,
      `INSERT OR IGNORE INTO issue_labels SELECT ?,tl.label_id FROM reporter_tiers t JOIN tier_labels tl ON tl.tier_id=t.id WHERE t.app_id=? AND t.actor_id=?`,
      id,
      app.id,
      actor.id
    )
  )
  const results = await env.DB.batch<Record<string, unknown>>(q),
    number = results[1]!.results[0]!.number as number
  const ruleFrames: Extract<LiveEvent, { type: "timeline.added" }>[] = []
  for (const result of results.slice(ruleStart, ruleStart + 2)) {
    for (const row of result.results as { id: string; type: "labeled" | "assigned"; data: string }[]) {
      const event = { id: row.id, type: row.type, data: JSON.parse(row.data), actor, created_at: at }
      ruleFrames.push({ type: "timeline.added", issue_id: id, item: { kind: "event", event } })
    }
  }
  const issue = await full(a, number)
  const items = issue.timeline.filter((t) => t.kind === "event" && templateEvents.has(t.event.id))
  // Even a pre-tiers Room understands internalOnly; never send rules in a mixed-audience RPC.
  if (ruleFrames.length)
    a.ctx.waitUntil(issueRoom(env, id).publishConversation(ruleFrames, { app: app.id, internalOnly: true }))
  notify(a, {
    type: "issue.opened",
    issue: summaryOf(issue),
    items,
    ruleItems: ruleFrames.map((e) => e.item),
    mentioned: addedMentions(mentions, [], actor)
  })
  return issue
}
async function commentTarget(a: Access, n: number, b: Record<string, unknown>) {
  const s = await summary(a, n),
    v = who(a)
  if (!sees(v, gateOf(s))) missing()
  if (b.internal !== undefined && typeof b.internal !== "boolean") bad("Invalid internal flag")
  if (b.internal === true && !v.team) denied()
  if (s.locked && !v.team) fail(403, "locked", "Only the team can comment on this locked issue")
  return s
}
export async function addComment(
  a: Access,
  n: number,
  b: Record<string, unknown>,
  target?: IssueSummary,
  inbound?: { message: string; sub: string; nonce: string; address: string }
): Promise<Comment> {
  const { env, actor, app } = a,
    s = target ?? (await commentTarget(a, n, b)),
    at = now(),
    id = uid(),
    text = str(b.body, "body", 65536, true)
  const links = attach(env, s.id, id, b.attachment_ids)
  const v = who(a)
  const internal = b.internal === true
  const via = inbound ? "email" : actor.type === "agent" ? "mcp" : "web"
  const mentions = await mentionsIn(env, app.id, text, v.team)
  if (!text.trim() && !links.length && b.metadata_id === undefined) bad("A comment needs text or an attachment")
  await env.DB.batch([
    ...(inbound
      ? [
          sql(
            env,
            `INSERT INTO mail_inbound(id,sub_id) VALUES(?,(SELECT id FROM mail_people WHERE id=? AND nonce=? AND address=? AND issue_id=? AND actor_id=? AND state='on' AND role IS ?))`,
            inbound.message,
            inbound.sub,
            inbound.nonce,
            inbound.address,
            s.id,
            actor.id,
            a.role
          )
        ]
      : []),
    sql(
      env,
      `INSERT INTO comments(id,issue_id,author,body,created_at,updated_at,internal,mentions,via,locale,writer_version) VALUES(?,(SELECT id FROM issues i WHERE id=? AND ${visibleSQL(v)}),?,?,?,?,?,?,?,?,1)`,
      id,
      s.id,
      ...actorBindings(v),
      JSON.stringify(actor),
      text,
      at,
      at,
      Number(internal),
      JSON.stringify(mentions),
      via,
      a.locale ?? null
    ),
    ...links,
    ...attachReport(env, app.id, b.metadata_id, s.id, id),
    ...guestNameGuard(a),
    stillHere(a, s.id),
    ...(!internal ? [sql(env, "UPDATE issues SET updated_at=max(updated_at,?) WHERE id=?", at, s.id)] : [])
  ])
  const files = links.length
    ? await rows<AttachmentRow>(
        sql(
          env,
          "SELECT a.id,a.name,a.size,a.kind,a.mime FROM attachment_links l JOIN attachments a ON a.id=l.attachment_id WHERE l.comment_id=? ORDER BY l.rowid",
          id
        )
      )
    : []
  const report = b.metadata_id === undefined ? null : await getReport(env, app.id, b.metadata_id as string, v)
  const comment: Comment = {
    via,
    id,
    author: actor,
    body: text,
    attachments: [...files.map(attachment), ...(report?.logs ?? [])],
    by_issue_author: actor.id === s.author.id,
    created_at: at,
    updated_at: at,
    hidden: null,
    edited_at: null,
    viewer_is_author: true,
    internal,
    mentions,
    helpful: 0,
    viewer_helpful: false
  }
  if (actor.type === "agent" && !internal) await setActivity(env, app.id, s.id, actor, null, true)
  notify(a, {
    type: "comment.created",
    issue: await summary(a, n),
    items: [{ kind: "comment", comment }],
    internalOnly: internal,
    mentioned: addedMentions(mentions, [], actor)
  })
  return comment
}
export async function updateIssue(a: Access, n: number, b: Record<string, unknown>, claim = false) {
  const { env, app, actor } = a
  const state = await sql(
    env,
    "SELECT i.revision,a.reporter_can_choose FROM issues i JOIN apps a ON a.id=i.app_id WHERE i.app_id=? AND i.number=?",
    app.id,
    n
  ).first<{ revision: number; reporter_can_choose: number }>()
  if (!state) missing()
  const version = state.revision
  const issue = await full(a, n),
    keys = Object.keys(b),
    supported = ["title", "body", "status", "close_reason", "label_ids", "assignee_id", "private", "locked", "pinned"]
  if (!can(a.role, "triage")) {
    if (
      !issue.viewer_is_author ||
      claim ||
      keys.some((k) => !["title", "body", "status", "close_reason", "private"].includes(k))
    )
      denied()
    if (b.private !== undefined && !state.reporter_can_choose) denied()
    if (b.status !== undefined && b.status !== "closed" && !(issue.status === "closed" && b.status === "open")) denied()
    if (b.close_reason !== undefined && b.close_reason !== "completed" && b.close_reason !== "not_planned") denied()
  }
  if (keys.some((k) => !supported.includes(k))) bad("Unknown issue field")
  const at = now(),
    q: D1PreparedStatement[] = [],
    items: TimelineItem[] = [],
    changes: string[] = [],
    set: string[] = [],
    values: unknown[] = []
  function field(key: string, value: unknown) {
    set.push(`${key}=?`)
    values.push(value)
    changes.push(key)
  }
  if (b.title !== undefined) {
    const title = str(b.title, "title", 256).trim()
    if (title !== issue.title) {
      field("title", title)
      record(a, issue.id, "renamed", { from: issue.title, to: title }, at, q, items)
    }
  }
  let mentioned: Actor[] = []
  if (b.body !== undefined) {
    const text = str(b.body, "body", 65536, true)
    if (text !== issue.body) {
      field("body", text)
      const ms = await mentionsIn(env, app.id, text, can(a.role, "read"))
      set.push("mentions=?")
      values.push(JSON.stringify(ms))
      mentioned = addedMentions(ms, issue.mentions, actor)
    }
  }
  if (changes.includes("title") || changes.includes("body")) {
    q.push(
      sql(
        env,
        "INSERT INTO revisions VALUES(?,?,NULL,?,?,?,?)",
        uid(),
        issue.id,
        JSON.stringify(actor),
        issue.title,
        issue.body,
        at
      )
    )
    set.push("edited_at=?")
    values.push(at)
  }
  if (b.private !== undefined) {
    if (typeof b.private !== "boolean") bad("Invalid private flag")
    if (b.private !== issue.private) {
      field("private", Number(b.private))
      record(a, issue.id, b.private ? "made_private" : "made_public", {}, at, q, items)
    }
  }
  for (const k of ["locked", "pinned"] as const)
    if (b[k] !== undefined) {
      if (typeof b[k] !== "boolean") bad(`Invalid ${k} flag`)
      if (b[k] !== issue[k]) {
        field(k, Number(b[k]))
        record(
          a,
          issue.id,
          k === "locked" ? (b[k] ? "locked" : "unlocked") : b[k] ? "pinned" : "unpinned",
          {},
          at,
          q,
          items
        )
      }
    }
  if (b.status !== undefined || b.close_reason !== undefined) {
    const status = choice(b.status ?? issue.status, ["open", "in_progress", "waiting", "closed"] as const, "status")
    if (b.close_reason !== undefined && status !== "closed") bad("A close reason requires closed status")
    const reason: CloseReason | null =
      status === "closed"
        ? choice(
            b.close_reason ?? issue.close_reason ?? "completed",
            ["completed", "not_planned", "duplicate"] as const,
            "close_reason"
          )
        : null
    if (status !== issue.status || reason !== issue.close_reason) {
      if (status !== issue.status) field("status", status)
      if (reason !== issue.close_reason) field("close_reason", reason)
      record(a, issue.id, "status_changed", { from: issue.status, to: status, close_reason: reason }, at, q, items)
    }
  }
  if (claim || b.assignee_id !== undefined) {
    const to = claim ? actor : await assignee(env, app.id, b.assignee_id)
    if (to?.id !== issue.assignee?.id) {
      field("assignee", to ? JSON.stringify(to) : null)
      if (to?.id === actor.id) record(a, issue.id, "claimed", {}, at, q, items)
      else record(a, issue.id, "assigned", { assignee: to }, at, q, items)
    }
  }
  if (b.label_ids !== undefined) {
    const labels = await selectedLabels(env, app.id, b.label_ids)
    const add = labels.filter((l) => !issue.labels.some((o) => l.id === o.id)),
      del = issue.labels.filter((l) => !labels.some((o) => l.id === o.id))
    if (add.length || del.length) changes.push("labels")
    for (const label of del) {
      q.push(sql(env, "DELETE FROM issue_labels WHERE issue_id=? AND label_id=?", issue.id, label.id))
      record(a, issue.id, "unlabeled", { label }, at, q, items)
    }
    for (const label of add) {
      q.push(sql(env, "INSERT INTO issue_labels VALUES(?,?)", issue.id, label.id))
      record(a, issue.id, "labeled", { label }, at, q, items)
    }
  }
  if (!changes.length) return issue
  // A conflicting revision violates NOT NULL, rolling the entire batch back (including its timeline).
  q.unshift(
    sql(
      env,
      `UPDATE issues SET ${[...set, "updated_at=max(updated_at,?)", `revision=CASE WHEN revision=? ${!can(a.role, "triage") && changes.includes("private") ? "AND (SELECT reporter_can_choose FROM apps WHERE id=issues.app_id)" : ""} THEN revision+1 ELSE NULL END`].join(",")} WHERE id=?`,
      ...values,
      at,
      version,
      issue.id
    )
  )
  for (const item of items) {
    if (item.kind !== "event") continue
    const e = item.event
    if (
      ["assigned", "claimed", "locked", "unlocked", "pinned", "unpinned", "made_private", "made_public"].includes(
        e.type
      )
    )
      q.push(
        targetEntry(
          env,
          app.id,
          actor,
          `issue.${e.type}`,
          "issue",
          issue.id,
          e.type === "assigned" ? { assignee_id: (e.data.assignee as Actor | null)?.id ?? null } : {}
        )
      )
  }
  for (const m of mentioned)
    q.push(
      sql(
        env,
        "INSERT INTO mail_signal(issue_id,kind,ref,actor,target) VALUES(?,'mention',?,?,?)",
        issue.id,
        issue.id,
        actor.id,
        m.id
      )
    )
  await env.DB.batch([...q, stillHere(a, issue.id), ...guestNameGuard(a)])
  const next = await full(a, n)
  notify(a, { type: "issue.updated", issue: summaryOf(next), changes, items, mentioned })
  return next
}
export async function relate(a: Access, n: number, other: number, type: Relation["type"], remove?: string) {
  if (!can(a.role, "triage")) denied()
  if (n === other) bad("Cannot relate an issue to itself")
  const { env, app } = a,
    [s, t] = await Promise.all([summary(a, n), summary(a, other)])
  const id = remove ?? uid(),
    at = now(),
    q: D1PreparedStatement[] = []
  if (remove) {
    if (!(await sql(env, "SELECT 1 FROM relations WHERE id=? AND source_id=? AND target_id=?", id, s.id, t.id).first()))
      missing()
    q.push(sql(env, "DELETE FROM relations WHERE id=?", id))
  } else q.push(sql(env, "INSERT INTO relations VALUES(?,?,?,?)", id, s.id, t.id, type))
  const pair = [
    { issue: s, other: t, direction: "outgoing" },
    { issue: t, other: s, direction: "incoming" }
  ] as const
  const items = pair.map((p) => {
    const items: TimelineItem[] = []
    const relation: Relation = { id, type, direction: p.direction, issue: ref(p.other) }
    record(a, p.issue.id, remove ? "unrelated" : "related", { relation }, at, q, items)
    return items
  })
  q.push(
    sql(env, "UPDATE issues SET updated_at=max(updated_at,?),revision=revision+1 WHERE id IN (?,?)", at, s.id, t.id)
  )
  await env.DB.batch([...q, stillHere(a, s.id), stillHere(a, t.id)])
  const next = await full(a, n),
    otherSummary = await summary(a, other)
  notify(a, { type: "issue.updated", issue: summaryOf(next), items: items[0], changes: ["relations"] })
  notify(a, { type: "issue.updated", issue: otherSummary, items: items[1], changes: ["relations"] })
  return next
}

async function react(a: Access, n: number, commentId: string | null, on: boolean) {
  const thread = commentId ? await full(a, n) : null,
    issue = thread ?? (await summary(a, n)),
    v = who(a),
    value = v.voter,
    c = thread && commentId ? findComment(thread, commentId) : null
  if (!sees(v, gateOf(issue))) missing()
  if (c && !seesComment(v, c.hidden)) missing()
  if (c?.viewer_is_author) denied()
  const q = commentId
    ? sql(
        a.env,
        on
          ? `INSERT INTO comment_helpful SELECT c.id,? FROM comments c JOIN issues i ON i.id=c.issue_id
    WHERE c.id=? AND i.id=? AND i.app_id=? AND ${visibleSQL(v)} ${v.team ? "" : "AND c.internal=0 AND c.hidden IS NULL"} AND json_extract(c.author,'$.id') NOT IN(SELECT value FROM json_each(?)) ON CONFLICT DO NOTHING`
          : `DELETE FROM comment_helpful WHERE voter=? AND comment_id IN(SELECT c.id FROM comments c JOIN issues i ON i.id=c.issue_id WHERE c.id=? AND i.id=? AND i.app_id=? AND ${visibleSQL(v)} ${v.team ? "" : "AND c.internal=0 AND c.hidden IS NULL"} AND json_extract(c.author,'$.id') NOT IN(SELECT value FROM json_each(?)))`,
        value,
        commentId,
        issue.id,
        a.app.id,
        ...actorBindings(v),
        JSON.stringify(actorIds(v))
      )
    : sql(
        a.env,
        on
          ? `INSERT INTO issue_votes SELECT i.id,? FROM issues i WHERE i.id=? AND i.app_id=? AND ${visibleSQL(v)} ON CONFLICT DO NOTHING`
          : `DELETE FROM issue_votes WHERE voter=? AND issue_id IN(SELECT i.id FROM issues i WHERE i.id=? AND i.app_id=? AND ${visibleSQL(v)})`,
        value,
        issue.id,
        a.app.id,
        ...actorBindings(v)
      )
  const [changed, parents] = await a.env.DB.batch<{ number: number }>([
    q,
    sql(
      a.env,
      `SELECT i.number FROM relations r JOIN issues i ON i.id=r.target_id WHERE r.source_id=? AND r.type='duplicate_of' AND i.app_id=?`,
      issue.id,
      a.app.id
    ),
    stillHere(a, issue.id),
    ...guestNameGuard(a)
  ])
  const latest = commentId ? await full(a, n) : null,
    next = latest ? summaryOf(latest) : await summary(a, n),
    comment = latest && commentId ? findComment(latest, commentId) : null
  if (!sees(v, gateOf(next))) missing()
  if (changed?.meta.changes) {
    emit(a.env, a.ctx, {
      app: a.app,
      origin: a.origin,
      actor: a.actor,
      type: "issue.updated",
      issue: next,
      comments: comment ? [comment] : [],
      internalOnly: !!comment?.internal,
      liveOnly: true
    })
    if (!commentId)
      for (const p of parents!.results)
        emit(a.env, a.ctx, {
          app: a.app,
          origin: a.origin,
          actor: a.actor,
          type: "issue.updated",
          issue: await summary(a, p.number),
          liveOnly: true
        })
  }
  return comment
    ? { helpful: comment.helpful, viewer_helpful: comment.viewer_helpful }
    : { votes: next.votes, viewer_voted: next.viewer_voted }
}

export async function transferIssue(a: Access, n: number, slug: unknown) {
  if (!can(a.role, "triage")) denied()
  const dest = await sql(
    a.env,
    "SELECT id,slug,name,public FROM apps WHERE slug=?",
    str(slug, "target app", 40)
  ).first<{ id: string; slug: string; name: string; public: number }>()
  if (!dest) missing()
  if (dest.id === a.app.id) bad("Choose another workspace")
  const allowed =
    a.actor.type === "agent"
      ? `SELECT count(*) FROM (${agentAccessSQL}) acl WHERE acl.agent_id=? AND acl.app_id IN (?,?) AND acl.role IN ('member','admin')`
      : `SELECT count(*) FROM members WHERE user_id=? AND app_id IN (?,?) AND role IN ('member','admin','owner')`
  const version = await sql(
    a.env,
    "SELECT revision FROM issues WHERE app_id=? AND number=?",
    a.app.id,
    n
  ).first<number>("revision")
  if (version === null) missing()
  const old = await full(a, n),
    id = old.id,
    at = now(),
    q: D1PreparedStatement[] = [
      sql(
        a.env,
        `UPDATE apps SET issue_seq=CASE WHEN (${allowed})=2 THEN issue_seq+1 ELSE NULL END WHERE id=?`,
        a.actor.id,
        a.app.id,
        dest.id,
        dest.id
      ),
      sql(
        a.env,
        `SELECT i.number FROM relations r JOIN issues i ON i.id=CASE WHEN r.source_id=?1 THEN r.target_id ELSE r.source_id END WHERE r.source_id=?1 OR r.target_id=?1`,
        id
      ),
      sql(a.env, "INSERT INTO issue_moves(from_app,from_number,issue_id) VALUES(?,?,?)", a.app.id, n, id),
      sql(
        a.env,
        `INSERT OR IGNORE INTO issue_labels SELECT il.issue_id,t.id FROM issue_labels il JOIN labels s ON s.id=il.label_id JOIN labels t ON t.app_id=? AND t.name=s.name WHERE il.issue_id=?`,
        dest.id,
        id
      ),
      sql(
        a.env,
        "DELETE FROM issue_labels WHERE issue_id=? AND label_id NOT IN (SELECT id FROM labels WHERE app_id=?)",
        id,
        dest.id
      ),
      sql(a.env, "DELETE FROM relations WHERE source_id=? OR target_id=?", id, id),
      sql(
        a.env,
        "UPDATE attachments SET app_id=? WHERE id IN (SELECT attachment_id FROM attachment_links WHERE issue_id=?)",
        dest.id,
        id
      ),
      sql(
        a.env,
        `UPDATE issues SET app_id=?1,number=(SELECT issue_seq FROM apps WHERE id=?1),pinned=0,template_id=NULL,reply_tier_id=NULL,activity=NULL,
      assignee=CASE WHEN json_extract(assignee,'$.id') IN(SELECT user_id FROM members WHERE app_id=?1 UNION ALL SELECT agent_id FROM (${agentAccessSQL}) WHERE app_id=?1 AND role IS NOT NULL) THEN assignee END,
      updated_at=max(updated_at,?2),revision=CASE WHEN revision=?3 AND app_id=?4 AND number=?5 THEN revision+1 END WHERE id=?6 RETURNING number`,
        dest.id,
        at,
        version,
        a.app.id,
        n,
        id
      )
    ],
    items: TimelineItem[] = []
  record(a, id, "transferred", { from: { slug: a.app.slug, number: n } }, at, q, items)
  q.push(
    entry(
      a.env,
      a.app.id,
      a.actor,
      "issue.transferred",
      { type: "issue", id, number: n, title: old.title },
      { to: dest.slug },
      "1"
    ),
    targetEntry(a.env, dest.id, a.actor, "issue.transferred", "issue", id, { from: a.app.slug, previous_number: n })
  )
  const results = await a.env.DB.batch<{ number: number }>(q),
    num = results[7]!.results[0]?.number ?? missing(),
    to = { slug: dest.slug, number: num, url: appUrl(a.env, a.origin, dest.slug, `/issues/${num}`) }
  const migrated: Access = { ...a, app: { ...dest, public: !!dest.public }, roles: undefined },
    issue = await full(migrated, num)
  const event: LiveEvent = { type: "issue.moved", issue_id: id, to },
    opts = { app: a.app.id, moved: { gate: gateOf(old), target: dest.id, number: n } }
  a.ctx.waitUntil(
    enqueueWebhooks(a.env, a.origin, a.app, a.actor, summaryOf(old), [{ type: "issue.moved", moved_to: to }])
  )
  a.ctx.waitUntil(
    Promise.all([
      appRoom(a.env, a.app.id).publishConversation([event], opts),
      issueRoom(a.env, id).publishConversation([event], opts)
    ])
  )
  for (const p of results[1]!.results)
    emit(a.env, a.ctx, {
      type: "issue.updated",
      app: a.app,
      origin: a.origin,
      actor: a.actor,
      issue: await summary(a, p.number),
      liveOnly: true
    })
  notify(migrated, { type: "issue.opened", issue: summaryOf(issue), items })
  return issue
}
export async function removeLabel(a: Access, id: string) {
  const { env, app, actor } = a,
    label = await sql(env, `SELECT ${labelCols} FROM labels WHERE id=? AND app_id=?`, id, app.id).first<Label>()
  if (!label) missing()
  const at = now(),
    prefix = uid(),
    data = { label },
    affected = "SELECT issue_id FROM issue_labels WHERE label_id=?"
  const results = await env.DB.batch<{ id: string; number: number }>([
    sql(env, `SELECT id,number FROM issues WHERE id IN (${affected})`, id),
    sql(
      env,
      `INSERT INTO issue_events SELECT ?||issue_id,issue_id,'unlabeled',?,?,? FROM issue_labels WHERE label_id=?`,
      prefix,
      JSON.stringify(actor),
      JSON.stringify(data),
      at,
      id
    ),
    sql(env, `UPDATE issues SET revision=revision+1,updated_at=max(updated_at,?) WHERE id IN (${affected})`, at, id),
    targetEntry(env, app.id, actor, "label.deleted", "label", id),
    sql(env, "DELETE FROM labels WHERE id=? AND app_id=?", id, app.id)
  ])
  for (const issue of results[0]!.results) {
    notify(a, {
      type: "issue.updated",
      issue: await summary(a, issue.number),
      changes: ["labels"],
      items: [{ kind: "event", event: { id: prefix + issue.id, type: "unlabeled", actor, data, created_at: at } }]
    })
  }
}
const base = "/api/apps/:slug/issues",
  path = `${base}/:number`
function findComment(issue: Awaited<ReturnType<typeof full>>, id: string) {
  for (const item of issue.timeline) if (item.kind === "comment" && item.comment.id === id) return item.comment
  return missing()
}
export async function editComment(a: Access, n: number, id: string, b: Record<string, unknown>) {
  const issue = await full(a, n),
    old = findComment(issue, id),
    text = str(b.body, "body", 65536, true),
    at = now()
  if (!old.viewer_is_author) denied()
  if (!seesComment({ team: can(a.role, "read"), actorId: a.actor.id }, old.hidden)) missing()
  if (!text.trim() && !old.attachments.length) bad("A comment needs text or an attachment")
  if (text === old.body) return old
  const v = who(a),
    ms = await mentionsIn(a.env, a.app.id, text, v.team)
  await a.env.DB.batch([
    sql(
      a.env,
      `INSERT INTO revisions SELECT ?,issue_id,id,?,NULL,body,? FROM comments WHERE id=? AND issue_id=?`,
      uid(),
      JSON.stringify(a.actor),
      at,
      id,
      issue.id
    ),
    sql(
      a.env,
      `UPDATE comments SET body=?,edited_at=?,updated_at=?,mentions=?,revision=CASE WHEN body=? AND json_extract(author,'$.id') IN(SELECT value FROM json_each(?)) AND
      (${v.team ? "1" : "hidden IS NULL"}) AND EXISTS(SELECT 1 FROM issues i WHERE i.id=comments.issue_id AND ${visibleSQL(v)}) THEN revision+1 END WHERE id=? AND issue_id=?`,
      text,
      at,
      at,
      JSON.stringify(ms),
      old.body,
      JSON.stringify(actorIds(v)),
      ...actorBindings(v),
      id,
      issue.id
    ),
    ...guestNameGuard(a),
    stillHere(a, issue.id),
    ...(!old.internal ? [sql(a.env, "UPDATE issues SET updated_at=max(updated_at,?) WHERE id=?", at, issue.id)] : [])
  ])
  const latest = await full(a, n),
    comment = findComment(latest, id)
  notify(a, {
    type: "issue.updated",
    issue: summaryOf(latest),
    comments: [comment],
    changes: ["comment.edited"],
    internalOnly: comment.internal,
    mentioned: addedMentions(ms, old.mentions, a.actor)
  })
  return comment
}
function purgeFiles(a: Access, files: { object_key: string }[]) {
  if (files.length)
    a.ctx.waitUntil(
      (async () => {
        for (let i = 0; i < files.length; i += 500)
          await a.env.MEDIA.delete(files.slice(i, i + 500).map((x) => x.object_key))
      })()
    )
}
async function deleteComment(a: Access, n: number, id: string) {
  const issue = await full(a, n),
    c = findComment(issue, id)
  if (!c.viewer_is_author && !can(a.role, "triage")) denied()
  const v = who(a)
  const [files, deleted] = await a.env.DB.batch<{ object_key: string }>([
    sql(
      a.env,
      `SELECT object_key FROM attachments WHERE id IN(SELECT attachment_id FROM attachment_links WHERE comment_id=? AND issue_id=?)`,
      id,
      issue.id
    ),
    sql(
      a.env,
      `DELETE FROM comments WHERE id=? AND issue_id=? AND EXISTS(SELECT 1 FROM issues i WHERE i.id=comments.issue_id AND ${visibleSQL(v)})
      AND (? OR json_extract(author,'$.id') IN(SELECT value FROM json_each(?)))`,
      id,
      issue.id,
      ...actorBindings(v),
      Number(can(a.role, "triage")),
      JSON.stringify(actorIds(v))
    ),
    entry(a.env, a.app.id, a.actor, "comment.deleted", { type: "comment", id, number: n }, { internal: c.internal }),
    ...(!c.internal
      ? [sql(a.env, "UPDATE issues SET updated_at=max(updated_at,?) WHERE id=? AND changes()>0", now(), issue.id)]
      : []),
    stillHere(a, issue.id),
    sql(
      a.env,
      `DELETE FROM webhook_deliveries WHERE app_id=? AND json_extract(payload,'$.comment.id')=? AND NOT EXISTS(SELECT 1 FROM comments WHERE id=?)`,
      a.app.id,
      id,
      id
    ),
    ...guestNameGuard(a)
  ])
  if (!deleted?.meta.changes) missing()
  purgeFiles(a, files!.results)
  notify(a, {
    type: "issue.updated",
    issue: await summary(a, n),
    deletedComment: id,
    removed: c,
    changes: ["comment.deleted"],
    internalOnly: c.internal
  })
}
export async function moderate(a: Access, n: number, id: string | null, hide: boolean, reason: unknown) {
  if (!can(a.role, "triage")) denied()
  const issue = await full(a, n),
    c = id ? findComment(issue, id) : null,
    at = now(),
    hidden: Moderation | null = hide
      ? { reason: choice(reason, ["spam", "abuse", "off_topic"] as const, "reason"), by: a.actor, at }
      : null
  const q: D1PreparedStatement[] = [],
    items: TimelineItem[] = []
  if ((c ? c.hidden : issue.hidden)?.reason === hidden?.reason) return c ?? issue
  if (c)
    q.push(
      sql(
        a.env,
        "UPDATE comments SET hidden=?,revision=revision+1 WHERE id=? AND issue_id=?",
        hidden ? JSON.stringify(hidden) : null,
        c.id,
        issue.id
      )
    )
  q.push(
    sql(
      a.env,
      `UPDATE issues SET ${!c ? "hidden=?," : ""}revision=revision+1${c?.internal ? "" : ",updated_at=max(updated_at,?)"} WHERE id=?`,
      ...(!c ? [hidden ? JSON.stringify(hidden) : null] : []),
      ...(c?.internal ? [] : [at]),
      issue.id
    )
  )
  record(
    a,
    issue.id,
    hide ? "hidden" : "unhidden",
    { ...(c ? { comment_id: c.id } : {}), ...(hidden ? { reason: hidden.reason } : {}) },
    at,
    q,
    items
  )
  await a.env.DB.batch([
    ...q,
    c
      ? entry(
          a.env,
          a.app.id,
          a.actor,
          `comment.${hide ? "hidden" : "unhidden"}`,
          { type: "comment", number: n, id: c.id },
          hidden ? { reason: hidden.reason } : {},
          "1"
        )
      : targetEntry(
          a.env,
          a.app.id,
          a.actor,
          `issue.${hide ? "hidden" : "unhidden"}`,
          "issue",
          issue.id,
          hidden ? { reason: hidden.reason } : {}
        ),
    stillHere(a, issue.id)
  ])
  const next = await full(a, n),
    comment = id ? findComment(next, id) : null
  notify(a, {
    type: "issue.updated",
    issue: summaryOf(next),
    items,
    comments: comment ? [comment] : [],
    changes: [c ? "comment.hidden" : "hidden"],
    internalOnly: !!c?.internal
  })
  return comment ?? next
}
async function deleteIssue(a: Access, n: number) {
  if (!can(a.role, "setup")) denied()
  const before = await summary(a, n)
  const [tomb, files, parents] = await a.env.DB.batch<unknown>([
    sql(
      a.env,
      `INSERT INTO issue_tombstones SELECT app_id,number FROM issues WHERE app_id=? AND number=? RETURNING number,
      (SELECT json_object('id',id,'reporter',json_extract(author,'$.id'),'private',private,'hidden',hidden IS NOT NULL) FROM issues WHERE app_id=? AND number=?) gate`,
      a.app.id,
      n,
      a.app.id,
      n
    ),
    sql(
      a.env,
      "SELECT object_key FROM attachments WHERE id IN(SELECT attachment_id FROM attachment_links WHERE issue_id=(SELECT id FROM issues WHERE app_id=? AND number=?))",
      a.app.id,
      n
    ),
    sql(
      a.env,
      `SELECT i.number FROM issues i JOIN relations r ON r.target_id=i.id WHERE i.app_id=?1 AND r.type='duplicate_of' AND r.source_id=(SELECT id FROM issues WHERE app_id=?1 AND number=?2)`,
      a.app.id,
      n
    ),
    sql(
      a.env,
      "DELETE FROM issue_events WHERE json_extract(data,'$.relation.issue.id')=(SELECT id FROM issues WHERE app_id=? AND number=?)",
      a.app.id,
      n
    ),
    sql(
      a.env,
      "DELETE FROM webhook_deliveries WHERE app_id=? AND json_extract(payload,'$.issue.id')=(SELECT id FROM issues WHERE app_id=? AND number=?)",
      a.app.id,
      a.app.id,
      n
    ),
    targetEntry(a.env, a.app.id, a.actor, "issue.deleted", "issue", before.id),
    sql(a.env, "DELETE FROM issues WHERE app_id=? AND number=?", a.app.id, n)
  ])
  if (!tomb?.results.length) missing()
  const g = JSON.parse((tomb.results[0] as { gate: string }).gate) as {
      id: string
      reporter: string
      private: number
      hidden: number
    },
    gate = { reporter: g.reporter, private: !!g.private, hidden: !!g.hidden }
  purgeFiles(a, files!.results as { object_key: string }[])
  a.ctx.waitUntil(enqueueWebhooks(a.env, a.origin, a.app, a.actor, before, [{ type: "issue.deleted" }]))
  const event: LiveEvent = { type: "issue.deleted", issue_id: g.id, number: n }
  a.ctx.waitUntil(
    Promise.all([
      appRoom(a.env, a.app.id).publishConversation([event], { app: a.app.id, deleted: gate }),
      issueRoom(a.env, g.id).publishConversation([event], { app: a.app.id, deleted: gate })
    ])
  )
  for (const p of parents!.results as { number: number }[])
    emit(a.env, a.ctx, {
      app: a.app,
      origin: a.origin,
      actor: a.actor,
      type: "issue.updated",
      issue: await summary(a, p.number),
      liveOnly: true
    })
}
async function history(a: Access, n: number, id?: string) {
  const issue = await full(a, n),
    v = who(a)
  if (id && !seesComment(v, findComment(issue, id).hidden)) missing()
  const [versions, team] = await Promise.all([
    rows<Omit<Revision, "actor"> & { actor: string }>(
      sql(
        a.env,
        `SELECT r.id,r.actor,r.title,r.body,r.created_at FROM revisions r JOIN issues i ON i.id=r.issue_id
     LEFT JOIN comments c ON c.id=r.comment_id WHERE i.app_id=? AND r.issue_id=? AND r.comment_id IS ? AND ${visibleSQL(v)} ${v.team ? "" : "AND c.hidden IS NULL AND coalesce(c.internal,0)=0"} ORDER BY r.created_at DESC,r.rowid DESC`,
        a.app.id,
        issue.id,
        id ?? null,
        ...actorBindings(v)
      )
    ),
    roles(a)
  ])
  const result = versions.map((r) => ({ ...r, actor: parseActor(r.actor, team) }))
  return v.team ? teamProjection(a.env, a.app.id, result) : result
}
async function blockActor(a: Access, b: Record<string, unknown>): Promise<Block> {
  const actorId = str(b.actor_id, "actor_id", 64),
    id = uid(),
    at = now(),
    app = a.app.id,
    env = a.env
  if (b.hide_content !== undefined && typeof b.hide_content !== "boolean") bad("Invalid hide_content")
  const raw = await sql(
    env,
    `SELECT author FROM issues WHERE app_id=?1 AND json_extract(author,'$.type')!='agent' AND json_extract(author,'$.id')=?2
      UNION ALL SELECT c.author FROM comments c JOIN issues i ON i.id=c.issue_id WHERE i.app_id=?1 AND json_extract(c.author,'$.type')!='agent' AND json_extract(c.author,'$.id')=?2 LIMIT 1`,
    app,
    actorId
  ).first<string>("author")
    const actor: Actor = JSON.parse(raw ?? missing())
    if (actor.type === "guest") actor.name ??= null
  const hidden = JSON.stringify({ reason: "spam", by: a.actor, at }),
    target = "SELECT id FROM issues WHERE app_id=?1",
    auth = "json_extract(author,'$.id')=?2"
  const q = [
    sql(
      env,
      `INSERT INTO blocks SELECT ?1,?2,?3,?4,?5,?6 WHERE NOT EXISTS(SELECT 1 FROM members WHERE app_id=?2 AND user_id=?3) AND
       (EXISTS(SELECT 1 FROM issues WHERE app_id=?2 AND json_extract(author,'$.id')=?3) OR EXISTS(SELECT 1 FROM comments c JOIN issues i ON i.id=c.issue_id WHERE i.app_id=?2 AND json_extract(c.author,'$.id')=?3))`,
      id,
      app,
      actorId,
      JSON.stringify(actor),
      JSON.stringify(a.actor),
      at
    )
  ]
  if (b.hide_content) {
    const exists = "EXISTS(SELECT 1 FROM blocks WHERE id=?3)"
    q.push(
      sql(
        env,
        `INSERT INTO issue_events SELECT ?3||'-i-'||id,id,'hidden',?4,'{"reason":"spam"}',?5 FROM issues WHERE app_id=?1 AND ${auth} AND hidden IS NULL AND ${exists}`,
        app,
        actorId,
        id,
        JSON.stringify(a.actor),
        at
      ),
      sql(
        env,
        `INSERT INTO issue_events SELECT ?3||'-c-'||id,issue_id,'hidden',?4,json_object('reason','spam','comment_id',id),?5 FROM comments WHERE issue_id IN (${target}) AND ${auth} AND hidden IS NULL AND ${exists}`,
        app,
        actorId,
        id,
        JSON.stringify(a.actor),
        at
      ),
      sql(
        env,
        `UPDATE issues SET hidden=?4,revision=revision+1,updated_at=max(updated_at,?5) WHERE app_id=?1 AND ${auth} AND hidden IS NULL AND ${exists} RETURNING id issue_id`,
        app,
        actorId,
        id,
        hidden,
        at
      ),
      sql(
        env,
        `UPDATE comments SET hidden=?4,revision=revision+1 WHERE issue_id IN (${target}) AND ${auth} AND hidden IS NULL AND ${exists} RETURNING id,issue_id`,
        app,
        actorId,
        id,
        hidden
      )
    )
  }
  q.push(
    entry(
      env,
      app,
      a.actor,
      "actor.blocked",
      { type: "actor", id: actorId },
      { hide_content: !!b.hide_content },
      "EXISTS(SELECT 1 FROM blocks WHERE app_id=? AND id=?)",
      [app, id]
    )
  )
  const result = await env.DB.batch<{ issue_id: string; id?: string }>(q)
  if (!result[0]?.meta.changes) denied()
  if (b.hide_content)
    a.ctx.waitUntil(
      (async () => {
        const affected = new Map<string, Set<string>>()
        for (const row of [...result[3]!.results, ...result[4]!.results]) {
          const cs = affected.get(row.issue_id) ?? new Set<string>()
          if (row.id) cs.add(row.id)
          affected.set(row.issue_id, cs)
        }
        for (const [iid, cs] of affected) {
          const num = await sql(env, "SELECT number FROM issues WHERE id=? AND app_id=?", iid, app).first<number>(
            "number"
          )
          if (!num) continue
          const i = await full(a, num)
          const comments = i.timeline.flatMap((t) => (t.kind === "comment" && cs.has(t.comment.id) ? [t.comment] : []))
          notify(a, {
            type: "issue.updated",
            issue: summaryOf(i),
            changes: ["moderation"],
            items: i.timeline.filter((t) => t.kind === "event" && t.event.id.startsWith(id + "-")),
            comments,
            internalOnly:
              comments.length > 0 &&
              comments.every((c) => c.internal) &&
              !result[3]!.results.some((r) => r.issue_id === iid)
          })
        }
      })()
    )
  return teamProjection(env, app, { id, actor, by: a.actor, created_at: at })
}
export const issues = new Hono<Bindings>()
issues.on(["POST", "DELETE"], `${path}/vote`, async (c) => {
  await allowWrite(c)
  return c.json(await react(access(c), issueNumber(c.req.param("number")), null, c.req.method === "POST"))
})
issues.on(["POST", "DELETE"], `${path}/comments/:id/helpful`, async (c) => {
  await allowWrite(c)
  return c.json(await react(access(c), issueNumber(c.req.param("number")), c.req.param("id"), c.req.method === "POST"))
})
issues.post(`${path}/transfer`, async (c) => {
  requireTeam(c, "triage")
  return c.json(await transferIssue(access(c), issueNumber(c.req.param("number")), (await body(c)).app))
})
issues.delete(path, async (c) => {
  requireTeam(c, "setup")
  await deleteIssue(access(c), issueNumber(c.req.param("number")))
  return c.json({ ok: true })
})
issues.get(`${path}/history`, async (c) => c.json(await history(access(c), issueNumber(c.req.param("number")))))
const commentPath = `${path}/comments/:id`
issues.get(`${commentPath}/history`, async (c) =>
  c.json(await history(access(c), issueNumber(c.req.param("number")), c.req.param("id")))
)
issues.patch(commentPath, async (c) => {
  await allowWrite(c)
  return c.json(await editComment(access(c), issueNumber(c.req.param("number")), c.req.param("id"), await body(c)))
})
issues.delete(commentPath, async (c) => {
  await allowWrite(c)
  await deleteComment(access(c), issueNumber(c.req.param("number")), c.req.param("id"))
  return c.json({ ok: true })
})
for (const route of [`${path}/hide`, `${commentPath}/hide`])
  issues.on(["POST", "DELETE"], route, async (c) => {
    requireTeam(c, "triage")
    const hide = c.req.method === "POST"
    return c.json(
      await moderate(
        access(c),
        issueNumber(c.req.param("number")),
        c.req.param("id") ?? null,
        hide,
        hide ? (await body(c)).reason : null
      )
    )
  })
issues.get("/api/apps/:slug/blocks", async (c) => {
  requireTeam(c, "triage")
  const [bs, team] = await Promise.all([
    rows<{ id: string; actor: string; moderator: string; created_at: string }>(
      sql(
        c.env,
        "SELECT id,actor,moderator,created_at FROM blocks WHERE app_id=? ORDER BY created_at DESC",
        c.var.app.id
      )
    ),
    appRoles(c.env, c.var.app.id)
  ])
  return c.json(
    await teamProjection(
      c.env,
      c.var.app.id,
      bs.map((r) => ({
        id: r.id,
        actor: parseActor(r.actor, team),
        by: parseActor(r.moderator, team),
        created_at: r.created_at
      }))
    )
  )
})
issues.post("/api/apps/:slug/blocks", async (c) => {
  requireTeam(c, "triage")
  return c.json(await blockActor(access(c), await body(c)), 201)
})
issues.delete("/api/apps/:slug/blocks/:id", async (c) => {
  requireTeam(c, "triage")
  const app = c.var.app.id,
    id = c.req.param("id"),
    [, deleted] = await c.env.DB.batch([
      sql(
        c.env,
        `INSERT INTO audit_log(app_id,actor,action,target,data) SELECT app_id,?,'actor.unblocked',json_object('type','actor','id',actor_id),json_object('block_id',id) FROM blocks WHERE app_id=? AND id=?`,
        auditActor(c.var.actor),
        app,
        id
      ),
      sql(c.env, "DELETE FROM blocks WHERE app_id=? AND id=?", app, id)
    ])
  if (!deleted!.meta.changes) missing()
  return c.json({ ok: true })
})
issues.post(base, async (c) => {
  const b = await postBody(c)
  return c.json(await createIssue(access(c), b), 201)
})
issues.patch(path, async (c) => {
  await allowWrite(c)
  return c.json(await updateIssue(access(c), issueNumber(c.req.param("number")), await body(c)))
})
issues.post(`${path}/comments`, async (c) => {
  await allowWrite(c)
  const n = issueNumber(c.req.param("number")),
    b = await body(c),
    a = access(c),
    target = await commentTarget(a, n, b)
  await namedPost(c, b)
  a.actor = c.var.actor
  return c.json(await addComment(a, n, b, target), 201)
})
issues.post(`${path}/relations`, async (c) => {
  requireTeam(c, "triage")
  const b = await body(c)
  return c.json(
    await relate(
      access(c),
      issueNumber(c.req.param("number")),
      issueNumber(b.number),
      choice(b.type, ["related", "duplicate_of", "blocks"] as const, "type")
    )
  )
})
issues.delete(`${path}/relations/:id`, async (c) => {
  requireTeam(c, "triage")
  const a = access(c),
    n = issueNumber(c.req.param("number")),
    id = c.req.param("id"),
    r = await sql(
      c.env,
      `SELECT s.number source,t.number target,r.type FROM relations r JOIN issues s ON s.id=r.source_id JOIN issues t ON t.id=r.target_id WHERE r.id=? AND s.app_id=? AND (s.number=? OR t.number=?)`,
      id,
      a.app.id,
      n,
      n
    ).first<{ source: number; target: number; type: Relation["type"] }>()
  if (!r) missing()
  const source = await relate(a, r.source, r.target, r.type, id)
  return c.json(n === r.source ? source : await full(a, n))
})
issues.delete("/api/apps/:slug/labels/:id", async (c) => {
  requireTeam(c, "setup")
  await removeLabel(access(c), c.req.param("id"))
  return c.json({ ok: true })
})
