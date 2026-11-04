import { Hono } from "hono"
import type { Actor, Contact, ContactDetail, ContactPage, Verification } from "../shared/api"
import {
  bad,
  body,
  denied,
  email,
  fail,
  missing,
  now,
  secret,
  sha256,
  sql,
  str,
  uid,
  type Bindings,
  type Ctx
} from "./core"
import { allowWrite, me, requireHuman, signIn } from "./auth"
import { assertContactHost, contactCookie, contactHash, contactTTL } from "./contact-session"
import { claimContactGuest } from "./guest-history"
import { clientIP, enforce } from "./rate-limits"
import { requestLocale } from "./locale"
import { issueCode, redeemCode, expireCodes } from "./email-codes"
import { contactCols, proofCols, verification, type ProofRow } from "./helpdesk-data"
import { listIssues, issueNumber, issueSummary } from "./issues"
import { actorIds, owns, visibleSQL, actorBindings, type Viewer } from "./visibility"
import { authenticate } from "./mcp"
import { enqueueWebhooks } from "./webhooks"
import { mailOrigin } from "./mail-provider"

export const helpdesk = new Hono<Bindings>(),
  base = "/api/apps/:slug"
function apex(c: Ctx) {
  if (c.env.APP_DOMAIN && new URL(c.req.url).hostname !== c.env.APP_DOMAIN) missing()
}
helpdesk.post("/auth/email/start", async (c) => {
  apex(c)
  await requireHuman(c)
  const address = email((await body(c)).email)
  await issueCode(
    c.env,
    { kind: "account", app: null, email: address },
    clientIP(c),
    "Bellhop",
    requestLocale(c).locale
  )
  return c.json({ ok: true })
})
helpdesk.post("/auth/email/verify", async (c) => {
  apex(c)
  await enforce(c, "RL_IP", "code-verify:" + clientIP(c))
  const b = await body(c),
    address = email(b.email)
  await redeemCode(c.env, { kind: "account", app: null, email: address }, b.code)
  await signIn(c, address, null, null, null)
  return c.json(await me(c))
})
helpdesk.post(base + "/contact/start", async (c) => {
  assertContactHost(c)
  await requireHuman(c)
  const address = email((await body(c)).email)
  await issueCode(
    c.env,
    { kind: "contact", app: c.var.app.id, email: address },
    clientIP(c),
    c.var.app.name,
    requestLocale(c).locale
  )
  return c.json({ ok: true })
})
helpdesk.post(base + "/contact/verify", async (c) => {
  assertContactHost(c)
  await enforce(c, "RL_IP", "code-verify:" + clientIP(c))
  const b = await body(c),
    address = email(b.email),
    app = c.var.app
  await redeemCode(c.env, { kind: "contact", app: app.id, email: address }, b.code)
  const raw = secret(),
    at = now(),
    previous = await contactHash(c, app.slug)
  const [, write, session] = await c.env.DB.batch<{ id: string; email: string; name: null }>([
    sql(c.env, "DELETE FROM contact_sessions WHERE app_id=? AND hash=?", app.id, previous),
    sql(
      c.env,
      `INSERT INTO contacts(id,app_id,email,created_at,last_seen_at) SELECT ?,id,?,?,? FROM apps WHERE id=? AND mode='helpdesk' ON CONFLICT(app_id,email) DO UPDATE SET last_seen_at=excluded.last_seen_at RETURNING id,name,email`,
      "ct_" + uid(),
      address,
      at,
      at,
      app.id
    ),
    sql(
      c.env,
      "INSERT INTO contact_sessions SELECT ?,t.app_id,t.id,unixepoch()+? FROM contacts t JOIN apps a ON a.id=t.app_id WHERE t.app_id=? AND t.email=? AND a.mode='helpdesk'",
      await sha256(raw),
      contactTTL,
      app.id,
      address
    )
  ])
  const contact = { ...(write!.results[0] ?? missing()), verified_via: "email" as const }
  if (!session!.meta.changes) missing()
  await claimContactGuest(c, contact)
  contactCookie(c, app.slug, raw)
  c.set("contact", contact)
  return c.json(await me(c))
})
helpdesk.post(base + "/contact/sign-out", async (c) => {
  assertContactHost(c)
  await sql(
    c.env,
    "DELETE FROM contact_sessions WHERE hash=? AND app_id=?",
    await contactHash(c, c.var.app.slug),
    c.var.app.id
  ).run()
  contactCookie(c, c.var.app.slug, "", 0)
  c.set("contact", null)
  return c.json(await me(c))
})
async function team(c: Ctx) {
  if (c.req.header("Authorization")) {
    const agent = await authenticate(c)
    if (!agent?.apps.some((a) => a.id === c.var.app.id)) denied()
  } else if (!c.var.app.role) denied()
}
export async function getContact(env: Env, app: string, b: Record<string, unknown>): Promise<ContactDetail> {
  const keys = ["id", "email", "external_id"].filter((k) => b[k] !== undefined)
  if (keys.length !== 1) bad("Supply one contact identifier")
  const k = keys[0]!
  if (k === "external_id") missing()
  const t =
    (await sql(
      env,
      `SELECT ${contactCols} FROM contacts t JOIN apps a ON a.id=t.app_id WHERE a.mode='helpdesk' AND t.app_id=? AND t.${k}=?`,
      app,
      k === "email" ? email(b[k]) : str(b[k], "contact id", 80)
    ).first<Contact>()) ?? missing()
  const requests: ContactDetail["requests"] = []
  let cursor: string | undefined
  do {
    const p = await listIssues(
      env,
      app,
      { allStates: true, contactId: t.id, limit: 100, cursor },
      { team: true, actorId: null }
    )
    requests.push(...p.issues)
    cursor = p.next_cursor ?? undefined
  } while (cursor)
  return { ...t, requests }
}
helpdesk.get(base + "/contacts", async (c) => {
  await team(c)
  if (!c.var.desk) missing()
  const term = str(c.req.query("q") ?? "", "search", 256, true)
      .trim()
      .toLowerCase(),
    cursor = c.req.query("cursor"),
    parts = cursor?.split("~")
  if (
    parts &&
    (parts.length !== 2 ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parts[0]!) ||
      !/^ct_[\da-f-]+$/.test(parts[1]!))
  )
    bad("Invalid cursor")
  const rs = await sql(
    c.env,
    `SELECT ${contactCols} FROM contacts t WHERE app_id=? AND (instr(lower(email),?) OR instr(lower(coalesce(name,'')),?) OR ?='') ${parts ? "AND (created_at,id)<(?,?)" : ""} ORDER BY created_at DESC,id DESC LIMIT 51`,
    c.var.app.id,
    term,
    term,
    term,
    ...(parts ?? [])
  ).all<Contact>()
  const contacts = rs.results.slice(0, 50),
    last = contacts.at(-1)
  return c.json({
    contacts,
    next_cursor: rs.results.length > 50 ? `${last!.created_at}~${last!.id}` : null
  } satisfies ContactPage)
})
helpdesk.get(base + "/contacts/:id", async (c) => {
  await team(c)
  return c.json(await getContact(c.env, c.var.app.id, { id: c.req.param("id") }))
})

