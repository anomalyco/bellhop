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
  Relation,
  SystemInfo,
  TimelineItem
} from "../shared/api"
import { assignee, labelCols, selectedLabels } from "./apps"
import { allowWrite, postBody } from "./auth"
import { bad, body, choice, denied, ids, input, missing, now, rows, sql, str, uid } from "./core"
import { can, requireTeam } from "./permissions"
import type { Bindings, Ctx } from "./core"
import { emit, setActivity } from "./events"
import type { Change, Work } from "./events"
import { guestWrite } from "./guest-history"
import { appRoles, attachment, getIssue, issueNumber, issueSummary, ref, summaryOf } from "./issues"
import type { AttachmentRow } from "./issues"

export interface Access {
  env: Env
  ctx: Work
  app: Pick<App, "id" | "slug" | "name">
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
const roles = (a: Access) => a.roles ??= appRoles(a.env, a.app.id)
const full = (a: Access, n: number) => getIssue(a.env, a.app.id, n, a.actor, can(a.role, "read"))
const summary = (a: Access, n: number) => issueSummary(a.env, a.app.id, n, roles(a))
// A rename can commit between loading the request actor and writing its JSON snapshot. Usually this
// matches no rows; a stale guest would violate NOT NULL and roll back the entire post or event.
function guestNameGuard(a: Access) {
  return a.actor.type === "guest" ? [
    sql(a.env, "UPDATE guest_names SET name=NULL WHERE guest_hash=? AND name IS NOT ?", a.guestHash, a.actor.name),
    guestWrite(a.env, a.guestHash!)
  ] : []
}
function notify(a: Access, payload: Pick<Change, "type" | "issue" | "items" | "changes">) {
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
      `INSERT INTO issues(id,app_id,number,title,body,author,system_info,template_id,created_at,updated_at)
    SELECT ?,id,issue_seq,?,?,?,?,?,?,? FROM apps WHERE id=? RETURNING number`,
      id,
      title,
      text,
      JSON.stringify(actor),
      info ? JSON.stringify(info) : null,
      template,
      at,
      at,
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
  if (!text.trim() && !links.length) bad("A comment needs text or an attachment")
  await env.DB.batch([
    sql(env, "INSERT INTO comments VALUES(?,?,?,?,?,?)", id, s.id, JSON.stringify(actor), text, at, at),
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
    updated_at: at
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
  const version = await sql(env, "SELECT revision FROM issues WHERE app_id=? AND number=?", app.id, n).first<number>(
    "revision"
  )
  if (version === null) missing()
  const issue = await full(a, n),
    keys = Object.keys(b),
    supported = ["title", "body", "status", "close_reason", "label_ids", "assignee_id"]
  if (!can(a.role, "triage") && (!issue.viewer_is_author || keys.some((k) => k !== "title" && k !== "body") || claim))
    denied()
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
      `UPDATE issues SET ${[...set, "updated_at=max(updated_at,?)", "revision=CASE WHEN revision=? THEN revision+1 ELSE NULL END"].join(",")} WHERE id=?`,
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
export const issues = new Hono<Bindings>()
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
