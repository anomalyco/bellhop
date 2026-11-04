import { Hono } from "hono"
import type {
  Actor,
  AgentRole,
  App,
  CloseReason,
  Comment,
  IssueEvent,
  IssueRef,
  Label,
  LiveEvent,
  Block,
  Moderation,
  Revision,
  Relation,
  SystemInfo,
  TimelineItem
} from "../shared/api"
import { assignee, labelCols, selectedLabels } from "./apps"
import { allowWrite, postBody } from "./auth"
import { bad, body, choice, denied, ids, input, missing, now, rows, sql, str, uid } from "./core"
import { can, requireTeam } from "./permissions"
import type { Bindings, Ctx } from "./core"
import { appRoom, issueRoom, emit, setActivity } from "./events"
import { actorBindings, gateOf, sees, seesComment, visibleSQL } from "./visibility"
import type { Change, Work } from "./events"
import { guestWrite } from "./guest-history"
import { appRoles, attachment, getIssue, issueNumber, issueSummary, parseActor, ref, summaryOf } from "./issues"
import type { AttachmentRow } from "./issues"

export interface Access {
  env: Env
  ctx: Work
  app: Pick<App, "id" | "slug" | "name" | "public">
  actor: Actor
  roles?: ReturnType<typeof appRoles>
  guestHash?: string
  role: App["role"] | AgentRole
  origin: string
}
function access(c: Ctx): Access {
  return {
    env: c.env,
    ctx: c.executionCtx,
    app: c.var.app,
    actor: c.var.actor,
    guestHash: c.var.guestHash,
    role: c.var.app.role,
    origin: c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin
  }
}
const roles = (a: Access) => (a.roles ??= appRoles(a.env, a.app.id))
const full = (a: Access, n: number) => getIssue(a.env, a.app.id, n, a.actor, can(a.role, "read"))
const summary = (a: Access, n: number) => issueSummary(a.env, a.app.id, n, roles(a))
// A rename can commit between loading the request actor and writing its JSON snapshot. Usually this
// matches no rows; a stale guest would violate NOT NULL and roll back the entire post or event.
function guestNameGuard(a: Access) {
  const guard = can(a.role, "read")
    ? []
    : [sql(a.env, "UPDATE blocks SET actor_id=NULL WHERE app_id=? AND actor_id=?", a.app.id, a.actor.id)]
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
  payload: Pick<Change, "type" | "issue" | "items" | "changes" | "comments" | "deletedComment">
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
  const q = [
    sql(env, "UPDATE apps SET issue_seq=issue_seq+1 WHERE id=?", app.id),
    sql(
      env,
      `INSERT INTO issues(id,app_id,number,title,body,author,system_info,template_id,created_at,updated_at,private)
    SELECT ?,id,issue_seq,?,?,?,?,?,?,?,CASE WHEN (reporter_can_choose OR ?) THEN coalesce(?,default_private) ELSE default_private END FROM apps WHERE id=? RETURNING number`,
      id,
      title,
      text,
      JSON.stringify(actor),
      info ? JSON.stringify(info) : null,
      template,
      at,
      at,
      Number(can(a.role, "read")),
      b.private === undefined ? null : Number(b.private),
      app.id
    ),
    ...attach(env, id, null, b.attachment_ids),
    ...guestNameGuard(a)
  ]
  const items: TimelineItem[] = []
  for (const label of labels) {
    q.push(sql(env, "INSERT INTO issue_labels VALUES(?,?)", id, label.id))
    record(a, id, "labeled", { label }, at, q, items)
  }
  const results = await env.DB.batch<{ number: number }>(q),
    number = results[1]!.results[0]!.number
  const issue = await full(a, number)
  notify(a, { type: "issue.opened", issue: summaryOf(issue), items })
  return issue
}
export async function addComment(a: Access, n: number, b: Record<string, unknown>): Promise<Comment> {
  const { env, actor, app } = a,
    s = await summary(a, n),
    at = now(),
    id = uid(),
    text = str(b.body, "body", 65536, true)
  const links = attach(env, s.id, id, b.attachment_ids)
  const v = { team: can(a.role, "read"), actorId: actor.id }
  if (!sees(v, gateOf(s))) missing()
  if (!text.trim() && !links.length) bad("A comment needs text or an attachment")
  await env.DB.batch([
    sql(
      env,
      `INSERT INTO comments(id,issue_id,author,body,created_at,updated_at) VALUES(?,(SELECT id FROM issues i WHERE id=? AND ${visibleSQL(v)}),?,?,?,?)`,
      id,
      s.id,
      ...actorBindings(v),
      JSON.stringify(actor),
      text,
      at,
      at
    ),
    ...links,
    ...guestNameGuard(a),
    sql(env, "UPDATE issues SET updated_at=max(updated_at,?) WHERE id=?", at, s.id)
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
  const comment: Comment = {
    id,
    author: actor,
    body: text,
    attachments: files.map(attachment),
    by_issue_author: actor.id === s.author.id,
    created_at: at,
    updated_at: at,
    hidden: null,
    edited_at: null,
    viewer_is_author: true
  }
  if (actor.type === "agent") await setActivity(env, app.id, s.id, actor, null, true)
  notify(a, {
    type: "comment.created",
    issue: await summary(a, n),
    items: [{ kind: "comment", comment }]
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
    supported = ["title", "body", "status", "close_reason", "label_ids", "assignee_id", "private"]
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
  if (b.body !== undefined) {
    const text = str(b.body, "body", 65536, true)
    if (text !== issue.body) field("body", text)
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
  await env.DB.batch([...q, ...guestNameGuard(a)])
  const next = await full(a, n)
  notify(a, { type: "issue.updated", issue: summaryOf(next), changes, items })
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
  await env.DB.batch(q)
  const next = await full(a, n),
    otherSummary = await summary(a, other)
  notify(a, { type: "issue.updated", issue: summaryOf(next), items: items[0], changes: ["relations"] })
  notify(a, { type: "issue.updated", issue: otherSummary, items: items[1], changes: ["relations"] })
  return next
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
  const v = { team: can(a.role, "read"), actorId: a.actor.id }
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
      `UPDATE comments SET body=?,edited_at=?,updated_at=?,revision=CASE WHEN body=? AND json_extract(author,'$.id')=? AND
      (${v.team ? "1" : "hidden IS NULL"}) AND EXISTS(SELECT 1 FROM issues i WHERE i.id=comments.issue_id AND ${visibleSQL(v)}) THEN revision+1 END WHERE id=? AND issue_id=?`,
      text,
      at,
      at,
      old.body,
      a.actor.id,
      ...actorBindings(v),
      id,
      issue.id
    ),
    ...guestNameGuard(a),
    sql(a.env, "UPDATE issues SET updated_at=max(updated_at,?) WHERE id=?", at, issue.id)
  ])
  const latest = await full(a, n),
    comment = findComment(latest, id)
  notify(a, { type: "issue.updated", issue: summaryOf(latest), comments: [comment], changes: ["comment.edited"] })
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
  const v = { team: can(a.role, "read"), actorId: a.actor.id }
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
      AND (? OR json_extract(author,'$.id')=?)`,
      id,
      issue.id,
      ...actorBindings(v),
      Number(can(a.role, "triage")),
      a.actor.id
    ),
    sql(a.env, "UPDATE issues SET updated_at=max(updated_at,?) WHERE id=? AND changes()>0", now(), issue.id),
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
  notify(a, { type: "issue.updated", issue: await summary(a, n), deletedComment: id, changes: ["comment.deleted"] })
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
      `UPDATE issues SET ${!c ? "hidden=?," : ""}revision=revision+1,updated_at=max(updated_at,?) WHERE id=?`,
      ...(!c ? [hidden ? JSON.stringify(hidden) : null] : []),
      at,
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
  await a.env.DB.batch(q)
  const next = await full(a, n),
    comment = id ? findComment(next, id) : null
  notify(a, {
    type: "issue.updated",
    issue: summaryOf(next),
    items,
    comments: comment ? [comment] : [],
    changes: [c ? "comment.hidden" : "hidden"]
  })
  return comment ?? next
}
async function deleteIssue(a: Access, n: number) {
  if (!can(a.role, "setup")) denied()
  const [tomb, files] = await a.env.DB.batch<unknown>([
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
  const event: LiveEvent = { type: "issue.deleted", issue_id: g.id, number: n }
  a.ctx.waitUntil(
    Promise.all([
      appRoom(a.env, a.app.id).publish([event], { deleted: gate }),
      issueRoom(a.env, g.id).publish([event], { deleted: gate })
    ])
  )
}
async function history(a: Access, n: number, id?: string) {
  const issue = await full(a, n),
    v = { team: can(a.role, "read"), actorId: a.actor.id }
  if (id && !seesComment(v, findComment(issue, id).hidden)) missing()
  const [versions, team] = await Promise.all([
    rows<Omit<Revision, "actor"> & { actor: string }>(
      sql(
        a.env,
        `SELECT r.id,r.actor,r.title,r.body,r.created_at FROM revisions r JOIN issues i ON i.id=r.issue_id
    LEFT JOIN comments c ON c.id=r.comment_id WHERE r.issue_id=? AND r.comment_id IS ? AND ${visibleSQL(v)} ${v.team ? "" : "AND c.hidden IS NULL"} ORDER BY r.created_at DESC,r.rowid DESC`,
        issue.id,
        id ?? null,
        ...actorBindings(v)
      )
    ),
    roles(a)
  ])
  return versions.map((r) => ({ ...r, actor: parseActor(r.actor, team) }))
}
async function blockActor(a: Access, b: Record<string, unknown>): Promise<Block> {
  const actorId = str(b.actor_id, "actor_id", 64),
    id = uid(),
    at = now(),
    app = a.app.id,
    env = a.env
  if (b.hide_content !== undefined && typeof b.hide_content !== "boolean") bad("Invalid hide_content")
  const u = await sql(env, "SELECT id,name,avatar_url FROM users WHERE id=?", actorId).first<{
    id: string
    name: string
    avatar_url: string | null
  }>()
  let actor: Actor
  if (u) actor = { type: "member", ...u, role: null }
  else {
    const raw = await sql(
      env,
      `SELECT author FROM issues WHERE app_id=?1 AND json_extract(author,'$.type')='guest' AND json_extract(author,'$.id')=?2
      UNION ALL SELECT c.author FROM comments c JOIN issues i ON i.id=c.issue_id WHERE i.app_id=?1 AND json_extract(c.author,'$.type')='guest' AND json_extract(c.author,'$.id')=?2 LIMIT 1`,
      app,
      actorId
    ).first<string>("author")
    if (!raw && !/^[a-f0-9]{32}$/.test(actorId)) missing()
    actor = raw ? JSON.parse(raw) : { type: "guest", id: actorId, handle: `guest-${actorId.slice(0, 4)}`, name: null }
    if (actor.type === "guest") actor.name ??= null
  }
  const hidden = JSON.stringify({ reason: "spam", by: a.actor, at }),
    target = "SELECT id FROM issues WHERE app_id=?1",
    auth = "json_extract(author,'$.id')=?2"
  const q = [
    sql(
      env,
      `INSERT INTO blocks SELECT ?,?,?,?, ?,? WHERE NOT EXISTS(SELECT 1 FROM members WHERE app_id=? AND user_id=?)`,
      id,
      app,
      actorId,
      JSON.stringify(actor),
      JSON.stringify(a.actor),
      at,
      app,
      actorId
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
          notify(a, {
            type: "issue.updated",
            issue: summaryOf(i),
            changes: ["moderation"],
            items: i.timeline.filter((t) => t.kind === "event" && t.event.id.startsWith(id + "-")),
            comments: i.timeline.flatMap((t) => (t.kind === "comment" && cs.has(t.comment.id) ? [t.comment] : []))
          })
        }
      })()
    )
  return { id, actor, by: a.actor, created_at: at }
}
export const issues = new Hono<Bindings>()
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
    bs.map((r) => ({
      id: r.id,
      actor: parseActor(r.actor, team),
      by: parseActor(r.moderator, team),
      created_at: r.created_at
    }))
  )
})
issues.post("/api/apps/:slug/blocks", async (c) => {
  requireTeam(c, "triage")
  return c.json(await blockActor(access(c), await body(c)), 201)
})
issues.delete("/api/apps/:slug/blocks/:id", async (c) => {
  requireTeam(c, "triage")
  if (
    !(await sql(c.env, "DELETE FROM blocks WHERE app_id=? AND id=?", c.var.app.id, c.req.param("id")).run()).meta
      .changes
  )
    missing()
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
  const b = await postBody(c)
  return c.json(await addComment(access(c), issueNumber(c.req.param("number")), b), 201)
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
