import { Hono } from "hono"
import type { Actor, Group, Escalation } from "../shared/api"
import { bad, body, choice, denied, fail, input, missing, now, sql, str, uid, type Bindings, type Ctx } from "./core"
import { requireTeam, agentAccessSQL } from "./permissions"
import { memberGrant } from "./approvals"
import { entry } from "./audit"
import { issueNumber, getIssue } from "./issues"
import { actorIds } from "./visibility"
import { guard, onDuty, startPlan, publishHandoff, endHandoff } from "./handoff"
import { enforce, clientIP } from "./rate-limits"
import { allowWrite } from "./auth"
import { liveGuard, type Scope } from "./v1/access"
import { serverGuard } from "./v1/server-auth"
import { conversations } from "./v1/conversations"
import { workspaceConversations } from "./v1/server"
import { contactActor, contactHash } from "./contact-session"

const setup = `SELECT 1 FROM members m JOIN apps a ON a.id=m.app_id WHERE a.mode='helpdesk' AND a.id=? AND m.user_id=? AND m.role IN ('admin','owner')`
function desk(c: Ctx) {
  if (!c.var.desk) fail(403, "helpdesk_only", "Help desk workspace required")
}
export async function groups(env: Env, app: string) {
  const rs = await sql(
    env,
    `SELECT g.id,g.name,g.strategy,g.hours,g.response_minutes,(SELECT json_group_array(user_id ORDER BY position) FROM handoff_roster WHERE group_id=g.id) members,
    (SELECT json_group_array(user_id ORDER BY position) FROM handoff_roster WHERE group_id=g.id AND available) available FROM handoff_groups g JOIN apps a ON a.id=g.app_id AND a.mode='helpdesk' WHERE g.app_id=? ORDER BY g.name,g.id`,
    app
  ).all<
    Omit<Group, "member_ids" | "available_ids" | "hours"> & { hours: string | null; members: string; available: string }
  >()
  return rs.results.map(({ members, available, hours, ...g }): Group => {
    const h: Group["hours"] = hours ? JSON.parse(hours) : null
    return {
      ...g,
      hours: h,
      member_ids: JSON.parse(members),
      available_ids: onDuty(h, now()) ? JSON.parse(available) : []
    }
  })
}
function schedule(v: unknown): Group["hours"] {
  if (v === null) return null
  const h = input(v),
    timezone = str(h.timezone, "timezone", 100),
    start = str(h.start, "start", 5),
    end = str(h.end, "end", 5)
  if (/^[+-]/.test(timezone)) bad("Expected an IANA timezone")
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone })
  } catch {
    bad("Expected an IANA timezone")
  }
  if (
    !Array.isArray(h.days) ||
    !h.days.length ||
    h.days.length > 7 ||
    h.days.some((n) => !Number.isInteger(n) || n < 0 || n > 6) ||
    new Set(h.days).size !== h.days.length
  )
    bad("days must be unique integers from 0 to 6")
  if (![start, end].every((s) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s)) || start === end)
    bad("Expected distinct HH:MM times")
  return { timezone, start, end, days: h.days }
}
const base = "/api/apps/:slug",
  groupPath = base + "/groups",
  issuePath = base + "/issues/:number"
