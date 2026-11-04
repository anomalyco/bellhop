import { Hono } from "hono"
import type { IssueSubscription, NotificationSettings } from "../shared/api"
import { allowWrite } from "./auth"
import { guestWrite } from "./guest-history"
import { bad, body, denied, email, fail, missing, sha256, sql, type Bindings, type Ctx } from "./core"
import { issueNumber } from "./issues"
import { clientIP, enforce } from "./rate-limits"
import {
  checkToken,
  devMail,
  esc,
  mailOrigin,
  mailToken,
  sendMail,
  unsubscribeURL,
  secrets,
  type TokenRow
} from "./mail-provider"
import { receiveEvent, type InboundEvent } from "./mail-inbound"
import { handleDeliveryProblem } from "./mail-feedback"

export const mailRoutes = new Hono<Bindings>()
type Sub = TokenRow & {
  address: string
  user_id: string | null
  state: "on" | "off" | "pending"
  reason: IssueSubscription["reason"]
}
async function prefs(c: Ctx): Promise<NotificationSettings> {
  const u = c.var.user ?? fail(401, "sign_in", "Sign in to manage notification settings"),
    p =
      (await sql(
        c.env,
        `SELECT coalesce(p.opened,1) opened,coalesce(p.replied,1) replied,coalesce(p.mentions,1) mentions,coalesce(p.assigned,1) assigned,EXISTS(SELECT 1 FROM mail_suppressed WHERE address=u.email) muted FROM users u LEFT JOIN mail_settings p ON p.user_id=u.id WHERE u.id=?`,
        u.id
      ).first<Record<string, number>>()) ?? missing()
  return {
    email: u.email,
    opened: !p.muted && !!p.opened,
    replied: !p.muted && !!p.replied,
    mentions: !p.muted && !!p.mentions,
    assigned: !p.muted && !!p.assigned
  }
}
mailRoutes.get("/api/me/notifications", async (c) => c.json(await prefs(c)))
mailRoutes.patch("/api/me/notifications", async (c) => {
  const u = c.var.user ?? fail(401, "sign_in", "Sign in to manage notification settings"),
    b = await body(c),
    keys = Object.keys(b)
  if (
    !keys.length ||
    keys.some((k) => !["opened", "replied", "mentions", "assigned"].includes(k) || typeof b[k] !== "boolean")
  )
    bad("Expected notification switches; email is read-only")
  await c.env.DB.batch([
    sql(
      c.env,
      `INSERT INTO mail_settings(user_id,${keys}) VALUES(?,${keys.map(() => "?")}) ON CONFLICT(user_id) DO UPDATE SET ${keys.map((k) => `${k}=excluded.${k}`)}`,
      u.id,
      ...keys.map((k) => Number(b[k]))
    ),
    ...(keys.some((k) => b[k])
      ? [sql(c.env, "DELETE FROM mail_suppressed WHERE address=? AND reason='unsubscribe'", u.email)]
      : [])
  ])
  return c.json(await prefs(c))
})
async function issueId(c: Ctx) {
  const ids = [c.var.actor.id, ...(c.var.aliases ?? [])]
  return (
    (await sql(
      c.env,
      `SELECT id FROM issues WHERE app_id=? AND number=? AND (? OR (hidden IS NULL AND (private=0 OR json_extract(author,'$.id') IN(SELECT value FROM json_each(?)))))`,
      c.var.app.id,
      issueNumber(c.req.param("number")),
      Number(!!c.var.app.role),
      JSON.stringify(ids)
    ).first<string>("id")) ?? missing()
  )
}
async function subscription(c: Ctx, id: string): Promise<IssueSubscription> {
  const r = await sql(
    c.env,
    `SELECT s.*,EXISTS(SELECT 1 FROM mail_people p WHERE p.id=s.id AND CASE p.reason WHEN 'opened' THEN p.opened WHEN 'replied' THEN p.replied WHEN 'mentioned' THEN p.mentions WHEN 'assigned' THEN p.assigned ELSE 1 END) eligible FROM mail_subs s WHERE issue_id=? AND actor_id=?`,
    id,
    c.var.actor.id
  ).first<Sub & { eligible: number }>()
  const on = !!r?.eligible && r.state === "on",
    pending = !!r?.eligible && r.state === "pending"
  return {
    subscribed: on,
    pending,
    reason: on ? r!.reason : null,
    email:
      c.var.user?.email ??
      (r && (on || pending) ? r.address[0] + "***" + r.address.slice(r.address.lastIndexOf("@")) : null)
  }
}
const route = "/api/apps/:slug/issues/:number/subscription"
mailRoutes.get(route, async (c) => c.json(await subscription(c, await issueId(c))))
mailRoutes.put(route, async (c) => {
  await allowWrite(c)
  const iid = await issueId(c),
    b = await body(c),
    actor = c.var.actor.id,
    u = c.var.user
  if (typeof b.subscribed !== "boolean") bad("Expected subscribed")
  if (!b.subscribed) {
    await sql(
      c.env,
      `UPDATE mail_subs SET state='off',nonce=lower(hex(randomblob(16))) WHERE issue_id=? AND actor_id=?`,
      iid,
      actor
    ).run()
    if (u)
      await sql(
        c.env,
        "INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,user_id,address,state,reason) VALUES(?,?,?,?,'off','manual')",
        iid,
        actor,
        u.id,
        u.email
      ).run()
  } else {
    const address =
      u?.email ??
      email(
        b.email ??
          (await sql(c.env, "SELECT address FROM mail_subs WHERE issue_id=? AND actor_id=?", iid, actor).first<string>(
            "address"
          ))
      )
    if (await sql(c.env, "SELECT 1 FROM mail_suppressed WHERE address=?", address).first()) bad("Email unavailable")
    if (
      await sql(
        c.env,
        `SELECT 1 FROM blocks WHERE app_id=? AND (actor_id=? OR actor_id=(SELECT id FROM users WHERE email=?))`,
        c.var.app.id,
        actor,
        address
      ).first()
    )
      denied()
    if (!u) {
      await enforce(c, "RL_HUMAN", `confirm:ip:${clientIP(c)}`)
      await enforce(c, "RL_UPLOAD", `confirm:addr:${await sha256(address)}`)
    }
    const [saved] = await c.env.DB.batch<Sub>([
      sql(
        c.env,
        `INSERT INTO mail_subs(issue_id,actor_id,user_id,guest_hash,address,state,reason,requested) VALUES(?,?,?,?,?,?,'manual',unixepoch())
      ON CONFLICT(issue_id,actor_id) DO UPDATE SET address=excluded.address,state=excluded.state,reason='manual',requested=excluded.requested,nonce=lower(hex(randomblob(16)))
      WHERE mail_subs.state='off' OR mail_subs.address!=excluded.address OR (mail_subs.state='pending' AND mail_subs.requested<unixepoch()-600) RETURNING *`,
        iid,
        actor,
        u?.id ?? null,
        u ? null : c.var.guestHash,
        address,
        u ? "on" : "pending"
      ),
      ...(!u
        ? [
            guestWrite(c.env, c.var.guestHash),
            sql(
              c.env,
              `UPDATE guest_report_authors SET guest_hash=?,name=NULL WHERE guest_hash IS NULL AND actor_id=(SELECT json_extract(author,'$.id') FROM issues WHERE id=?) AND actor_id IN(SELECT value FROM json_each(?))`,
              c.var.guestHash,
              iid,
              JSON.stringify([actor, ...(c.var.aliases ?? [])])
            )
          ]
        : [
            sql(
              c.env,
              "UPDATE mail_subs SET reason='manual' WHERE issue_id=? AND actor_id=? AND state='on'",
              iid,
              actor
            )
          ])
    ])
    const r = saved!.results[0]
    if (
      r &&
      !u &&
      (await sql(c.env, "SELECT 1 FROM mail_people WHERE id=? AND nonce=? AND state='pending'", r.id, r.nonce).first())
    ) {
      const confirm = `${mailOrigin(c.env)}/email/confirm?t=${await mailToken(c.env, "confirm", r)}`,
        unsub = unsubscribeURL(c.env, await mailToken(c.env, "unsubscribe", r))
      // Neutral double opt-in. Never disclose the issue, workspace or custom text to an unverified address.
      try {
        await sendMail(c.env, "confirm-" + r.nonce, {
          to: address,
          fromName: "Bellhop",
          subject: "Confirm your Bellhop subscription",
          text: `Confirm this subscription: ${confirm}\nIf you did not request this, ignore this message, unsubscribe: ${unsub}, or stop all email: ${unsub}&all=1`,
          html: `<p>Confirm that you want email updates on a Bellhop issue.</p><p><a href="${esc(confirm)}">Confirm subscription</a></p><p>If you didn’t request this, ignore this message, <a href="${esc(unsub)}">unsubscribe</a>, or <a href="${esc(unsub + "&all=1")}">stop all Bellhop email</a>.</p>`
        })
      } catch (e) {
        await sql(c.env, "UPDATE mail_subs SET requested=0 WHERE id=? AND nonce=?", r.id, r.nonce).run()
        throw e
      }
    }
  }
  return c.json(await subscription(c, iid))
})
function page(c: Ctx, text: string, form = "") {
  return c.html(`<!doctype html><meta charset=utf-8><title>Bellhop email</title><p>${esc(text)}</p>${form}`, 200, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'"
  })
}
mailRoutes.get("/email/confirm", async (c) => {
  const t = c.req.query("t") ?? "",
    r = await sql(
      c.env,
      `SELECT id,nonce FROM mail_people WHERE id=? AND state='pending' AND requested>=unixepoch()-86400`,
      t.slice(0, 24)
    ).first<TokenRow>()
  if (!r || !(await checkToken(c.env, "confirm", r, t)))
    return page(c, "This confirmation link is expired or no longer available.")
  const changed = await sql(
    c.env,
    "UPDATE mail_subs SET state='on' WHERE id=? AND nonce=? AND state='pending' AND EXISTS(SELECT 1 FROM mail_people p WHERE p.id=mail_subs.id)",
    r.id,
    r.nonce
  ).run()
  return page(
    c,
    changed.meta.changes
      ? "Confirmed. You will receive updates on this issue."
      : "This confirmation link is no longer active."
  )
})
mailRoutes.on(["GET", "POST"], "/email/unsubscribe", async (c) => {
  const t = c.req.query("t") ?? "",
    all = c.req.query("all") === "1",
    r = await sql(c.env, "SELECT * FROM mail_subs WHERE id=?", t.slice(0, 24)).first<Sub>()
  if (!r || !(await checkToken(c.env, "unsubscribe", r, t))) return page(c, "This link is no longer active.")
  if (c.req.method === "GET")
    return page(
      c,
      all ? "Stop all Bellhop email?" : "Stop email about this issue?",
      `<form method="post"><button>Unsubscribe</button></form>`
    )
  if (all)
    await sql(
      c.env,
      "INSERT OR IGNORE INTO mail_suppressed(address,reason) SELECT address,'unsubscribe' FROM mail_subs WHERE id=? AND nonce=?",
      r.id,
      r.nonce
    ).run()
  else
    await sql(
      c.env,
      `UPDATE mail_subs SET state='off',nonce=lower(hex(randomblob(16))) WHERE (issue_id,address) IN
       (SELECT issue_id,address FROM mail_subs WHERE id=? AND nonce=?)`,
      r.id,
      r.nonce
    ).run()
  return page(c, "Unsubscribed.")
})

