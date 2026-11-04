import type { Actor, Locale } from "../shared/api"
import { email, fail, hex, missing, now, sha256, sql, uid } from "./core"
import { agentAccessSQL } from "./permissions"
import { entry } from "./audit"
import { accountCopy, deskCopy, formatMail } from "./mail-copy"
import { cleanSender, devMail, emailConfigured, esc, mailOrigin, sendMail, workspaceSender } from "./mail-provider"

export type Challenge = { app: string | null; email: string } & (
  | { kind: "account" | "contact"; requester: string; issue?: never }
  | { kind: "verification"; issue: string; requester?: never }
)
const invalid = () => fail(400, "invalid_code", "Invalid or expired code")
function generate() {
  const a = new Uint32Array(1)
  do {
    crypto.getRandomValues(a)
  } while (a[0]! >= Math.floor(2 ** 32 / 1e6) * 1e6)
  return String(a[0]! % 1e6).padStart(6, "0")
}
async function digest(env: Env, id: string, code: string) {
  if (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32) fail(503, "misconfigured", "Code verification unavailable")
  const e = new TextEncoder(),
    key = await crypto.subtle.importKey("raw", e.encode(env.COOKIE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign"
    ])
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, e.encode(`email-code-v1:${id}:${code}`)))
}
const charge = (env: Env, key: string, period: number, cap: number) =>
  sql(
    env,
    `INSERT INTO code_budget(key,bucket,hits,cap) VALUES(?,?,1,?) ON CONFLICT(key) DO UPDATE SET bucket=excluded.bucket,hits=CASE WHEN bucket=excluded.bucket THEN hits+1 ELSE 1 END`,
    key,
    Math.floor(Date.now() / 1000 / period) * period,
    cap
  )