export const handoffRoutes = new Hono<Bindings>()
handoffRoutes.get(groupPath, async (c) => {
  desk(c)
  requireTeam(c, "read")
  return c.json(await groups(c.env, c.var.app.id))
})
async function save(c: Ctx, id?: string) {
  desk(c)
  requireTeam(c, "setup")
  const app = c.var.app.id,
    b = await body(c),
    key = id ?? "grp_" + uid(),
    env = c.env
  const old = id
    ? ((await sql(
        env,
        "SELECT name,hours,strategy,response_minutes,version FROM handoff_groups WHERE id=? AND app_id=?",
        id,
        app
      ).first<{
        name: string
        hours: string | null
        strategy: Group["strategy"]
        response_minutes: number | null
        version: number
      }>()) ?? missing())
    : null
  const name = b.name === undefined && old ? old.name : str(b.name, "name", 120).trim(),
    strategy =
      b.strategy === undefined
        ? (old?.strategy ?? "round_robin")
        : choice(b.strategy, ["round_robin", "least_busy"] as const, "strategy"),
    hours = b.hours === undefined ? (old?.hours ?? null) : JSON.stringify(schedule(b.hours)),
    window = b.response_minutes === undefined ? (old?.response_minutes ?? null) : b.response_minutes
  if (
    !Object.keys(b).length ||
    Object.keys(b).some((k) => !["name", "member_ids", "strategy", "hours", "response_minutes"].includes(k))
  )
    bad("Unknown or missing group field")
  if (window !== null && (typeof window !== "number" || !Number.isInteger(window) || window < 5 || window > 1440))
    bad("response_minutes must be 5–1440 or null")
  const ids = b.member_ids
  if (
    (!old || ids !== undefined) &&
    (!Array.isArray(ids) ||
      ids.length > 200 ||
      ids.some((x) => typeof x !== "string" || !x || x.length > 100) ||
      new Set(ids).size !== ids.length)
  )
    bad("Invalid member_ids")
  const q = [guard(env, `EXISTS(${setup})`, app, c.var.user!.id)]
  if (old)
    q.push(
      guard(env, "EXISTS(SELECT 1 FROM handoff_groups WHERE id=? AND app_id=? AND version=?)", key, app, old.version)
    )
  q.push(
    old
      ? sql(
          env,
          "UPDATE handoff_groups SET name=?,strategy=?,hours=?,response_minutes=?,version=version+1 WHERE id=? AND app_id=?",
          name,
          strategy,
          hours === "null" ? null : hours,
          window,
          key,
          app
        )
      : sql(
          env,
          "INSERT INTO handoff_groups(id,app_id,name,strategy,hours,response_minutes) VALUES(?,?,?,?,?,?)",
          key,
          app,
          name,
          strategy,
          hours === "null" ? null : hours,
          window
        )
  )
  if (Array.isArray(ids)) {
    const json = JSON.stringify(ids),
      eligible =
        "SELECT m.id,j.key FROM json_each(?) j JOIN members m ON m.user_id=j.value AND m.app_id=? AND m.role IN ('owner','admin','member')"
    if ((await sql(env, `SELECT count(*) n FROM (${eligible})`, json, app).first<number>("n")) !== ids.length)
      bad("Group members must be current workspace members (member or higher)")
    q.push(
      guard(env, `(SELECT count(*) FROM (${eligible}))=?`, json, app, ids.length),
      sql(env, "DELETE FROM handoff_members WHERE group_id=?", key),
      sql(env, `INSERT INTO handoff_members SELECT ?,id,CAST(key AS INTEGER) FROM (${eligible})`, key, json, app)
    )
  }
  q.push(
    entry(
      env,
      app,
      c.var.actor,
      old ? "group.updated" : "group.created",
      { type: "group", id: key },
      { fields: Object.keys(b) },
      "1"
    )
  )
  await env.DB.batch(q)
  return c.json((await groups(env, app)).find((g) => g.id === key)!, old ? 200 : 201)
}
handoffRoutes.post(groupPath, (c) => save(c))
handoffRoutes.patch(groupPath + "/:id", (c) => save(c, c.req.param("id")))
handoffRoutes.delete(groupPath + "/:id", async (c) => {
  desk(c)
  requireTeam(c, "setup")
  const env = c.env,
    app = c.var.app.id,
    id = c.req.param("id"),
    at = now()
  const result = await env.DB.batch<{ id: string }>([
    guard(env, `EXISTS(${setup})`, app, c.var.user!.id),
    sql(
      env,
      `INSERT INTO handoff_events SELECT lower(hex(randomblob(16))),h.id,'reassigned',?,json_set(h.doc,'$.group',NULL,'$.waiting','nobody_available','$.respond_by',NULL,'$.assignee',NULL,'$.to',NULL,'$.from',json(h.assignee),'$.cause','group_deleted'),? FROM handoff_docs h WHERE h.app_id=? AND h.group_id=? AND h.ended_at IS NULL RETURNING id`,
      JSON.stringify(c.var.actor),
      at,
      app,
      id
    ),
    sql(
      env,
      "UPDATE handoffs SET assignee=NULL,waiting='nobody_available',respond_by=NULL,next_check=NULL,version=version+1 WHERE app_id=? AND group_id=? AND ended_at IS NULL",
      app,
      id
    ),
    sql(
      env,
      "UPDATE issues SET assignee=NULL,updated_at=max(updated_at,?),revision=revision+1 WHERE id IN(SELECT issue_id FROM handoffs WHERE app_id=? AND group_id=? AND ended_at IS NULL)",
      at,
      app,
      id
    ),
    sql(
      env,
      `INSERT INTO audit_log(app_id,actor,action,target,data) SELECT app_id,?,'request_type.updated',json_object('type','request_type','id',id),json_object('cause','group_deleted','group_id',?) FROM request_types WHERE app_id=? AND json_extract(route,'$.group')=?`,
      JSON.stringify(c.var.actor),
      id,
      app,
      id
    ),
    sql(
      env,
      `UPDATE request_types SET route=NULL,version=version+1 WHERE app_id=? AND json_extract(route,'$.group')=?`,
      app,
      id
    ),
    sql(env, "DELETE FROM handoff_groups WHERE app_id=? AND id=?", app, id),
    entry(env, app, c.var.actor, "group.deleted", { type: "group", id })
  ])
  if (!result.at(-2)!.meta.changes) missing()
  c.executionCtx.waitUntil(
    (async () => {
      for (const e of result[1]!.results) await publishHandoff(env, e.id, c.req.url)
    })()
  )
  return c.json({ ok: true })
})
handoffRoutes.get(base + "/me/availability", async (c) => {
  desk(c)
  requireTeam(c, "triage")
  const row = await sql(c.env, `SELECT coalesce(v.available,1) available FROM members m
    JOIN apps a ON a.id=m.app_id AND a.mode='helpdesk' LEFT JOIN handoff_availability v ON v.member_id=m.id
    WHERE m.app_id=? AND m.user_id=? AND m.role IN ('owner','admin','member')`, c.var.app.id, c.var.user!.id).first<{available:number}>()
  return c.json({ available: !!(row ?? denied()).available })
})
handoffRoutes.put(base + "/me/availability", async (c) => {
  desk(c)
  requireTeam(c, "triage")
  const { available } = await body(c),
    app = c.var.app.id
  if (typeof available !== "boolean") bad("Expected available")
  await c.env.DB.batch([
    guard(c.env, `EXISTS(${memberGrant})`, app, c.var.user!.id),
    sql(
      c.env,
      "INSERT INTO handoff_availability SELECT id,? FROM members WHERE app_id=? AND user_id=? ON CONFLICT(member_id) DO UPDATE SET available=excluded.available",
      Number(available),
      app,
      c.var.user!.id
    ),
    entry(c.env, app, c.var.actor, "availability.updated", { type: "member", id: c.var.user!.id }, { available })
  ])
  return c.json({ available })
})

