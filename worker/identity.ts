import { Hono } from "hono"
import type { Me } from "../shared/api"
import { firstContact, me } from "./auth"
import { contactCookie, contactHash, contactHost, contactTTL, hostWorkspace } from "./contact-session"
import { ApiFailure, denied, email, fail, now, secret, sha256, sql, uid, type Bindings, type Ctx } from "./core"
import { claimContactGuest } from "./guest-history"
import { verifier } from "./identity-keys"
import { clientIP, enforce } from "./rate-limits"

const enc = new TextEncoder(),
  utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
function invalid(reason: string): never {
  // Reasons are fixed tags, never a claim, URL, signature or parser exception.
  console.warn("bellhop.invalid_identity", { reason })
  return fail(401, "invalid_identity", "Invalid identity")
}
function bytes(s: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return invalid("encoding")
  const base = s.replace(/-/g, "+").replace(/_/g, "/")
  let raw: string
  try {
    raw = atob(base)
  } catch {
    return invalid("encoding")
  }
  if (btoa(raw).replace(/=+$/, "") !== base) return invalid("encoding")
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}
function json(part: string): Record<string, unknown> {
  const raw = bytes(part)
  let x: unknown
  try {
    x = JSON.parse(utf8.decode(raw))
  } catch {
    return invalid("json")
  }
  if (!x || typeof x !== "object" || Array.isArray(x)) return invalid("object")
  return x as Record<string, unknown>
}
function text(x: unknown, max: number): x is string {
  return typeof x === "string" && x.length <= max && !!x.trim() && !/[\p{Cc}\p{Cs}]/u.test(x)
}
async function verify(c: Ctx, slug: string | null, token: unknown) {
  if (!slug || !contactHost(c, slug)) return invalid("workspace")
  if (typeof token !== "string" || token.length > 8192) return invalid("format")
  const parts = token.split(".")
  if (parts.length !== 3) return invalid("format")
  const [head, payload, signature] = parts as [string, string, string],
    h = json(head)
  if (h.alg !== "HS256" || h.crit !== undefined || h.b64 !== undefined) return invalid("algorithm")
  if (!text(h.kid, 80)) return invalid("key")
  const sig = bytes(signature)
  if (sig.byteLength !== 32) return invalid("signature")
  const key = await sql(
    c.env,
    `SELECT k.app_id,k.cipher FROM identity_keys k JOIN apps a ON a.id=k.app_id WHERE a.slug=? AND a.mode='helpdesk' AND k.id=?`,
    slug,
    h.kid
  ).first<{ app_id: string; cipher: string }>()
  if (!key) return invalid("key")
  const mac = await verifier(c.env, key.app_id, h.kid, key.cipher)
  if (!(await crypto.subtle.verify("HMAC", mac, sig, enc.encode(head + "." + payload)))) return invalid("signature")
  const p = json(payload),
    { iat, exp, sub, jti } = p,
    t = Math.floor(Date.now() / 1000)
  if (p.aud !== slug) return invalid("audience")
  if (
    typeof iat !== "number" ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(iat) ||
    !Number.isSafeInteger(exp) ||
    exp <= t ||
    iat > t + 60 ||
    exp <= iat ||
    exp - iat > 600
  )
    return invalid("time")
  if (!text(sub, 255) || !text(jti, 255)) return invalid("identifier")
  if (p.name !== undefined && !text(p.name, 120)) return invalid("name")
  if (p.email_verified !== undefined && typeof p.email_verified !== "boolean") return invalid("verified_flag")
  let address: string | null = null
  if (p.email !== undefined) {
    if (!text(p.email, 254)) return invalid("email")
    try {
      address = email(p.email)
    } catch {
      return invalid("email")
    }
  }
  if (p.email_verified && !address) return invalid("email")
  return {
    app: key.app_id,
    slug,
    kid: h.kid,
    sub,
    jti,
    exp,
    name: p.name?.trim() ?? null,
    email: p.email_verified ? address : null,
    display: p.email_verified ? null : address
  }
}

