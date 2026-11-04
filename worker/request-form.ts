import type { Actor, IssueEvent } from "../shared/api"
import { bad, fail, sql, uid, type Ctx } from "./core"
import {
  config,
  formAnswers,
  requestJson,
  routingWrites,
  typeGuard,
  typeInfo,
  retireFormReplays
} from "./request-types"
import type { Access } from "./mutations"
import { agentAccessSQL } from "./permissions"
import { clientIP, enforce } from "./rate-limits"
import { prepareCode } from "./email-codes"

export type FormCaller = { c: Ctx; operator: Actor; staff: boolean; serverKey?: string }
type Previous = {
  type_id: string | null
  answers: string | null
  public_answers: string | null
  reporter: string
  revision: number
}
export async function prepareForm(
  a: Access,
  issue: string,
  type: unknown,
  raw: unknown,
  caller: FormCaller,
  prev?: Previous
) {
  const env = a.env,
    app = a.app.id,
    t = await config(env, app, type, !!prev && caller.operator.type === "agent"),
    reporter = prev?.reporter ?? a.actor.id
  const contactCheck = "SELECT 1 FROM contacts WHERE app_id=? AND id=?",
    requireContact = async () => {
      if (!(await sql(env, contactCheck, app, reporter).first()))
        fail(401, "contact_required", "Sign in as a verified contact for this request type")
    }
  if (t.require_verification) await requireContact()
  const supplied = raw === undefined ? {} : raw
  const merged = prev?.answers
    ? Object.fromEntries(Object.entries(JSON.parse(prev.answers)).filter(([k]) => t.fields.some((f) => f.key === k)))
    : {}
  if (!supplied || Array.isArray(supplied) || typeof supplied !== "object") bad("Expected a fields object")
  const answers = formAnswers(t, { ...merged, ...supplied }, caller.staff),
    event = uid(),
    q: D1PreparedStatement[] = []
  if (prev?.public_answers) {
    const original = JSON.parse(prev.public_answers)
    for (const k of Object.keys(answers.public))
      if (
        Object.hasOwn(merged, k) &&
        !Object.hasOwn(original, k) &&
        (!Object.hasOwn(supplied, k) || answers.public[k] === merged[k])
      )
        delete answers.public[k]
  }
  const requesterVerification = !prev && !caller.staff && answers.verify.length > 0
  if (requesterVerification && !t.require_verification) await requireContact()
  if (t.require_verification || requesterVerification) q.push(typeGuard(env, `EXISTS(${contactCheck})`, app, reporter))
  if (caller.staff) {
    const permission = caller.serverKey
      ? "SELECT 1 FROM api_keys WHERE app_id=? AND id=? AND kind='secret'"
      : caller.operator.type === "agent"
        ? `SELECT 1 FROM (${agentAccessSQL}) WHERE app_id=? AND agent_id=? AND role IN ('member','admin')`
        : "SELECT 1 FROM members WHERE app_id=? AND user_id=? AND role IN ('member','admin','owner')"
    q.push(typeGuard(env, `EXISTS(${permission})`, app, caller.serverKey ?? caller.operator.id))
  }
  if (prev) {
    q.push(
      typeGuard(env, "EXISTS(SELECT 1 FROM issues WHERE app_id=? AND id=? AND revision=?)", app, issue, prev.revision)
    )
    if (
      prev.public_answers &&
      Object.keys(JSON.parse(prev.public_answers)).some((k) => !Object.hasOwn(answers.public, k))
    )
      q.push(retireFormReplays(env, app, "issue_id", issue))
  }
  q.push(...routingWrites(env, app, issue, t, answers, caller.operator, event))
  const deliveries: { index: number; plan: Awaited<ReturnType<typeof prepareCode>> }[] = []
  if (!prev) {
    if (answers.verify.length > (caller.staff ? 5 : 3))
      fail(429, "code_limit", "Too many verification addresses on one request")
    for (const address of answers.verify) {
      await enforce(caller.c, "RL_IP", "code-start:" + clientIP(caller.c))
      const plan = await prepareCode(
        env,
        { kind: "verification", app, issue, email: address },
        clientIP(caller.c),
        a.app.name,
        a.locale ?? "en",
        caller.operator,
        [reporter],
        caller.staff,
        caller.serverKey
      )
      deliveries.push({ index: q.length + plan.index, plan })
      q.push(
        ...plan.statements,
        typeGuard(env, "EXISTS(SELECT 1 FROM email_codes WHERE app_id=? AND issue_id=? AND id=?)", app, issue, plan.id)
      )
    }
  }
  q.push(
    sql(
      env,
      `SELECT e.id,e.actor,e.created_at,e.data,${requestJson(true)} info FROM request_route_events e JOIN issues i ON i.id=e.issue_id AND i.app_id=e.app_id WHERE e.id=?`,
      event
    )
  )
  return {
    typeId: t.id,
    statements: q,
    committed(rows: D1Result<Record<string, unknown>>[]) {
      for (const { index, plan } of deliveries) {
        const row = rows[index]!.results[0] as { state: string; trusted: number | null }
        caller.c.executionCtx.waitUntil(
          plan.deliver(row).catch(() => console.error("request_form.verification_delivery_failed", { id: plan.id }))
        )
      }
      const r = rows.at(-1)!.results[0]!
      return {
        event: {
          id: event,
          actor: JSON.parse(r.actor as string),
          type: "routed",
          data: JSON.parse(r.data as string),
          created_at: r.created_at as string
        } satisfies IssueEvent,
        form: typeInfo(r.info as string)
      }
    }
  }
}