async function start(
  c: Ctx,
  app: string,
  issue: string,
  source: Escalation["source"],
  actor: Actor,
  reason: unknown,
  access: D1PreparedStatement,
  group?: { id: string } | { name: string }
) {
  if (source === "requester") {
    await enforce(c, "RL_IP", "handoff:ip:" + clientIP(c))
    await enforce(c, "RL_TEAM", `handoff:${app}:${actor.id}`)
  }
  const plan = await startPlan(c.env, app, issue, source, actor, reason, group)
  await c.env.DB.batch([access, ...plan.statements])
  c.executionCtx.waitUntil(publishHandoff(c.env, plan.event, c.req.url))
}
function issueId(c: Ctx, app: string, n: number) {
  return sql(c.env, "SELECT id FROM issues WHERE app_id=? AND number=?", app, n).first<string>("id")
}
handoffRoutes.post(issuePath + "/escalate", async (c) => {
  desk(c)
  const app = c.var.app.id,
    n = issueNumber(c.req.param("number")),
    b = await body(c),
    a = c.var.actor,
    team = !!c.var.app.role,
    v = { team, actorId: a.id, aliases: c.var.aliases }
  if (team) requireTeam(c, "triage")
  else {
    await allowWrite(c)
    if (b.group_id !== undefined) denied()
  }
  const ownerSQL = "hidden IS NULL AND json_extract(author,'$.id') IN(SELECT value FROM json_each(?))",
    owners = JSON.stringify(actorIds(v)),
    id =
      (await sql(
        c.env,
        `SELECT id FROM issues WHERE app_id=? AND number=? ${team ? "" : `AND ${ownerSQL}`}`,
        app,
        n,
        ...(team ? [] : [owners])
      ).first<string>("id")) ?? missing(),
    access = team
      ? guard(c.env, `EXISTS(${memberGrant})`, app, a.id)
      : guard(
          c.env,
          `EXISTS(SELECT 1 FROM issues WHERE id=? AND app_id=? AND ${ownerSQL}) ${c.var.contact ? "AND EXISTS(SELECT 1 FROM contact_sessions WHERE hash=? AND app_id=? AND contact_id=? AND expires>unixepoch())" : ""}`,
          id,
          app,
          owners,
          ...(c.var.contact ? [await contactHash(c, c.var.app.slug), app, c.var.contact.id] : [])
        )
  await start(
    c,
    app,
    id,
    team ? "team" : "requester",
    a,
    b.reason,
    access,
    b.group_id === undefined ? undefined : { id: str(b.group_id, "group_id", 100) }
  )
  return c.json(await getIssue(c.env, app, n, v))
})
handoffRoutes.delete(issuePath + "/escalation", async (c) => {
  desk(c)
  requireTeam(c, "triage")
  const app = c.var.app.id,
    n = issueNumber(c.req.param("number")),
    id = (await issueId(c, app, n)) ?? missing(),
    event = await endHandoff(c.env, app, id, c.var.actor, guard(c.env, `EXISTS(${memberGrant})`, app, c.var.user!.id))
  c.executionCtx.waitUntil(publishHandoff(c.env, event, c.req.url))
  return c.json(await getIssue(c.env, app, n, { team: true, actorId: c.var.actor.id }))
})
export async function agentEscalate(c: Ctx, app: string, n: number, actor: Actor, b: Record<string, unknown>) {
  const id = (await issueId(c, app, n)) ?? missing()
  await start(
    c,
    app,
    id,
    "agent",
    actor,
    str(b.reason, "reason", 1000),
    guard(
      c.env,
      `EXISTS(SELECT 1 FROM (${agentAccessSQL}) WHERE app_id=? AND agent_id=? AND role IN ('admin','member','responder'))`,
      app,
      actor.id
    ),
    b.group === undefined ? undefined : { name: str(b.group, "group", 120) }
  )
  return getIssue(c.env, app, n, { team: true, actorId: actor.id })
}
export async function apiEscalate(c: Ctx, s: Scope, b: Record<string, unknown>, id: string) {
  if (Object.keys(b).some((k) => k !== "reason")) bad("Only reason is accepted")
  const user = s.user,
    actor: Actor = user
      ? user.anonymous
        ? { type: "guest", id: user.id, name: user.name, handle: "guest-" + user.id.slice(5, 13) }
        : contactActor(user)
      : { type: "agent", id: "api-key:" + s.key, name: s.name }
  const access = user ? liveGuard(c, s, id) : serverGuard(c.env, s)
  await start(c, s.app, id, user ? "requester" : "team", actor, b.reason, access)
  return (await (user ? conversations(c, s, id) : workspaceConversations(c, s, id))).data[0]
}
