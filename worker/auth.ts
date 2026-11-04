import { Hono } from "hono"
import { getCookie, setCookie } from "hono/cookie"
import type { Actor, Config, Me } from "../shared/api"
import { bad, body, denied, email, fail, hex, missing, now, rows, secret, sha256, sql, str, uid } from "./core"
import type { Bindings, Ctx, User } from "./core"

const month = 30 * 86400
/** Shared cookies cover APP_DOMAIN and every app subdomain. Browsers refuse a Domain without a dot. */
function cookie(c: Ctx, name: string, value: string, maxAge: number, shared = false) {
  const host = new URL(c.req.url).hostname
  const local = ["localhost", "127.0.0.1"].includes(host)
  const site = c.env.APP_DOMAIN
  const domain = shared && site?.includes(".") && onSite(site, host) ? site : undefined
  setCookie(c, name, value, { path: "/", maxAge, httpOnly: true, sameSite: "Lax", secure: !local, domain })
}
const onSite = (site: string, host: string) => host === site || host.endsWith(`.${site}`)
export function firstContact(c: Ctx) {
  let id = getCookie(c, "bh_guest")
  // An older host-only cookie can shadow the shared cookie on a previously visited app.
  // Both have Path=/; browsers send the older one first. Don't delete a distinct legacy identity.
  const site = c.env.APP_DOMAIN
  if (id && site?.includes(".") && onSite(site, new URL(c.req.url).hostname)) {
    const ids = [...(c.req.header("Cookie") ?? "").matchAll(/(?:^|;\s*)bh_guest=([0-9a-f]{64})(?=;|$)/g)]
    if (ids.length > 1) id = ids.at(-1)![1]
  }
  if (!id || !/^[0-9a-f]{64}$/.test(id)) {
    id = secret()
    cookie(c, "bh_guest", id, 365 * 86400, true)
  }
  c.set("guestId", id)
}
const scopedGuestId = async (id: string, scope: string) => (await sha256(`${id}:${scope}`)).slice(0, 32)
async function guestName(c: Ctx) {
  const hash = c.var.guestHash ?? await sha256(c.var.guestId)
  c.set("guestHash", hash)
  return sql(c.env, "SELECT name FROM guest_names WHERE guest_hash=?", hash).first<string>("name")
}
export async function guestActor(c: Ctx, scope: string): Promise<Extract<Actor, { type: "guest" }>> {
  const [id, name] = await Promise.all([scopedGuestId(c.var.guestId, scope), guestName(c)])
  return { type: "guest", id, handle: "guest-" + id.slice(0, 4), name }
}
async function saveGuestName(c: Ctx, value: unknown, previous: string | null) {
  if (typeof value !== "string" || /\p{Cc}/u.test(value)) bad("Invalid guest name")
  const name = value.trim()
  if (!name || [...name].length > 40) bad("Guest names must be 1–40 characters")
  if (previous === name) return name

  const statements: D1PreparedStatement[] = []
  // No cross-app identifier is stored on posts. Derive possible scoped IDs for populated apps;
  // update via the actor-ID indexes, in groups rather than one D1 call per app or per post.
  let after = "", populated = 0
  for (;;) {
    const apps = await rows<{ id: string }>(
      sql(c.env, "SELECT id FROM apps WHERE issue_seq>0 AND id>? ORDER BY id LIMIT 128", after)
    )
    if (!apps.length) break
    populated += apps.length
    const ids = JSON.stringify(await Promise.all(apps.map((app) => scopedGuestId(c.var.guestId, app.id))))
    for (const [table, column] of [["issues", "author"], ["comments", "author"], ["issue_events", "actor"]]) {
      statements.push(sql(c.env,
        `UPDATE ${table} SET ${column}=json_set(${column},'$.name',?)
         WHERE json_extract(${column},'$.id') IN (SELECT value FROM json_each(?))
         AND json_extract(${column},'$.type')='guest'`, name, ids))
    }
    if (apps.length < 128) break
    after = apps[apps.length - 1]!.id
  }
  // If an app gained its very first issue during discovery it could contain a guest ID we missed.
  // A NOT NULL conflict aborts the whole rename, exactly like the issue revision guard.
  statements.unshift(sql(c.env,
    `INSERT INTO guest_names(guest_hash,name,updated_at)
     VALUES(?,CASE WHEN (SELECT count(*) FROM apps WHERE issue_seq>0)=? THEN ? END,?)
     ON CONFLICT(guest_hash) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at`,
    c.var.guestHash, populated, name, now()))
  await c.env.DB.batch(statements)

  // Promote a pre-profile, host-only cookie when its owner chooses a shared name.
  const site = c.env.APP_DOMAIN
  if (site?.includes(".") && onSite(site, new URL(c.req.url).hostname)) {
    if (getCookie(c, "bh_guest") === c.var.guestId) cookie(c, "bh_guest", "", 0)
    cookie(c, "bh_guest", c.var.guestId, 365 * 86400, true)
  }
  return name
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
async function requireHuman(c: Ctx) {
  if (!(await human(c))) fail(428, "human_required", "Complete the human check to continue")
}
export async function allowWrite(c: Ctx) {
  if (!c.var.app.role) await requireHuman(c)
}
export async function postBody(c: Ctx) {
  await allowWrite(c)
  const b = await body(c),
    actor = c.var.actor
  if (actor.type === "guest") {
    const name = b.guest_name === undefined ? actor.name : await saveGuestName(c, b.guest_name, actor.name)
    if (!name) fail(400, "name_required", "Choose a display name before posting")
    c.set("actor", { ...actor, name })
  }
  return b
}
function nextPath(c: Ctx, input?: string) {
  const origin = new URL(c.req.url).origin
  // Sign-in runs on APP_DOMAIN, so it may return to an absolute URL on an app subdomain.
  const site = c.env.APP_DOMAIN
  if (site && input && /^https?:\/\//.test(input) && !/[\\\r\n]/.test(input)) {
    const url = new URL(input)
    const scheme = url.protocol === "https:" || !site.includes(".")
    return scheme && onSite(site, url.hostname) ? url.href : "/"
  }
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
  cookie(c, "bh_session", token, month, true)
}
/** Behind a TLS-terminating proxy (the tailnet dev URL) the Worker sees http, so PUBLIC_ORIGIN can pin the origin. */
function callbackUrl(c: Ctx) {
  return new URL("/auth/google/callback", c.env.PUBLIC_ORIGIN || c.req.url).href
}
/** Sessions from before app subdomains were host-only on APP_DOMAIN; re-issue them for the whole site. */
function shareSession(c: Ctx) {
  const token = getCookie(c, "bh_session")
  const site = c.env.APP_DOMAIN
  if (c.var.user && token && site?.includes(".") && new URL(c.req.url).hostname === site)
    cookie(c, "bh_session", token, month, true)
}
export const auth = new Hono<Bindings>()
auth.get("/api/config", (c) =>
  c.json({
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY,
    google_enabled: !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET),
    dev_login: c.env.DEV_LOGIN === "1"
  } satisfies Config)
)
async function me(c: Ctx): Promise<Me> {
  const [{ id, handle, name }, verified] = await Promise.all([guestActor(c, "me"), human(c)])
  return { user: c.var.user, guest: { id, handle, name }, human: verified }
}
auth.get("/api/me", async (c) => {
  shareSession(c)
  return c.json(await me(c))
})
auth.put("/api/me/guest", async (c) => {
  if (c.var.user) bad("Signed-in users cannot set a guest profile here")
  await requireHuman(c)
  const b = await body(c)
  await saveGuestName(c, b.name, await guestName(c))
  return c.json(await me(c))
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
  // The OAuth state cookie and callback live on APP_DOMAIN; an app subdomain hands over with an absolute next URL.
  const here = new URL(c.req.url)
  const site = c.env.APP_DOMAIN
  if (site && here.hostname !== site && onSite(site, here.hostname)) {
    const next = new URL(c.req.query("next") || "/", here.origin)
    const apex = new URL("/auth/google", `${here.protocol}//${site}${here.port ? `:${here.port}` : ""}`)
    apex.searchParams.set("next", next.origin === here.origin ? next.href : here.origin + "/")
    return c.redirect(apex.href)
  }
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
  cookie(c, "bh_session", "", 0, true)
  cookie(c, "bh_session", "", 0)
  return c.json({ ok: true })
})