async function requestTarget(env: Env, app: string, n: number, v: Viewer) {
  return (
    (await sql(
      env,
      `SELECT id,reporter_locale,json_extract(author,'$.id') reporter FROM issues i WHERE app_id=? AND number=? AND ${visibleSQL(v)}`,
      app,
      n,
      ...actorBindings(v)
    ).first<{ id: string; reporter: string; reporter_locale: import("../shared/api").Locale | null }>()) ?? missing()
  )
}
export async function requestVerification(
  c: Ctx,
  app: { id: string; name: string },
  n: number,
  address: unknown,
  actor: Actor,
  v: Viewer
): Promise<Verification> {
  const i = await requestTarget(c.env, app.id, n, v)
  if (!v.team && !owns(v, i.reporter)) denied()
  const id = await issueCode(
    c.env,
    { kind: "verification", app: app.id, issue: i.id, email: email(address) },
    clientIP(c),
    app.name,
    i.reporter_locale ?? requestLocale(c).locale,
    actor,
    actorIds(v)
  )
  return verification(
    (await sql(c.env, `SELECT ${proofCols} FROM email_codes v WHERE id=?`, id).first<ProofRow>()) ?? missing()
  )
}
const route = base + "/issues/:number/verifications"
helpdesk.post(route, async (c) => {
  let actor = c.var.actor,
    v: Viewer = { actorId: actor.id, team: !!c.var.app.role, aliases: c.var.aliases }
  if (c.req.header("Authorization")) {
    const caller = await authenticate(c),
      role = caller?.apps.find((a) => a.id === c.var.app.id)?.role
    if (!caller || !role || role === "viewer") denied()
    actor = caller!.actor
    v = { team: true, actorId: actor.id }
  } else if (!v.team) await allowWrite(c)
  return c.json(
    await requestVerification(c, c.var.app, issueNumber(c.req.param("number")), (await body(c)).email, actor, v),
    201
  )
})
helpdesk.post(route + "/:id/confirm", async (c) => {
  if (c.req.header("Authorization")) denied()
  const v: Viewer = { team: !!c.var.app.role, actorId: c.var.actor.id, aliases: c.var.aliases },
    n = issueNumber(c.req.param("number"))
  // Check ownership before reading a code record; another contact cannot burn attempts.
  const i = await sql(
    c.env,
    "SELECT id,hidden,json_extract(author,'$.id') reporter FROM issues WHERE app_id=? AND number=?",
    c.var.app.id,
    n
  ).first<{ id: string; hidden: string | null; reporter: string }>()
  if (i && c.var.contact?.id === i.reporter) v.actorId = i.reporter
  if (!i || !owns(v, i.reporter) || (!v.team && i.hidden)) denied()
  const id = c.req.param("id")!,
    r =
      (await sql(
        c.env,
        "SELECT email FROM email_codes WHERE id=? AND app_id=? AND issue_id=?",
        id,
        c.var.app.id,
        i!.id
      ).first<{ email: string }>()) ?? missing()
  await enforce(c, "RL_IP", "code-verify:" + clientIP(c))
  try {
    await redeemCode(
      c.env,
      { kind: "verification", app: c.var.app.id, issue: i!.id, email: r.email },
      (await body(c)).code,
      id,
      actorIds(v)
    )
  } finally {
    c.executionCtx.waitUntil(dispatchProof(c.env, id))
  }
  return c.json(
    verification(
      (await sql(c.env, `SELECT ${proofCols} FROM email_codes v WHERE id=?`, id).first<ProofRow>()) ?? missing()
    )
  )
})
async function dispatchProof(env: Env, id: string) {
  const row = await sql(
    env,
    `SELECT ${proofCols},o.destination_hash,a.id app_id,a.name,a.slug,i.number,i.author FROM verification_outbox o JOIN email_codes v ON v.id=o.id JOIN apps a ON a.id=v.app_id JOIN issues i ON i.id=v.issue_id AND i.app_id=a.id WHERE o.id=?`,
    id
  ).first<
    ProofRow & {
      destination_hash: string | null
      app_id: string
      name: string
      slug: string
      number: number
      author: string
    }
  >()
  if (!row) return
  if (!row.destination_hash) {
    const app = { id: row.app_id, name: row.name, slug: row.slug },
      actor: Actor = row.state === "verified" ? JSON.parse(row.author) : { type: "agent", id: "system", name: row.name }
    await enqueueWebhooks(env, mailOrigin(env), app, actor, await issueSummary(env, app.id, row.number), [
      { type: "verification.completed", verification: verification(row) }
    ])
  }
  const pending = await sql(
    env,
    `SELECT d.id,o.destination_hash FROM verification_outbox o JOIN webhook_deliveries d ON d.id='vr-'||o.id WHERE o.id=? AND d.status='pending' AND o.destination_hash IS NOT NULL`,
    id
  ).first<{ id: string; destination_hash: string }>()
  if (pending) await env.WEBHOOKS.send({ id: pending.id, destinationHash: pending.destination_hash })
  await sql(env, "DELETE FROM verification_outbox WHERE id=?", id).run()
}
export async function processVerifications(env: Env) {
  await expireCodes(env)
  const { results } = await sql(env, "SELECT id FROM verification_outbox LIMIT 50").all<{ id: string }>()
  for (const { id } of results) {
    try {
      await dispatchProof(env, id)
    } catch {
      console.error("bellhop.verification_dispatch_retry", { id })
    }
  }
}
