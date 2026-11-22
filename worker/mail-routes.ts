import { Hono } from "hono"
import type { IssueSubscription, Locale, NotificationSettings } from "../shared/api"
import { requestLocale } from "./locale"
import { mailCopy, deskCopy, feedbackCopy, formatMail } from "./mail-copy"
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
  workspaceSender,
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
        `SELECT coalesce(p.opened,1) opened,coalesce(p.replied,1) replied,coalesce(p.mentions,1) mentions,coalesce(p.assigned,1) assigned,coalesce(p.approvals,EXISTS(SELECT 1 FROM team m JOIN apps a ON a.id=m.app_id AND a.mode='helpdesk' WHERE m.user_id=u.id AND (m.role IN ('admin','owner') OR EXISTS(SELECT 1 FROM issues i WHERE i.app_id=m.app_id AND json_extract(i.assignee,'$.id')=u.id)))) approvals,EXISTS(SELECT 1 FROM mail_suppressed WHERE address=u.email) muted FROM users u LEFT JOIN mail_settings p ON p.user_id=u.id WHERE u.id=?`,
        u.id
      ).first<Record<string, number>>()) ?? missing()
  return {
    email: u.email,
    approvals: !p.muted && !!p.approvals,
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
    keys.some(
      (k) => !["opened", "replied", "mentions", "assigned", "approvals"].includes(k) || typeof b[k] !== "boolean"
    )
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
    u = c.var.user,
    trusted = u?.email ?? c.var.contact?.email
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
      trusted ??
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
    if (!trusted) {
      await enforce(c, "RL_HUMAN", `confirm:ip:${clientIP(c)}`)
      await enforce(c, "RL_UPLOAD", `confirm:addr:${await sha256(address)}`)
    }
    const [, reservation] = await c.env.DB.batch<Sub>([
      sql(
        c.env,
        `INSERT INTO mail_subs(issue_id,actor_id,user_id,guest_hash,address,state,reason,requested,locale) VALUES(?,?,?,?,?,?,'manual',unixepoch(),?)
      ON CONFLICT(issue_id,actor_id) DO UPDATE SET address=excluded.address,state=excluded.state,reason='manual',requested=excluded.requested,nonce=lower(hex(randomblob(16))),locale=excluded.locale
      WHERE mail_subs.state='off' OR mail_subs.address!=excluded.address OR (mail_subs.state='pending' AND mail_subs.requested<unixepoch()-86400)`,
        iid,
        actor,
        u?.id ?? null,
        trusted ? null : c.var.guestHash,
        address,
        trusted ? "on" : "pending",
        requestLocale(c).locale
      ),
      ...(!trusted
        ? [
            // Same pending API state regardless of requests on other issues. Only the
            // winning address-wide reservation is allowed to send a confirmation link.
            reserveConfirmation(c.env, iid, actor),
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
    const r = !trusted && reservation?.results[0]
    const pending =
      r &&
      (await sql(
        c.env,
        "SELECT p.locale,a.trusted FROM mail_people p JOIN apps a ON a.id=p.app_id WHERE p.id=? AND p.nonce=? AND p.state='pending'",
        r.id,
        r.nonce
      ).first<{ locale: Locale | null; trusted: number }>())
    if (r && pending) await sendConfirmation(c.env, r, address, { ...pending, workspace: c.var.app.name })
  }
  return c.json(await subscription(c, iid))
})
// The one confirmation email for a reserved pending subscription (see confirmation_daily). Neutral double opt-in:
// never disclose the issue, workspace or custom text to an unverified address.
export async function sendConfirmation(
  env: Env,
  r: TokenRow,
  address: string,
  pending: { locale: Locale | null; trusted: number; workspace: string }
) {
  const confirm = `${mailOrigin(env)}/email/confirm?t=${await mailToken(env, "confirm", r)}`,
    unsub = unsubscribeURL(env, await mailToken(env, "unsubscribe", r)),
    copy = mailCopy[pending.locale ?? "en"],
    desk = pending.trusted ? deskCopy[pending.locale ?? "en"] : null,
    workspace = pending.workspace.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim(),
    intro = desk?.intro ?? copy.confirmIntro
  try {
    await sendMail(env, "confirm-" + r.nonce, {
      to: address,
      fromName: desk ? workspace : "Bellhop",
      subject: desk ? formatMail(desk.confirm, { workspace }) : copy.confirmSubject,
      text: `${intro}\n${copy.confirmAction}: ${confirm}\n\n${copy.ignore}\n${copy.unsubscribe}: ${unsub}${desk ? "" : `\n${copy.stop}: ${unsub}&all=1`}`,
      html: `<p>${esc(intro)}</p><p><a href="${esc(confirm)}">${esc(copy.confirmAction)}</a></p><p>${esc(copy.ignore)}</p><p><a href="${esc(unsub)}">${esc(copy.unsubscribe)}</a>${desk ? "" : ` · <a href="${esc(unsub + "&all=1")}">${esc(copy.stop)}</a>`}</p>`
    })
  } catch (e) {
    await sql(env, "UPDATE mail_subs SET requested=0 WHERE id=? AND nonce=?", r.id, r.nonce).run()
    throw e
  }
}
// A feedback reporter's one confirmation, sent when the team first replies: the workspace's name and that a reply is
// waiting, nothing of the reply itself, and the workspace's sender ("{workspace} via Bellhop" unless trusted).
export async function sendFeedbackConfirmation(
  env: Env,
  r: TokenRow,
  address: string,
  app: { locale: Locale | null; trusted: number; name: string }
) {
  const confirm = `${mailOrigin(env)}/email/confirm?t=${await mailToken(env, "confirm", r)}`,
    unsub = unsubscribeURL(env, await mailToken(env, "unsubscribe", r)),
    copy = mailCopy[app.locale ?? "en"],
    words = feedbackCopy[app.locale ?? "en"],
    workspace = app.name.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim(),
    intro = formatMail(words.intro, { workspace }),
    action = words.action
  await sendMail(env, "feedback-confirm-" + r.nonce, {
    to: address,
    fromName: workspaceSender(workspace, !!app.trusted),
    subject: formatMail(words.subject, { workspace }),
    text: `${intro}\n${action}: ${confirm}\n\n${copy.ignore}\n${copy.unsubscribe}: ${unsub}`,
    html: `<p>${esc(intro)}</p><p><a href="${esc(confirm)}">${esc(action)}</a></p><p>${esc(copy.ignore)}</p><p><a href="${esc(unsub)}">${esc(copy.unsubscribe)}</a></p>`
  })
}
// Reserve the address-wide confirmation for a pending subscription (the same rules as the subscription route).
export const reserveConfirmation = (env: Env, issue: string, actor: string) =>
  sql(
    env,
    `INSERT INTO confirmation_daily(address,day,sub_id,nonce,n)
   SELECT s.address,date('now'),s.id,s.nonce,1 FROM mail_people s WHERE s.issue_id=? AND s.actor_id=? AND s.state='pending'
   AND NOT EXISTS(SELECT 1 FROM confirmation_daily d JOIN mail_subs p ON p.id=d.sub_id AND p.address=d.address AND p.nonce=d.nonce WHERE d.address=s.address AND p.state='pending' AND p.requested>=unixepoch()-86400)
   ON CONFLICT(address) DO UPDATE SET day=excluded.day,sub_id=excluded.sub_id,nonce=excluded.nonce,n=CASE WHEN day=excluded.day THEN n+1 ELSE 1 END RETURNING sub_id id,nonce,address`,
    issue,
    actor
  )
function page(c: Ctx, text: string, form = "") {
  return c.html(`<!doctype html><meta charset=utf-8><title>Email preferences</title><p>${esc(text)}</p>${form}`, 200, {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex",
    "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'"
  })
}
// Confirming takes a POST from the page's button, so link scanners that open (GET) the link don't confirm anything.
mailRoutes.on(["GET", "POST"], "/email/confirm", async (c) => {
  const t = c.req.query("t") ?? "",
    r = await sql(
      c.env,
      `SELECT id,nonce,issue_id,address,EXISTS(SELECT 1 FROM feedback WHERE issue_id=mail_people.issue_id) feedback FROM mail_people WHERE id=? AND state='pending' AND requested>=unixepoch()-86400`,
      t.slice(0, 24)
    ).first<TokenRow & { issue_id: string; address: string; feedback: number }>()
  if (!r || !(await checkToken(c.env, "confirm", r, t)))
    return page(c, "This confirmation link is expired or no longer available.")
  if (c.req.method === "GET")
    return page(
      c,
      r.feedback ? "Confirm your email address to read the reply and get future replies?" : "Confirm email updates on this issue?",
      `<form method="post"><button>Confirm</button></form>`
    )
  const changed = await sql(
    c.env,
    "UPDATE mail_subs SET state='on' WHERE id=? AND nonce=? AND state='pending' AND EXISTS(SELECT 1 FROM mail_people p WHERE p.id=mail_subs.id)",
    r.id,
    r.nonce
  ).run()
  if (!changed.meta.changes) return page(c, "This confirmation link is no longer active.")
  if (!r.feedback) return page(c, "Confirmed. You will receive updates on this issue.")
  // Feedback: the address is proved for this app, so every pending feedback subscription with it there turns on, and
  // the replies already posted on those issues are sent (the one that triggered this confirmation among them).
  const on = await sql(
    c.env,
    `UPDATE mail_subs SET state='on' WHERE state='pending' AND user_id IS NULL AND address=?1 AND issue_id IN
      (SELECT f.issue_id FROM feedback f WHERE f.app_id=(SELECT app_id FROM feedback WHERE issue_id=?2)) RETURNING id`,
    r.address,
    r.issue_id
  ).all<{ id: string }>()
  const subs = JSON.stringify([r.id, ...on.results.map((s) => s.id)])
  await c.env.DB.batch([
    sql(
      c.env,
      `INSERT INTO mail_batches(sub_id,issue_id,address,due) SELECT s.id,s.issue_id,s.address,unixepoch() FROM mail_subs s WHERE s.id IN (SELECT value FROM json_each(?))
      AND EXISTS(SELECT 1 FROM comments c WHERE c.issue_id=s.issue_id AND c.internal=0 AND c.hidden IS NULL AND json_extract(c.author,'$.id')!=s.actor_id)
      ON CONFLICT(issue_id,address) WHERE sealed=0 DO UPDATE SET sub_id=excluded.sub_id,due=excluded.due`,
      subs
    ),
    sql(
      c.env,
      `INSERT OR IGNORE INTO mail_items(batch_id,kind,ref,actor) SELECT b.id,'reply',c.id,json_extract(c.author,'$.id') FROM mail_batches b JOIN mail_subs s ON s.id=b.sub_id
      JOIN comments c ON c.issue_id=b.issue_id AND c.internal=0 AND c.hidden IS NULL AND json_extract(c.author,'$.id')!=s.actor_id
      WHERE b.sealed=0 AND b.sub_id IN (SELECT value FROM json_each(?)) ORDER BY c.created_at,c.rowid`,
      subs
    )
  ])
  return page(c, "Confirmed. The reply is on its way, and future replies will reach you by email.")
})
mailRoutes.on(["GET", "POST"], "/email/unsubscribe", async (c) => {
  const t = c.req.query("t") ?? "",
    all = c.req.query("all") === "1",
    r = await sql(c.env, "SELECT * FROM mail_subs WHERE id=?", t.slice(0, 24)).first<Sub>()
  if (!r || !(await checkToken(c.env, "unsubscribe", r, t))) return page(c, "This link is no longer active.")
  if (c.req.method === "GET")
    return page(
      c,
      all ? "Stop all email notifications?" : "Stop email about this issue?",
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
