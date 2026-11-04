import type { EndUser, Session, Workspace } from "../../shared/v1"
import { bad, denied, email, fail, input, now, secret, sha256, sql, str, uid, type Ctx } from "../core"
import { browserLocale, isLocale } from "../locale"
import { siteverify } from "../auth"
import { consumeIdentity, hostClaims, identityFailure, resolveHost, verifyIdentity } from "../identity"
import { issueCode, redeemCode } from "../email-codes"
import { keyAudit } from "./server-auth"
import { clientIP, enforce } from "../rate-limits"
import { liveGuard, ownOrigin, type Scope } from "./access"
import { apiOrigin } from "./access"
import { claimAnonymous } from "./anon-claim"
import { actorUpdated } from "../events"
import { contactActor } from "../contact-session"
import { contactRoom, signalContact } from "./signals"

const language = (c: Ctx) => browserLocale(c.req.header("Accept-Language"))
function siteKey(c: Ctx, s: Scope) {
  const ours =
    ownOrigin(c.env, s.slug, s.origin, new URL(c.req.url).origin) ||
    (!!c.env.APP_DOMAIN && s.origin === `https://${c.env.APP_DOMAIN}`)
  return ours && c.env.TURNSTILE_SECRET_KEY && c.env.TURNSTILE_SITE_KEY ? c.env.TURNSTILE_SITE_KEY : null
}
export async function workspace(c: Ctx, s: Scope): Promise<Workspace> {
  const icon = await sql(c.env, "SELECT icon_version FROM apps WHERE id=?", s.app).first<string>("icon_version")
  return {
    name: s.name,
    icon_url: icon
      ? (c.env.APP_DOMAIN ? apiOrigin(c) : new URL(c.req.url).origin) +
        "/icon/" +
        s.slug +
        "/" +
        encodeURIComponent(icon)
      : null,
    allow_anonymous: !!s.allow_anonymous,
    require_verified_email: !!s.require_verified_email,
    turnstile_site_key: siteKey(c, s),
    brand: { accent: null }
  }
}
async function human(c: Ctx, s: Scope, token: unknown) {
  if (!siteKey(c, s))
    fail(403, "turnstile_unavailable", "Use a workspace-hosted sign-in or host identity on this origin")
  if (!token) fail(428, "human_required", "Turnstile proof required")
  await siteverify(c, token, new URL(s.origin!).hostname)
}
async function requester(s: Scope, challenge: string, actor = s.user?.id ?? null) {
  return sha256(JSON.stringify(["v1:email:v2", s.key, s.origin, actor, challenge]))
}
export async function startEmail(c: Ctx, s: Scope, b: Record<string, unknown>, seed?: string) {
  await enforce(c, "RL_IP", "code-start:" + clientIP(c))
  const address = email(b.email)
  await human(c, s, b.turnstile_token)
  const challenge = c.req.header("Challenge-Token") ?? seed ?? secret()
  if (!/^[a-f0-9]{64}$/.test(challenge)) bad("Invalid challenge token")
  await issueCode(
    c.env,
    { kind: "contact", app: s.app, email: address, requester: await requester(s, challenge) },
    clientIP(c),
    s.name,
    language(c)
  )
  c.header("Challenge-Token", challenge)
  return { ok: true }
}
export async function mint(
  c: Ctx,
  s: Scope,
  b: Record<string, unknown>,
  emailFlow = false,
  seed?: string
): Promise<Session> {
  const raw = "bh_us_" + (seed ?? secret()),
    hash = await sha256(raw),
    expires = Math.floor(Date.now() / 1000) + 86400,
    q: D1PreparedStatement[] = [],
    env = c.env
  let sub: string | null = null,
    address: string | null = null,
    anon: string | null = null,
    locale = language(c),
    setLocale = false,
    claimIndex = -1
  if (emailFlow) {
    await enforce(c, "RL_IP", "code-verify:" + clientIP(c))
    address = email(b.email)
    const challenge = c.req.header("Challenge-Token") ?? ""
    if (!/^[0-9a-f]{64}$/.test(challenge)) fail(400, "invalid_code", "Invalid or expired code")
    if (s.user) q.push(liveGuard(c, s))
    const bound = await requester(s, challenge)
    // A key-started flow may finish with the browser's anonymous bearer. The
    // reverse is not allowed: another session never selects the starter's binding.
    const binding = s.user
      ? ((await sql(
          env,
          `SELECT requested_by FROM email_codes WHERE kind='contact' AND app_id=? AND email=? AND state='pending' AND requested_by IN (?,?) ORDER BY requested_by=? DESC LIMIT 1`,
          s.app,
          address,
          bound,
          await requester(s, challenge, null),
          bound
        ).first<string>("requested_by")) ?? bound)
      : bound
    await redeemCode(
      env,
      { kind: "contact", app: s.app, email: address, requester: binding },
      b.code,
      undefined,
      undefined,
      s.user ? liveGuard(c, s) : undefined
    )
    q.push(
      sql(
        env,
        `INSERT INTO contacts(id,app_id,email,name,locale,created_at,last_seen_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(app_id,email) DO UPDATE SET last_seen_at=excluded.last_seen_at,name=coalesce(contacts.name,excluded.name),locale=coalesce(contacts.locale,excluded.locale)`,
        "ct_" + uid(),
        s.app,
        address,
        s.user?.name ?? null,
        s.user?.locale ?? null,
        now(),
        now()
      )
    )
    if (s.user?.anonymous) {
      claimIndex = q.length
      q.push(
        ...claimAnonymous(env, s.app, address, s.user.id),
        sql(env, "DELETE FROM api_sessions WHERE app_id=? AND hash=? AND anon_id=?", s.app, s.hash, s.user.id)
      )
      locale = s.user.locale
    }
  } else if (s.kind === "secret") {
    const u = input(b.user)
    if (typeof u.id !== "string") bad("user.id must be a string")
    const v = hostClaims(u.id, u, (reason) => bad(`Invalid user ${reason}`))
    if (b.identity_token !== undefined || b.anonymous !== undefined) bad("Choose one session method")
    if (u.locale !== undefined) {
      if (!isLocale(u.locale)) bad("Invalid locale")
      locale = u.locale
      setLocale = true
    }
    sub = v.sub
    q.push(...resolveHost(env, { ...v, app: s.app }, { id: s.key, kind: "api" }))
  } else if (b.identity_token !== undefined) {
    if (b.user !== undefined || b.anonymous !== undefined) bad("Choose one session method")
    const v = await verifyIdentity(env, s.slug, b.identity_token)
    sub = v.sub
    q.push(
      await consumeIdentity(env, v),
      ...resolveHost(env, v, { id: v.kid, kind: "identity" }),
      sql(env, "UPDATE identity_keys SET last_used_at=? WHERE app_id=? AND id=?", now(), s.app, v.kid)
    )
  } else {
    if (b.user !== undefined) denied()
    if (b.anonymous !== true) bad("Expected identity_token or anonymous: true")
    if (!s.allow_anonymous) fail(403, "anonymous_disabled", "Anonymous sessions are disabled")
    await human(c, s, b.turnstile_token)
    anon = "anon_" + uid()
  }
  if (setLocale) q.push(sql(env, "UPDATE contacts SET locale=? WHERE app_id=? AND external_id=?", locale, s.app, sub))
  if (s.kind === "secret" && sub) q.push(keyAudit(env, s.app, s.key, "api.session.created", "contact", sub, {}, true))
  if (s.kind === "publishable" && ownOrigin(env, s.slug, s.origin, new URL(c.req.url).origin))
    q.push(
      sql(
        env,
        "INSERT OR IGNORE INTO api_workspace_origins SELECT id,? FROM apps WHERE id=? AND slug=?",
        s.origin,
        s.app,
        s.slug
      )
    )
  q.push(
    sql(
      env,
      `INSERT INTO api_sessions(hash,app_id,key_id,origin,contact_id,anon_id,locale,expires,family) VALUES(?,?,?,?,(SELECT id FROM contacts WHERE app_id=? AND ${sub ? "external_id" : "email"}=?),?,?,?,?)`,
      hash,
      s.app,
      s.key,
      s.origin,
      s.app,
      sub ?? address,
      anon,
      locale,
      expires,
      s.user ? s.family : hash
    ),
    sql(
      env,
      `SELECT coalesce(t.id,s.anon_id) id,t.name,t.email,t.external_id,t.verified_via,coalesce(t.locale,s.locale) locale FROM api_sessions s LEFT JOIN contacts t ON s.contact_id=t.id WHERE s.hash=?`,
      hash
    )
  )
  const result = await env.DB.batch<EndUser>(q).catch(identityFailure)
  s.replayContact = result.at(-1)!.results[0]!.id
  if (claimIndex >= 0) {
    const ids = result[claimIndex]!.results.map((r) => r.id),
      who = result.at(-1)!.results[0]!
    await contactRoom(env, s.app, s.user!.id).reviewContact()
    if (ids.length) {
      actorUpdated(env, c.executionCtx, s.app, ids, s.user!.id, contactActor(who))
      c.executionCtx.waitUntil(
        (async () => {
          for (const issue of ids) await signalContact(env, s.app, who.id, { issue })
        })()
      )
    }
  }
  return {
    token: raw,
    expires_at: new Date(expires * 1000).toISOString(),
    user: { ...result.at(-1)!.results[0]!, anonymous: !!anon }
  }
}
export async function refresh(c: Ctx, s: Scope): Promise<Session> {
  if (!s.user || s.user.anonymous) fail(403, "verification_required", "Verify before refreshing this session")
  const raw = "bh_us_" + secret(),
    hash = await sha256(raw),
    [, created] = await c.env.DB.batch<{ expires: number }>([
      liveGuard(c, s),
      sql(
        c.env,
        `INSERT INTO api_sessions(hash,app_id,key_id,origin,contact_id,locale,expires,born,family) SELECT ?,app_id,key_id,origin,contact_id,locale,min(unixepoch()+86400,born+2592000),born,family FROM api_sessions WHERE hash=? AND contact_id IS NOT NULL AND expires>unixepoch() RETURNING expires`,
        hash,
        s.hash
      ),
      sql(c.env, "DELETE FROM api_sessions WHERE hash=?", s.hash)
    ])
  const row = created!.results[0] ?? fail(401, "invalid_credential", "Expired session")
  await contactRoom(c.env, s.app, s.user.id).reviewContact()
  return { token: raw, user: s.user, expires_at: new Date(row.expires * 1000).toISOString() }
}
export async function patchMe(c: Ctx, s: Scope, b: Record<string, unknown>) {
  const user = s.user!,
    name = b.name === undefined ? null : str(b.name, "name", 120).trim(),
    locale = b.locale
  if (locale !== undefined && !isLocale(locale)) bad("Invalid locale")
  if (name && /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)) bad("Invalid name")
  const write = user.anonymous
    ? sql(
        c.env,
        "UPDATE api_sessions SET anon_name=coalesce(?,anon_name),locale=coalesce(?,locale) WHERE hash=?",
        name,
        locale ?? null,
        s.hash
      )
    : sql(
        c.env,
        "UPDATE contacts SET name=coalesce(?,name),locale=coalesce(?,locale) WHERE app_id=? AND id=?",
        name,
        locale ?? null,
        s.app,
        user.id
      )
  await c.env.DB.batch([liveGuard(c, s), write])
  return { ...user, name: name ?? user.name, locale: locale ?? user.locale }
}
