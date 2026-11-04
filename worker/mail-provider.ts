import { hex, sql } from "./core"

type MailSecrets = {
  OPENSEND_API_KEY?: string
  OPENSEND_INBOUND_KEY?: string
  OPENSEND_EVENTS_WEBHOOK_SECRET?: string
  OPENSEND_INBOUND_WEBHOOK_SECRET?: string
}
export const secrets = (env: Env): MailSecrets => env as Env & MailSecrets
export const devMail = (env: Env) => !env.APP_DOMAIN || env.DEV_LOGIN === "1"
export const mailOrigin = (env: Env) =>
  env.APP_DOMAIN ? `https://${env.APP_DOMAIN}` : new URL(env.PUBLIC_ORIGIN || "http://127.0.0.1:5287").origin
export const esc = (v: string) =>
  v.replace(/[&<>"']/g, (s) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[s]!)
export type TokenRow = { id: string; nonce: string }
type Purpose = "confirm" | "unsubscribe" | "reply" | "note"
async function mac(env: Env, purpose: Purpose, row: TokenRow) {
  if (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32) throw Error("Missing mail signing key")
  const enc = new TextEncoder(),
    key = await crypto.subtle.importKey(
      "raw",
      enc.encode(env.COOKIE_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    )
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, enc.encode(`bellhop-email-v1:${purpose}:${row.id}:${row.nonce}`))
  ).slice(0, 16)
}
export async function mailToken(env: Env, purpose: Purpose, row: TokenRow) {
  return row.id + "." + hex(await mac(env, purpose, row))
}
export async function checkToken(env: Env, purpose: Purpose, row: TokenRow, token: string) {
  if (!/^[a-f0-9]{24}\.[a-f0-9]{32}$/.test(token) || row.id !== token.slice(0, 24)) return false
  return crypto.subtle.timingSafeEqual(
    await mac(env, purpose, row),
    Uint8Array.from(token.slice(25).match(/../g)!, (x) => parseInt(x, 16))
  )
}
export function unsubscribeURL(env: Env, token: string) {
  return `${mailOrigin(env)}/email/unsubscribe?t=${token}`
}
export class ProviderError extends Error {
  constructor(readonly status: number) {
    super(`OpenSend HTTP ${status}`)
  }
}
export async function provider<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const origin = new URL(env.OPENSEND_API)
  if (origin.protocol !== "https:" || origin.origin !== env.OPENSEND_API) throw Error("Invalid OPENSEND_API origin")
  const inbound = path.startsWith("/v1/inbound/") || path.startsWith("/mailbox/v1/")
  if (inbound && devMail(env)) throw Error("Inbound mailbox reads disabled in development")
  const key = inbound ? secrets(env).OPENSEND_INBOUND_KEY : secrets(env).OPENSEND_API_KEY
  if (!key || (devMail(env) && !/^os_test_[a-f0-9]{64}$/i.test(key)))
    throw Error("OpenSend key missing or not a test key in dev")
  const res = await fetch(origin.origin + path, {
    ...init,
    redirect: "manual", // Reject non-2xx below; never forward the bearer to a redirect target.
    signal: AbortSignal.timeout(12000),
    headers: { ...init?.headers, Authorization: "Bearer " + key }
  })
  if (!res.ok) {
    await res.body?.cancel()
    throw new ProviderError(res.status)
  }
  return res.json<T>()
}
type Letter = { to: string; fromName: string; replyTo?: string[]; subject: string; html: string; text: string }
export const cleanSender = (s: string) =>
  s
    .replace(/[<>"@,;\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim() || "Workspace"
export const workspaceSender = (name: string, trusted: boolean) => cleanSender(name) + (trusted ? "" : " via Bellhop")
export const emailConfigured = (env: Env) =>
  !!secrets(env).OPENSEND_API_KEY &&
  (devMail(env)
    ? /^os_test_[a-f0-9]{64}$/i.test(secrets(env).OPENSEND_API_KEY!)
    : (env as { MAIL_DELIVERY?: string }).MAIL_DELIVERY === "live")
export async function sendMail(env: Env, id: string, letter: Letter, redactCode?: string, formCode?: string) {
  // Reserve the address before sending. An erasure while the provider is acknowledging
  // the message removes this row, so a late acknowledgement cannot put the address back.
  const pending = "pending:" + crypto.randomUUID()
  if (formCode) {
    // Erasure, expiry or successful delivery while a queued worker was decrypting: don't send or restore a receipt.
    const reserve = await sql(
      env,
      `INSERT INTO mail_sent(provider_id,address) SELECT ?,v.email FROM email_codes v JOIN form_code_mail j ON j.id=v.id JOIN apps a ON a.id=v.app_id AND a.mode='helpdesk' WHERE v.id=? AND v.email=? AND v.state='pending' AND v.expires>unixepoch()`,
      pending,
      formCode,
      letter.to
    ).run()
    if (!reserve.meta.changes) return
  } else await sql(env, "INSERT INTO mail_sent(provider_id,address) VALUES(?,?)", pending, letter.to).run()
  try {
    const body = {
      ...letter,
      fromName: cleanSender(letter.fromName),
      from: "notifications@mail.blhp.app",
      kind: "transactional",
      tracking: false,
      screen: true
    }
    let providerId: string
    if (!secrets(env).OPENSEND_API_KEY && env.DEV_LOGIN === "1" && !env.APP_DOMAIN) {
      console.log(
        "bellhop.dev_mail",
        redactCode ? JSON.stringify(body).replaceAll(redactCode, "[redacted]") : JSON.stringify(body)
      )
      providerId = "logged_" + id
    } else if (env.APP_DOMAIN && (env as { MAIL_DELIVERY?: string }).MAIL_DELIVERY !== "live") {
      // Production holds outgoing mail until Ryan turns delivery on (MAIL_DELIVERY=live). Held mail counts as sent, so
      // turning it on later doesn't release a backlog.
      console.log("bellhop.mail_held", id)
      providerId = "held_" + id
    } else {
      const r = await provider<{ id: string; status: string; simulated: boolean }>(env, "/v1/emails/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": id },
        body: JSON.stringify(body)
      })
      if (!r.id || r.status !== "queued" || (devMail(env) && !r.simulated))
        throw Error("Unexpected OpenSend acknowledgement")
      providerId = r.id
    }
    await env.DB.batch([
      sql(
        env,
        "INSERT OR IGNORE INTO mail_sent(provider_id,address) SELECT ?,address FROM mail_sent WHERE provider_id=?",
        providerId,
        pending
      ),
      sql(env, "DELETE FROM mail_sent WHERE provider_id=?", pending)
    ])
  } catch (e) {
    await sql(env, "DELETE FROM mail_sent WHERE provider_id=?", pending).run()
    throw e
  }
}