mailRoutes.post("/webhooks/opensend/:channel", async (c) => {
  const channel = c.req.param("channel")
  if (channel !== "inbound" && channel !== "events") missing()
  const secret =
    channel === "inbound"
      ? secrets(c.env).OPENSEND_INBOUND_WEBHOOK_SECRET
      : secrets(c.env).OPENSEND_EVENTS_WEBHOOK_SECRET
  if (!secret || !/^whsec_[A-Za-z0-9+/]{43}=$/.test(secret))
    fail(503, "misconfigured", "Webhook signing key unavailable")
  const id = c.req.header("Webhook-Id") ?? "",
    ts = c.req.header("Webhook-Timestamp") ?? "",
    sigs = c.req.header("Webhook-Signature") ?? ""
  if (!id || id.length > 200 || !/^\d{10}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) denied()
  const raw = new Uint8Array(await c.req.arrayBuffer()),
    prefix = new TextEncoder().encode(`${id}.${ts}.`),
    data = new Uint8Array(prefix.length + raw.length)
  data.set(prefix)
  data.set(raw, prefix.length)
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(atob(secret.slice(6)), (x) => x.charCodeAt(0)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  )
  let valid = false
  for (const sig of sigs.split(" ").slice(0, 5)) {
    if (
      /^v1,[A-Za-z0-9+/]{43}=$/.test(sig) &&
      (await crypto.subtle.verify(
        "HMAC",
        key,
        Uint8Array.from(atob(sig.slice(3)), (x) => x.charCodeAt(0)),
        data
      ))
    ) {
      valid = true
      break
    }
  }
  if (!valid) denied()
  let e: InboundEvent & { id: string; type: string; environment: string; data: { emailId?: string } }
  try {
    e = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM:false }).decode(raw))
  } catch {
    bad("Invalid webhook JSON")
  }
  if (e.id !== id) denied()
  if (await sql(c.env, "SELECT 1 FROM mail_hook_seen WHERE channel=? AND id=?", channel, id).first())
    return c.body(null, 204)
  if (!c.req.header("OpenSend-Test")) {
    if (channel === "inbound" && !devMail(c.env)) await receiveEvent(c.env, c.executionCtx, e)
    if (
      channel === "events" &&
      e.environment === (devMail(c.env) ? "test" : "live") &&
      (e.type === "email.bounced" || e.type === "email.complained") &&
      typeof e.data?.emailId === "string"
    )
      await handleDeliveryProblem(c.env, {
        id: e.data.emailId,
        status: e.type === "email.bounced" ? "bounced" : "complained"
      })
  }
  await sql(c.env, "INSERT OR IGNORE INTO mail_hook_seen(channel,id) VALUES(?,?)", channel, id).run()
  return c.body(null, 204)
})
