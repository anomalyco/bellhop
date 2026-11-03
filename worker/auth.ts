import { Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import type { Actor, Config, Me } from "../shared/api"
import { bad, body, denied, email, fail, hex, missing, now, secret, sha256, sql, str, uid } from "./core"
import type { Bindings, Ctx, User } from "./core"

const month = 30 * 86400
function cookie(c: Ctx, name: string, value: string, maxAge: number) {
  const local = ["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname)
  setCookie(c, name, value, { path: "/", maxAge, httpOnly: true, sameSite: "Lax", secure: !local })
}
export function firstContact(c: Ctx) {
  let id = getCookie(c, "bh_guest")
  if (!id || !/^[0-9a-f]{64}$/.test(id)) {
    id = secret()
    cookie(c, "bh_guest", id, 365 * 86400)
  }
  c.set("guestId", id)
}
export async function guestActor(id: string, scope: string): Promise<Extract<Actor, { type: "guest" }>> {
  const hash = (await sha256(`${id}:${scope}`)).slice(0, 32)
  return { type: "guest", id: hash, handle: "guest-" + hash.slice(0, 4) }
}
export async function currentUser(c: Ctx) {
  const token = getCookie(c, "bh_session")
  c.set(
    "user",
    token && /^[a-f0-9]{64}$/.test(token)
      ? await sql(
          c.env,
          `SELECT u.id,u.email,u.name,u.avatar_url FROM sessions s JOIN users u ON s.user_id=u.id
    WHERE s.token_hash=? AND s.expires_at>?`,
          await sha256(token),
          now()
        ).first<User>()
      : null
  )
}
async function signingKey(c: Ctx) {
  if (!c.env.COOKIE_SECRET || c.env.COOKIE_SECRET.length < 32) fail(503, "misconfigured", "Cookie signing unavailable")
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(c.env.COOKIE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
}
const proofData = (guest: string, exp: string) => new TextEncoder().encode(`human:${guest}:${exp}`)
export async function human(c: Ctx): Promise<boolean> {
  const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(getCookie(c, "bh_human") ?? "")
  if (!match || Number(match[1]) <= Date.now()) return false
  const sig = Uint8Array.from(match[2]!.match(/../g)!, (h) => parseInt(h, 16))
  return crypto.subtle.verify("HMAC", await signingKey(c), sig, proofData(c.var.guestId, match[1]!))
}
export async function allowWrite(c: Ctx) {
  if (!c.var.app.role && !(await human(c))) fail(428, "human_required", "Complete the human check to continue")
}
function nextPath(c: Ctx, input?: string) {
  const origin = new URL(c.req.url).origin
  if (!input?.startsWith("/") || /[\\\r\n]/.test(input)) return "/"
  const url = new URL(input, origin)
  return url.origin === origin && !url.pathname.startsWith("//") ? url.pathname + url.search + url.hash : "/"
}
async function signIn(c: Ctx, address: string, name: string, picture: string | null, sub: string | null) {
  const token = secret(),
    hash = await sha256(token)
  await c.env.DB.batch([
    sql(
      c.env,
      `INSERT INTO users(id,email,name,avatar_url,google_sub) VALUES(?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET
      name=excluded.name,avatar_url=excluded.avatar_url,google_sub=coalesce(excluded.google_sub,users.google_sub)
      WHERE users.google_sub IS NULL OR excluded.google_sub IS NULL OR users.google_sub=excluded.google_sub`,
      uid(),
      address,
      name,
      picture,
      sub
    ),
    sql(
      c.env,
      `UPDATE members SET user_id=(SELECT id FROM users WHERE email=?) WHERE email=? AND user_id IS NULL`,
      address,
      address
    ),
    sql(
      c.env,
      `INSERT INTO sessions SELECT ?,id,? FROM users WHERE email=? AND (? IS NULL OR google_sub=?)`,
      hash,
      new Date(Date.now() + month * 1000).toISOString(),
      address,
      sub,
      sub
    )
  ]).then((result) => {
    if (!result[2]?.meta.changes) denied()
  })
  cookie(c, "bh_session", token, month)
}
/** Behind a TLS-terminating proxy (the tailnet dev URL) the Worker sees http, so PUBLIC_ORIGIN can pin the origin. */
function callbackUrl(c: Ctx) {
  return new URL("/auth/google/callback", c.env.PUBLIC_ORIGIN || c.req.url).href
}
export const auth = new Hono<Bindings>()
auth.get("/api/config", (c) =>
  c.json({
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY,
    google_enabled: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    dev_login: c.env.DEV_LOGIN === "1"
  } satisfies Config)
)
auth.get("/api/me", async (c) => {
  const { id, handle } = await guestActor(c.var.guestId, "me")
  return c.json({ user: c.var.user, guest: { id, handle }, human: await human(c) } satisfies Me)
})
auth.post("/api/human", async (c) => {
  const token = str((await body(c)).token, "token", 2048)
  if (!c.env.TURNSTILE_SECRET_KEY) fail(503, "misconfigured", "Human verification unavailable")
  const params = new URLSearchParams({ secret: c.env.TURNSTILE_SECRET_KEY, response: token })
  const ip = c.req.header("CF-Connecting-IP")
  if (ip) params.set("remoteip", ip)
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: params,
    signal: AbortSignal.timeout(10000)
  })
  if (!response.ok) fail(502, "siteverify_failed", "Human verification unavailable")
  const result = await response.json<{ success: boolean; hostname?: string }>()
  const devTest = c.env.DEV_LOGIN === "1" && c.env.TURNSTILE_SITE_KEY === "1x00000000000000000000AA"
  if (!result.success || (!devTest && result.hostname !== new URL(c.req.url).hostname)) denied()
  const exp = String(Date.now() + 3600000)
  const sig = await crypto.subtle.sign("HMAC", await signingKey(c), proofData(c.var.guestId, exp))
  cookie(c, "bh_human", `${exp}.${hex(sig)}`, 3600)
  return c.json({ ok: true })
})
auth.get("/auth/dev", async (c) => {
  if (c.env.DEV_LOGIN !== "1") missing()
  const e = email(c.req.query("email"))
  await signIn(c, e, e.split("@")[0]!, null, null)
  return c.redirect(nextPath(c, c.req.query("next")))
})
auth.get("/auth/google", (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) fail(503, "misconfigured", "Google sign-in unavailable")
  const state = secret()
  cookie(c, "bh_state", state, 600)
  cookie(c, "bh_next", nextPath(c, c.req.query("next")), 600)
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth")
  url.search = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: callbackUrl(c),
    response_type: "code",
    scope: "openid email profile",
    state
  }).toString()
  return c.redirect(url.href)
})
auth.get("/auth/google/callback", async (c) => {
  const state = getCookie(c, "bh_state"),
    next = nextPath(c, getCookie(c, "bh_next"))
  cookie(c, "bh_state", "", 0)
  cookie(c, "bh_next", "", 0)
  if (!state || c.req.query("state") !== state) bad("Invalid OAuth state")
  const code = str(c.req.query("code"), "authorization code", 4096)
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: c.env.GOOGLE_CLIENT_ID,
      client_secret: c.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callbackUrl(c)
    }),
    signal: AbortSignal.timeout(10000)
  })
  if (!r.ok) denied()
  const { access_token } = await r.json<{ access_token: string }>()
  const profile = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${access_token}` },
    signal: AbortSignal.timeout(10000)
  })
  if (!profile.ok) denied()
  const p = await profile.json<{
    sub: string
    email: string
    email_verified: boolean
    name?: string
    picture?: string
  }>()
  if (p.email_verified !== true || !p.sub) denied()
  await signIn(c, email(p.email), p.name || p.email, p.picture ?? null, p.sub)
  return c.redirect(next)
})
auth.post("/auth/logout", async (c) => {
  const token = getCookie(c, "bh_session")
  if (token) await sql(c.env, "DELETE FROM sessions WHERE token_hash=?", await sha256(token)).run()
  cookie(c, "bh_session", "", 0)
  return c.json({ ok: true })
})