async function identify(c: Ctx, slug: string | null, token: unknown) {
  const v = await verify(c, slug, token),
    raw = secret(),
    at = now(),
    env = c.env
  // Every write below is in one D1 transaction. A concurrent revoke/expiry
  // gives the first INSERT a NULL app_id; a replay hits its unique constraint.
  const batch = [
    sql(
      env,
      `INSERT INTO identity_uses(app_id,jti,expires) VALUES((SELECT k.app_id FROM identity_keys k JOIN apps a ON a.id=k.app_id WHERE k.app_id=? AND k.id=? AND a.slug=? AND a.mode='helpdesk' AND unixepoch()<?),?,?)`,
      v.app,
      v.kid,
      v.slug,
      v.exp,
      await sha256(v.jti),
      v.exp
    ),
    sql(
      env,
      `WITH target AS (SELECT id FROM contacts WHERE app_id=?1 AND (external_id=?2 OR (external_id IS NULL AND email=?3)) ORDER BY external_id IS NOT NULL DESC LIMIT 1),
      chosen AS (SELECT coalesce((SELECT id FROM target),?4) id)
      INSERT INTO contacts(id,app_id,external_id,email,unverified_email,name,verified_via,created_at,last_seen_at)
      SELECT id,?1,?2,CASE WHEN NOT EXISTS(SELECT 1 FROM contacts t WHERE t.app_id=?1 AND t.email=?3 AND t.id!=chosen.id) THEN ?3 END,?5,?6,'host',?7,?7 FROM chosen WHERE true
      ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id,email=excluded.email,unverified_email=excluded.unverified_email,name=coalesce(excluded.name,contacts.name),verified_via='host',last_seen_at=excluded.last_seen_at
      RETURNING id,name,email,external_id,verified_via`,
      v.app,
      v.sub,
      v.email,
      "ct_" + uid(),
      v.display,
      v.name,
      at
    ),
    sql(env, "DELETE FROM contact_sessions WHERE app_id=? AND hash=?", v.app, await contactHash(c, v.slug)),
    sql(
      env,
      "INSERT INTO contact_sessions(hash,app_id,contact_id,expires) SELECT ?,app_id,id,unixepoch()+CAST(? AS INTEGER) FROM contacts WHERE app_id=? AND external_id=?",
      await sha256(raw),
      contactTTL,
      v.app,
      v.sub
    ),
    sql(env, "UPDATE identity_keys SET last_used_at=? WHERE app_id=? AND id=?", at, v.app, v.kid)
  ]
  let result: D1Result<NonNullable<Me["contact"]>>[]
  try {
    result = await env.DB.batch(batch)
  } catch (e) {
    const msg = e instanceof Error ? `${e.message} ${e.cause}` : ""
    if (msg.includes("UNIQUE constraint failed: identity_uses.")) return invalid("replay")
    if (msg.includes("NOT NULL constraint failed: identity_uses.app_id")) return invalid("key_or_expiry")
    throw e
  }
  const contact = result[1]!.results[0]!
  // A forwarded GET link authenticates its subject, not the browser that opened
  // it. Only the origin-checked POST may transfer the browser's private history.
  if (c.req.method === "POST") await claimContactGuest(c, contact, v.app)
  contactCookie(c, v.slug, raw)
  c.set("contact", contact)
}

function destination(next: string | undefined, origin: string) {
  if (!next || next.length > 2048) return "/"
  let path = next
  // Check decoded layers as well as the actual Location. Reject ambiguous or
  // deeply nested escapes rather than relying on the next handler's decoder.
  for (let i = 0; i < 5; i++) {
    if (!path.startsWith("/") || path.startsWith("//") || /[\\\p{Cc}]/u.test(path)) return "/"
    const url = URL.parse(path, origin)
    if (!url || url.origin !== origin || url.pathname.startsWith("//")) return "/"
    if (!/%[\da-f]{2}/i.test(path)) return next
    try {
      path = decodeURIComponent(path)
    } catch {
      return "/"
    }
  }
  return "/"
}
export const handoff = new Hono<Bindings>()
handoff.post("/api/apps/:slug/identify", async (c) => {
  if (c.req.header("Origin") !== new URL(c.req.url).origin) denied()
  await enforce(c, "RL_IP", "identify:" + clientIP(c))
  let b: unknown
  try {
    b = await c.req.json()
  } catch {
    return invalid("body")
  }
  await identify(c, c.req.param("slug"), b && typeof b === "object" && "token" in b ? b.token : null)
  return c.json(await me(c))
})
handoff.get("/identify", async (c) => {
  c.header("Referrer-Policy", "no-referrer")
  c.header("Cache-Control", "no-store")
  await enforce(c, "RL_IP", "identify:" + clientIP(c))
  firstContact(c)
  try {
    await identify(c, c.env.APP_DOMAIN ? hostWorkspace(c) : (c.req.query("app") ?? null), c.req.query("token"))
  } catch (e) {
    if (!(e instanceof ApiFailure) || e.code !== "invalid_identity") throw e
    return c.html(
      "<!doctype html><meta charset=utf-8><title>Sign-in link unavailable</title><p>This sign-in link is no longer valid. Return to the app for a new link.</p>",
      401
    )
  }
  return c.redirect(destination(c.req.query("next"), new URL(c.req.url).origin), 302)
})
