import type { Actor, Escalation, Group, IssueEvent } from "../shared/api"
import { bad, fail, now, sql, str, uid } from "./core"
import { appRoom, issueRoom, type Work } from "./events"
import { issueSummary } from "./issues"
import { enqueueWebhooks } from "./webhooks"
import { signalContact } from "./v1/signals"
import { entry } from "./audit"

const system: Actor = { type: "agent", id: "bellhop", name: "Bellhop" }
export const neutral: Actor = { type: "member", id: "workspace-team", name: "Team", avatar_url: null }
export const guard = (env: Env, test: string, ...args: unknown[]) =>
  sql(env, `INSERT INTO handoff_guard SELECT 0 WHERE NOT (${test})`, ...args)
export const active = `SELECT h.doc FROM handoff_docs h WHERE h.issue_id=i.id AND h.app_id=i.app_id AND h.ended_at IS NULL`
export const withPerson = `EXISTS(SELECT 1 FROM handoffs h WHERE h.issue_id=i.id AND h.app_id=i.app_id AND h.ended_at IS NULL)`
type Schedule = { id: string; hours: string | null; version: number }
// Intl handles DST and offsets. A crossing-midnight shift belongs to the day it starts.
export function onDuty(hours: Group["hours"], at: string) {
  if (!hours) return true
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(at))
  const part = (type: string) => parts.find((p) => p.type === type)!.value,
    day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday")),
    time = part("hour") + ":" + part("minute")
  return hours.start < hours.end
    ? hours.days.includes(day) && time >= hours.start && time < hours.end
    : (hours.days.includes(day) && time >= hours.start) || (hours.days.includes((day + 6) % 7) && time < hours.end)
}
const routeGroup = `coalesce((SELECT json_extract(t.route,'$.group') FROM request_answers b JOIN request_types t ON t.id=b.type_id AND t.app_id=b.app_id WHERE b.issue_id=? AND b.app_id=a.id),a.default_group_id)`
const groupVersion = (env: Env, g: Schedule, app: string) =>
  guard(env, "EXISTS(SELECT 1 FROM handoff_groups WHERE id=? AND app_id=? AND version=?)", g.id, app, g.version)
// Runs inside the *write* batch. Neither the cursor, the live roster nor the workload is read in JS.
const pick = `SELECT r.actor FROM handoff_roster r JOIN handoff_groups g ON g.id=r.group_id WHERE r.group_id=? AND r.available AND r.user_id IS NOT ?
 ORDER BY CASE WHEN g.strategy='least_busy' THEN (SELECT count(*) FROM issues i WHERE i.app_id=g.app_id AND i.status!='closed' AND json_extract(i.assignee,'$.id')=r.user_id) ELSE 0 END,
 r.position<=coalesce((SELECT p.position FROM handoff_roster p WHERE p.group_id=g.id AND p.user_id=g.last_user),-1),r.position LIMIT 1`