export async function issueCode(
  env: Env,
  x: Challenge,
  ip: string,
  workspace: string,
  locale: Locale,
  actor?: Actor,
  owners: string[] = [],
  team = false
) {
  if (!emailConfigured(env) && !(devMail(env) && env.DEV_LOGIN === "1" && !env.APP_DOMAIN))
    fail(503, "mail_unavailable", "Email delivery unavailable")
  const id = uid(),
    code = generate(),
    address = await sha256(email(x.email)),
    scope = `${x.kind}:${x.app ?? "apex"}:${address}`,
    hash = hex(await digest(env, id, code))
  const q = [
    charge(env, "addr-hour:" + scope, 3600, 5),
    charge(env, "addr-day:" + scope, 86400, 10),
    charge(env, "ip-hour:" + (await sha256(ip)), 3600, 30),
    ...(x.app ? [charge(env, "space-hour:" + x.app, 3600, 120), charge(env, "space-day:" + x.app, 86400, 500)] : [])
  ]
  if (x.app) {
    const recipient = (scope: string) =>
      sql(env, "INSERT OR IGNORE INTO code_recipients VALUES(?,date('now'),?,?)", x.app, scope, address)
    q.push(recipient("workspace"))
    if (x.issue && !team) q.push(recipient("issue:" + x.issue))
  }
  if (x.issue) q.push(charge(env, "issue-day:" + x.issue, 86400, 5))
  else
    q.push(
      sql(
        env,
        "DELETE FROM email_codes WHERE kind=? AND app_id IS ? AND email=? AND requested_by=? AND state='pending'",
        x.kind,
        x.app,
        x.email,
        x.requester
      )
    )
  const gate =
    x.kind === "account"
      ? "1"
      : x.kind === "contact"
        ? "EXISTS(SELECT 1 FROM apps WHERE id=?3 AND mode='helpdesk')"
        : `EXISTS(SELECT 1 FROM issues i JOIN apps a ON a.id=i.app_id WHERE i.id=?4 AND i.app_id=?3 AND (${actor?.type === "agent" ? `EXISTS(SELECT 1 FROM (${agentAccessSQL}) acl WHERE acl.app_id=i.app_id AND agent_id=?9 AND acl.role IN ('responder','member','admin'))` : team ? "EXISTS(SELECT 1 FROM members WHERE app_id=i.app_id AND user_id=?9)" : "i.hidden IS NULL AND json_extract(i.author,'$.id') IN(SELECT value FROM json_each(?10)) AND (a.mode!='helpdesk' OR EXISTS(SELECT 1 FROM contacts t WHERE t.app_id=i.app_id AND t.id=?9))"}))`
  const google = "(?2='account' AND EXISTS(SELECT 1 FROM users WHERE email=?5 AND google_sub IS NOT NULL))",
    index = q.length
  q.push(
    sql(
      env,
      `INSERT INTO email_codes(id,kind,app_id,issue_id,email,requested_by,digest,expires,created_at,state) SELECT ?1,?2,?3,?4,?5,?6,CASE WHEN ${google} THEN NULL ELSE ?7 END,unixepoch()+600,?8,CASE WHEN ${google} THEN 'failed' ELSE 'pending' END WHERE ${gate} RETURNING state,(SELECT trusted FROM apps WHERE id=?3) trusted`,
      id,
      x.kind,
      x.app,
      x.issue ?? null,
      x.email,
      actor ? JSON.stringify(actor) : x.requester,
      hash,
      now(),
      ...(actor ? [actor.id, ...(team ? [] : [JSON.stringify(owners)])] : [])
    )
  )
  if (team && x.issue && actor && x.app)
    q.push(entry(env, x.app, actor, "verification.requested", { type: "issue", id: x.issue }, { verification_id: id }))
  const row = (await env.DB.batch<{ state: string; trusted: number | null }>(q))[index]!.results[0] ?? missing()
  const googleOnly = x.kind === "account" && row.state === "failed"
  const copy = deskCopy[locale],
    name = x.app ? workspaceSender(workspace, !!row.trusted) : cleanSender(workspace),
    googleLink = mailOrigin(env) + "/auth/google",
    text = googleOnly ? `${accountCopy[locale].google} ${googleLink}` : formatMail(copy.code, { workspace: name, code })
  try {
    await sendMail(
      env,
      "code-" + id,
      {
        to: x.email,
        fromName: name,
        subject: formatMail(x.kind === "verification" ? copy.verify : copy.signin, { workspace: name }),
        text,
        html: googleOnly
          ? `<p><a href="${esc(googleLink)}">${esc(accountCopy[locale].google)}</a></p>`
          : `<p>${esc(text)}</p>`
      },
      code
    )
  } catch {
    await sql(env, "UPDATE email_codes SET state='failed',digest=NULL WHERE id=? AND state='pending'", id).run()
    fail(503, "mail_unavailable", "Email delivery unavailable")
  }
  return id
}
export async function redeemCode(env: Env, x: Challenge, raw: unknown, id?: string, owners?: string[]) {
  // Even a malformed attempt consumes a try on a live challenge. HMAC with a
  // server-side key prevents an offline search over a million possible values.
  const row = await sql(
    env,
    `SELECT id,digest FROM email_codes WHERE kind=? AND app_id IS ? AND email=? AND issue_id IS ? AND state='pending' AND (? IS NULL OR id=?) AND (kind='verification' OR requested_by=?)`,
    x.kind,
    x.app,
    x.email,
    x.issue ?? null,
    id ?? null,
    id ?? null,
    x.requester ?? null
  ).first<{ id: string; digest: string }>()
  const candidate = await digest(
      env,
      row?.id ?? "missing",
      typeof raw === "string" && /^\d{6}$/.test(raw) ? raw : "invalid"
    ),
    expected = Uint8Array.from((row?.digest ?? "00".repeat(32)).match(/../g)!, (v) => parseInt(v, 16))
  const matched = crypto.subtle.timingSafeEqual(candidate, expected)
  const at = now()
  const result = await sql(
    env,
    `UPDATE email_codes SET tries=tries+1,state=CASE WHEN expires<=unixepoch() THEN 'expired' WHEN ?1 THEN 'verified' WHEN tries>=4 THEN 'failed' ELSE 'pending' END,
 digest=CASE WHEN expires<=unixepoch() OR ?1 OR tries>=4 THEN NULL ELSE digest END,verified_at=CASE WHEN expires>unixepoch() AND ?1 THEN ?2 END
 WHERE id=?3 AND state='pending' AND (kind='verification' OR requested_by=?5) AND (issue_id IS NULL OR EXISTS(SELECT 1 FROM issues i WHERE i.id=email_codes.issue_id AND i.app_id=email_codes.app_id AND json_extract(i.author,'$.id') IN(SELECT value FROM json_each(?4)))) RETURNING state`,
    Number(matched),
    at,
    row?.id ?? null,
    JSON.stringify(owners ?? []),
    x.requester ?? null
  ).first<{ state: string }>()
  if (result?.state !== "verified") {
    if (x.kind === "account") return null
    invalid()
  }
  return row!.id
}
export async function expireCodes(env: Env) {
  await env.DB.batch([
    sql(
      env,
      "UPDATE email_codes SET state='expired',digest=NULL WHERE id IN(SELECT id FROM email_codes WHERE state='pending' AND expires<=unixepoch() LIMIT 500)"
    ),
    sql(env, "DELETE FROM email_codes WHERE kind!='verification' AND expires<unixepoch()-86400"),
    sql(
      env,
      "DELETE FROM email_codes WHERE kind='verification' AND state IN ('failed','expired') AND expires<unixepoch()-30*86400"
    ),
    sql(env, "DELETE FROM code_recipients WHERE day<date('now')"),
    sql(env, "DELETE FROM contact_sessions WHERE expires<=unixepoch()"),
    sql(env, "DELETE FROM code_budget WHERE bucket<unixepoch()-86400")
  ])
}