const window = `(SELECT strftime('%Y-%m-%dT%H:%M:%fZ',?,'+'||g.response_minutes||' minutes') FROM handoff_groups g WHERE g.id=handoffs.group_id)`
function assign(env: Env, id: string, g: Schedule | null, at: string, previous: Actor | null, passed: boolean) {
  const open = g && onDuty(g.hours ? JSON.parse(g.hours) : null, at),
    q = []
  if (open && !passed)
    q.push(
      sql(env, `UPDATE handoffs SET assignee=coalesce((${pick}),assignee) WHERE id=?`, g.id, previous?.id ?? null, id)
    )
  q.push(
    sql(
      env,
      `UPDATE handoffs SET waiting=CASE WHEN assignee IS NULL THEN ? END,respond_by=CASE WHEN assignee IS NOT NULL THEN ${window} END,
    passed=max(passed,? AND assignee IS NOT NULL AND json_extract(assignee,'$.id') IS NOT ?),version=version+1 WHERE id=?`,
      g && !open ? "hours" : "nobody_available",
      at,
      Number(!!previous),
      previous?.id ?? null,
      id
    ),
    sql(
      env,
      `UPDATE handoffs SET next_check=CASE WHEN waiting IS NOT NULL AND group_id IS NOT NULL THEN strftime('%Y-%m-%dT%H:%M:%fZ',?,'+1 minute') ELSE respond_by END WHERE id=?`,
      at,
      id
    ),
    sql(
      env,
      `UPDATE handoff_groups SET last_user=(SELECT json_extract(assignee,'$.id') FROM handoffs WHERE id=?) WHERE id=(SELECT group_id FROM handoffs WHERE id=? AND assignee IS NOT NULL AND json_extract(assignee,'$.id') IS NOT ?)`,
      id,
      id,
      previous?.id ?? null
    ),
    sql(
      env,
      `UPDATE issues SET assignee=(SELECT assignee FROM handoffs WHERE id=?),updated_at=max(updated_at,?),revision=revision+1 WHERE id=(SELECT issue_id FROM handoffs WHERE id=?) AND assignee IS NOT (SELECT assignee FROM handoffs WHERE id=?)`,
      id,
      at,
      id,
      id
    )
  )
  return q
}
function record(
  env: Env,
  eid: string,
  id: string,
  type: "escalated" | "tick" | "handed_back",
  actor: Actor,
  at: string,
  previous: Actor | null = null
) {
  return sql(
    env,
    `INSERT INTO handoff_events SELECT ?,h.id,CASE WHEN ?='tick' THEN CASE WHEN json_extract(h.assignee,'$.id') IS ? THEN 'reminder' ELSE 'reassigned' END ELSE ? END,?,
    json_set(h.doc,'$.assignee',json(h.assignee),'$.from',json(?),'$.to',json(h.assignee)),? FROM handoff_docs h WHERE h.id=? AND (?!='tick' OR h.assignee IS NOT NULL)`,
    eid,
    type,
    previous?.id ?? null,
    type,
    JSON.stringify(actor),
    JSON.stringify(previous),
    at,
    id,
    type
  )
}
export async function startPlan(
  env: Env,
  app: string,
  issue: string,
  source: Escalation["source"],
  actor: Actor,
  reason: unknown,
  group?: { id: string } | { name: string },
  at = now()
) {
  const why = reason === undefined ? "" : str(reason, "reason", 1000, true),
    id = uid(),
    event = uid()
  const target = group
      ? "id" in group
        ? "?"
        : "(SELECT id FROM handoff_groups WHERE app_id=a.id AND name=?)"
      : routeGroup,
    args = [group ? ("id" in group ? group.id : group.name) : issue, app],
    lookup = `SELECT ${target} AS target FROM apps a WHERE a.id=? AND a.mode='helpdesk'`
  const chosen = await sql(env, lookup, ...args).first<string>("target"),
    g = chosen
      ? await sql(
          env,
          "SELECT id,hours,version FROM handoff_groups WHERE id=? AND app_id=?",
          chosen,
          app
        ).first<Schedule>()
      : null
  if (group && !g && source !== "routing") bad("Unknown workspace group")
  const q = [
    guard(
      env,
      `EXISTS(SELECT 1 FROM issues i JOIN apps a ON a.id=i.app_id WHERE i.id=? AND a.id=? AND a.mode='helpdesk') AND (${lookup}) IS ?`,
      issue,
      app,
      ...args,
      chosen
    ),
    ...(g ? [groupVersion(env, g, app)] : []),
    sql(
      env,
      `INSERT INTO handoffs(id,issue_id,app_id,source,actor,at,reason,group_id) VALUES(?,?,?,?,?,?,?,?)`,
      id,
      issue,
      app,
      source,
      JSON.stringify(actor),
      at,
      why,
      g?.id ?? null
    ),
    ...assign(env, id, g, at, null, false),
    record(env, event, id, "escalated", actor, at),
    entry(env, app, actor, "issue.escalated", { type: "issue", id: issue }, { source, group_id: g?.id ?? null })
  ]
  return { statements: q, event }
}
export async function endHandoff(env: Env, app: string, issue: string, actor: Actor, permission: D1PreparedStatement) {
  const id =
      (await sql(
        env,
        "SELECT id FROM handoffs WHERE issue_id=? AND app_id=? AND ended_at IS NULL",
        issue,
        app
      ).first<string>("id")) ?? fail(409, "not_escalated", "Request is not with a person"),
    at = now(),
    event = uid()
  await env.DB.batch([
    permission,
    guard(env, "EXISTS(SELECT 1 FROM handoffs WHERE id=? AND ended_at IS NULL)", id),
    record(env, event, id, "handed_back", actor, at),
    sql(env, "UPDATE handoffs SET ended_at=?,respond_by=NULL,next_check=NULL,version=version+1 WHERE id=?", at, id),
    sql(
      env,
      "UPDATE issues SET assignee=NULL,updated_at=max(updated_at,?),revision=revision+1 WHERE id=? AND app_id=?",
      at,
      issue,
      app
    ),
    entry(env, app, actor, "issue.handed_back", { type: "issue", id: issue })
  ])
  return event
}
export async function publishHandoff(env: Env, id: string, origin: string) {
  const r = await sql(
    env,
    `SELECT e.*,i.number,a.slug,a.name,a.public FROM handoff_timeline e JOIN issues i ON i.id=e.issue_id AND i.app_id=e.app_id JOIN apps a ON a.id=i.app_id WHERE e.id=?`,
    id
  ).first<{
    id: string
    number: number
    app_id: string
    issue_id: string
    slug: string
    name: string
    public: number
    actor: string
    type: IssueEvent["type"]
    data: string
    created_at: string
  }>()
  if (!r) return
  const issue = await issueSummary(env, r.app_id, r.number)
  if (issue.id !== r.issue_id) return
  const data = JSON.parse(r.data),
    { assignee, source, reason, group, waiting, by, at, respond_by } = data,
    actor = JSON.parse(r.actor) as Actor,
    event = { id: r.id, type: r.type, actor, data, created_at: r.created_at },
    team = { type: "timeline.added", issue_id: r.issue_id, item: { kind: "event", event } } as const,
    room = issueRoom(env, r.issue_id),
    update = { type: "issue.updated", issue } as const
  await Promise.all([
    room.publishConversation([team], { app: r.app_id, internalOnly: true }),
    r.type === "escalated"
      ? room.publishConversation(
          [{ ...team, item: { kind: "event", event: { ...event, actor: neutral, data: {} } } }],
          { app: r.app_id, internalOnly: false, requesterOnly: true }
        )
      : Promise.resolve(),
    room.publishConversation([update], { app: r.app_id, internalOnly: false }),
    appRoom(env, r.app_id).publishConversation([update], { app: r.app_id, internalOnly: false }),
    signalContact(env, r.app_id, issue.author.id, { issue: issue.id, created: r.type === "escalated" ? [id] : [] }),
    enqueueWebhooks(env, env.PUBLIC_ORIGIN || origin, { id: r.app_id, slug: r.slug, name: r.name }, actor, issue, [
      {
        type: r.type === "handed_back" ? "issue.handed_back" : "issue.escalated",
        ...(r.type === "handed_back" ? {} : { escalation: { source, reason, group, waiting, by, at, respond_by } }),
        transition: { assignee: r.type === "handed_back" ? null : assignee }
      }
    ])
  ])
}
export async function sweepHandoffs(env: Env, ctx: Work, time: number) {
  const at = new Date(time).toISOString(),
    due = await sql(
      env,
      `SELECT h.id,h.issue_id,h.app_id,h.version,h.assignee,h.passed,g.id gid,g.hours,g.version gv FROM handoffs h JOIN issues i ON i.id=h.issue_id JOIN apps a ON a.id=h.app_id AND a.mode='helpdesk' LEFT JOIN handoff_groups g ON g.id=h.group_id WHERE h.ended_at IS NULL AND h.next_check<=? AND i.status!='closed' ORDER BY h.next_check,h.id LIMIT 20`,
      at
    ).all<{
      id: string
      issue_id: string
      app_id: string
      version: number
      assignee: string | null
      passed: number
      gid: string | null
      hours: string | null
      gv: number
    }>()
  for (const h of due.results) {
    const event = uid(),
      g = h.gid ? { id: h.gid, hours: h.hours, version: h.gv } : null,
      old = h.assignee ? JSON.parse(h.assignee) : null
    try {
      const rs = await env.DB.batch([
        guard(
          env,
          `EXISTS(SELECT 1 FROM handoffs h JOIN issues i ON i.id=h.issue_id WHERE h.id=? AND h.version=? AND h.ended_at IS NULL AND h.next_check<=? AND i.status!='closed')`,
          h.id,
          h.version,
          at
        ),
        ...(g ? [groupVersion(env, g, h.app_id)] : []),
        ...assign(env, h.id, g, at, old, !!h.passed),
        record(env, event, h.id, "tick", system, at, old),
        entry(
          env,
          h.app_id,
          system,
          "issue.reassigned",
          { type: "issue", id: h.issue_id },
          {},
          "EXISTS(SELECT 1 FROM handoff_events WHERE id=? AND type='reassigned')",
          [event]
        )
      ])
      if (rs.at(-2)?.meta.changes) ctx.waitUntil(publishHandoff(env, event, env.PUBLIC_ORIGIN || "https://blhp.app"))
    } catch (e) {
      if (!String(e).includes("handoff_changed") && !String((e as Error).cause).includes("handoff_changed")) throw e
    }
  }
}
