import { Hono } from "hono"
import type { ConnectedAgent, OAuthRequest } from "../shared/api"
import { bad, body, denied, fail, missing, rows, secret, sha256, sql, uid } from "./core"
import type { Bindings, Ctx } from "./core"

const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code"
const grants = ["authorization_code", "refresh_token", deviceGrant]
const scope = "mcp",
  accessTTL = 3600,
  refreshTTL = 60 * 86400
const seconds = () => Math.floor(Date.now() / 1000)
const iso = (time: number) => new Date(time * 1000).toISOString()
export const oauthOrigin = (c: Ctx) =>
  new URL(c.env.PUBLIC_ORIGIN || (c.env.APP_DOMAIN ? `https://${c.env.APP_DOMAIN}` : c.req.url)).origin
const resource = (c: Ctx) => `${oauthOrigin(c)}/mcp`

class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 429 = 400
  ) {
    super(message)
  }
}
function invalid(message: string, code = "invalid_request"): never {
  throw new OAuthError(code, message)
}
const invalidGrant = () => invalid("Invalid, expired, or already used grant", "invalid_grant")
function field(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value.length || value.length > max || /\p{Cc}/u.test(value))
    invalid("Invalid or missing parameter")
  return value
}
function uniqueParams(params: URLSearchParams): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, value] of params) {
    if (Object.hasOwn(result, key)) invalid(`Duplicate parameter: ${key}`)
    result[key] = value
  }
  return result
}
async function params(c: Ctx) {
  const mime = c.req.header("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase()
  if (mime === "application/x-www-form-urlencoded") return uniqueParams(new URLSearchParams(await c.req.text()))
  if (mime === "application/json") {
    try {
      return await body(c)
    } catch {
      invalid("Expected a JSON object")
    }
  }
  return invalid("Expected form-encoded or JSON parameters")
}
type Client = { id: string; name: string; redirects: string; grant_types: string }
async function client(c: Ctx, id: unknown) {
  return sql(c.env, "SELECT * FROM oauth_clients WHERE id=?", field(id, 128)).first<Client>()
}
function scopeResource(c: Ctx, b: Record<string, unknown>) {
  if (b.resource !== undefined && b.resource !== resource(c))
    invalid("Resource must be this MCP endpoint", "invalid_target")
  if (b.scope !== undefined && b.scope !== scope) invalid("Unsupported scope", "invalid_scope")
}
function allowedGrant(cl: Client, type: string) {
  if (!(JSON.parse(cl.grant_types) as string[]).includes(type))
    invalid("Grant not registered for this client", "unauthorized_client")
}
function redirectUri(v: unknown) {
  const raw = field(v, 2048),
    u = URL.parse(raw)
  if (
    !u ||
    u.username ||
    u.password ||
    /[\\\s#]/u.test(raw) ||
    !/^[a-z][a-z\d+.\-]*:/i.test(raw) ||
    (u.protocol === "http:" && !["localhost", "127.0.0.1"].includes(u.hostname)) ||
    ["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "filesystem:"].includes(u.protocol)
  )
    invalid("Invalid redirect URI", "invalid_redirect_uri")
  return raw // Keep the registered spelling: OAuth redirect URI checks are exact, not normalized.
}
function redirectTo(uri: string, properties: Record<string, string>) {
  const u = new URL(uri)
  for (const [k, v] of Object.entries(properties)) u.searchParams.set(k, v)
  return u.href
}
function signedIn(c: Ctx) {
  return c.var.user ?? fail(401, "sign_in", "Sign in to continue")
}
async function throttle(c: Ctx, key: string, count: number, interval: number) {
  const t = seconds(),
    until = t - (t % interval) + interval
  const [_, result] = await c.env.DB.batch([
    sql(c.env, "DELETE FROM oauth_limits WHERE until<=?", t),
    sql(
      c.env,
      `INSERT INTO oauth_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET hits=hits+1 WHERE hits<?`,
      await sha256(key),
      until,
      count
    )
  ])
  if (!result?.meta.changes) {
    c.header("Retry-After", String(until - t))
    if (c.req.path.startsWith("/api/")) fail(429, "rate_limited", "Too many attempts")
    throw new OAuthError("slow_down", "Too many requests", 429)
  }
}
const ip = (c: Ctx) => c.req.header("CF-Connecting-IP") ?? "local"
export const oauth = new Hono<Bindings>()
oauth.onError((e, c) => {
  if (e instanceof OAuthError) return c.json({ error: e.code, error_description: e.message }, e.status)
  throw e
})
// The pages themselves belong to the SPA. Protect the actual HTML document (not just the JSON
// endpoints) against framing consent buttons and leaking a device/user code via Referer.
oauth.on("GET", ["/oauth/consent", "/oauth/consent/", "/device", "/device/"], async (c) => {
  const asset = await c.env.ASSETS.fetch(c.req.raw)
  const res = new Response(asset.body, asset)
  res.headers.append("Content-Security-Policy", "frame-ancestors 'none'")
  res.headers.set("X-Frame-Options", "DENY")
  res.headers.set("Referrer-Policy", "no-referrer")
  res.headers.set("Cache-Control", "no-store")
  return res
})
oauth.on("GET", ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (c) =>
  c.json({
    resource: resource(c),
    authorization_servers: [oauthOrigin(c)],
    bearer_methods_supported: ["header"],
    scopes_supported: [scope]
  })
)
oauth.get("/.well-known/oauth-authorization-server", (c) => {
  const o = oauthOrigin(c)
  return c.json({
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    device_authorization_endpoint: `${o}/oauth/device`,
    grant_types_supported: grants,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [scope]
  })
})
oauth.post("/oauth/register", async (c) => {
  await throttle(c, `register:${ip(c)}`, 30, 3600)
  const b = await params(c),
    name = field(b.client_name, 100).trim()
  if (!name || (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== "none"))
    invalid("Expected a named public client", "invalid_client_metadata")
  const types = b.grant_types ?? grants
  if (
    !Array.isArray(types) ||
    !types.length ||
    types.length > 3 ||
    types.some((t) => !grants.includes(t)) ||
    !types.some((t) => t === "authorization_code" || t === deviceGrant)
  )
    invalid("Unsupported grant types", "invalid_client_metadata")
  const usesCode = types.includes("authorization_code"),
    responses = b.response_types ?? (usesCode ? ["code"] : [])
  if (!Array.isArray(responses) || responses.length !== Number(usesCode) || responses.some((x) => x !== "code"))
    invalid("Unsupported response types", "invalid_client_metadata")
  const uris = b.redirect_uris ?? []
  if (!Array.isArray(uris) || uris.length > 16 || (types.includes("authorization_code") && !uris.length))
    invalid("Invalid redirect URIs", "invalid_redirect_uri")
  const redirects = [...new Set(uris.map(redirectUri))],
    id = uid(),
    t = seconds()
  await sql(
    c.env,
    "INSERT INTO oauth_clients VALUES(?,?,?,?,?)",
    id,
    name,
    JSON.stringify(redirects),
    JSON.stringify(types),
    t
  ).run()
  return c.json(
    {
      client_id: id,
      client_id_issued_at: t,
      client_name: name,
      redirect_uris: redirects,
      grant_types: types,
      response_types: responses,
      token_endpoint_auth_method: "none"
    },
    201
  )
})
oauth.get("/oauth/authorize", async (c) => {
  if (c.env.APP_DOMAIN && new URL(c.req.url).hostname !== c.env.APP_DOMAIN)
    return c.redirect(`${oauthOrigin(c)}/oauth/authorize${new URL(c.req.url).search}`)
  const q = new URL(c.req.url).searchParams
  if (q.getAll("client_id").length !== 1 || q.getAll("redirect_uri").length !== 1)
    return c.text("Invalid client or redirect URI", 400)
  const cl = await sql(c.env, "SELECT * FROM oauth_clients WHERE id=?", q.get("client_id")).first<Client>(),
    uri = q.get("redirect_uri")!
  if (!cl || !(JSON.parse(cl.redirects) as string[]).includes(uri)) return c.text("Invalid client or redirect URI", 400)
  let state: string | undefined
  try {
    const b = uniqueParams(q)
    state = field(b.state, 1024)
    if (b.response_type !== "code") invalid("Expected response_type=code", "unsupported_response_type")
    allowedGrant(cl, "authorization_code")
    scopeResource(c, b)
    if (
      b.code_challenge_method !== "S256" ||
      typeof b.code_challenge !== "string" ||
      !/^[\w-]{43}$/.test(b.code_challenge)
    )
      invalid("S256 PKCE required")
    await throttle(c, `authorize:${ip(c)}`, 90, 600)
    const id = uid(),
      next = `/oauth/consent?request=${id}`
    await sql(
      c.env,
      `INSERT INTO oauth_requests(id,client_id,kind,expires_at,browser_hash,redirect_uri,state,challenge)
      VALUES(?,?,'authorization_code',?,?,?,?,?)`,
      id,
      cl.id,
      seconds() + 600,
      await sha256(c.var.guestId),
      uri,
      state,
      b.code_challenge
    ).run()
    return c.redirect(c.var.user ? next : `/auth/google?next=${encodeURIComponent(next)}`)
  } catch (e) {
    if (!(e instanceof OAuthError)) throw e
    return c.redirect(redirectTo(uri, { error: e.code, ...(state && { state }) }))
  }
})
oauth.post("/oauth/device", async (c) => {
  await throttle(c, `device-ip:${ip(c)}`, 20, 600)
  const b = await params(c),
    cl = await client(c, b.client_id)
  if (!cl) invalid("Unknown client", "invalid_client")
  allowedGrant(cl, deviceGrant)
  scopeResource(c, b)
  await throttle(c, `device-client:${cl.id}`, 120, 600)
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ",
    device = secret(),
    user = Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => alphabet[n % 32]).join(""),
    shown = `${user.slice(0, 4)}-${user.slice(4)}`,
    uri = `${oauthOrigin(c)}/device`
  await sql(
    c.env,
    `INSERT INTO oauth_requests(id,client_id,kind,expires_at,device_hash,user_code_hash) VALUES(?,?,'device',?,?,?)`,
    uid(),
    cl.id,
    seconds() + 600,
    await sha256(device),
    await sha256(user)
  ).run()
  return c.json({
    device_code: device,
    user_code: shown,
    verification_uri: uri,
    verification_uri_complete: `${uri}?code=${shown}`,
    expires_in: 600,
    interval: 5
  })
})

type Pending = {
  id: string
  client_id: string
  client_name: string
  kind: OAuthRequest["kind"]
  redirect_uri: string | null
  state: string | null
  challenge: string | null
  browser_hash: string | null
  expires_at: number
}
async function pending(c: Ctx) {
  signedIn(c)
  const r = await sql(
    c.env,
    `SELECT r.*,cl.name client_name FROM oauth_requests r JOIN oauth_clients cl ON cl.id=r.client_id
    WHERE r.id=? AND r.status='pending' AND r.expires_at>unixepoch()`,
    c.req.param("id")
  ).first<Pending>()
  if (!r || (r.browser_hash && r.browser_hash !== (await sha256(c.var.guestId)))) missing()
  return r
}
oauth.post("/api/oauth/device/lookup", async (c) => {
  const user = signedIn(c)
  await throttle(c, `lookup-user:${user.id}`, 12, 300)
  await throttle(c, `lookup-ip:${ip(c)}`, 30, 300)
  const { user_code } = await body(c)
  if (typeof user_code !== "string" || !/^[2-9A-HJ-NP-Z]{4}-?[2-9A-HJ-NP-Z]{4}$/i.test(user_code))
    bad("Invalid device code")
  const id = await sql(
    c.env,
    `SELECT id FROM oauth_requests WHERE user_code_hash=? AND expires_at>unixepoch() AND status='pending'`,
    await sha256(user_code.toUpperCase().replace("-", ""))
  ).first<string>("id")
  if (!id) missing()
  return c.json({ request_id: id })
})
oauth.get("/api/oauth/requests/:id", async (c) => {
  const r = await pending(c),
    apps = await rows<OAuthRequest["apps"][number]>(
      sql(
        c.env,
        `SELECT a.id,a.slug,a.name,'/icon/'||a.slug||'/'||a.icon_version icon_url,m.role FROM apps a JOIN members m
     ON m.app_id=a.id WHERE m.user_id=? ORDER BY a.name`,
        c.var.user!.id
      )
    )
  const u = r.redirect_uri ? new URL(r.redirect_uri) : null
  return c.json({
    id: r.id,
    kind: r.kind,
    client_name: r.client_name,
    redirect_host: u ? u.host || u.protocol : null,
    apps,
    expires_at: iso(r.expires_at)
  } satisfies OAuthRequest)
})
oauth.post("/api/oauth/requests/:id/approve", async (c) => {
  const r = await pending(c),
    user = c.var.user!.id,
    { app_ids } = await body(c)
  if (
    !Array.isArray(app_ids) ||
    !app_ids.length ||
    app_ids.length > 100 ||
    app_ids.some((x) => typeof x !== "string" || x.length > 64)
  )
    bad("Choose 1–100 workspaces")
  const ids = [...new Set(app_ids)],
    selected = JSON.stringify(ids),
    grant = uid(),
    code = secret(),
    t = seconds()
  // Every downstream insert is gated by this attempt's fresh grant ID. Concurrent consent or
  // membership removal cannot authorize a second grant or an app outside the user's team.
  const statements = [
    sql(
      c.env,
      `UPDATE oauth_requests SET status='approved',grant_id=? WHERE id=? AND status='pending'
    AND expires_at>unixepoch() AND (SELECT count(*) FROM members WHERE user_id=? AND app_id IN (SELECT value FROM json_each(?)))=?`,
      grant,
      r.id,
      user,
      selected,
      ids.length
    ),
    sql(
      c.env,
      `INSERT INTO oauth_grants(id,user_id,client_id,created_at) SELECT grant_id,?,client_id,? FROM oauth_requests WHERE id=? AND grant_id=?`,
      user,
      t,
      r.id,
      grant
    ),
    sql(
      c.env,
      `INSERT INTO oauth_grant_apps SELECT g.id,j.value FROM oauth_grants g,json_each(?) j WHERE g.id=?`,
      selected,
      grant
    )
  ]
  if (r.kind === "authorization_code")
    statements.push(
      sql(
        c.env,
        `INSERT INTO oauth_codes(hash,grant_id,redirect_uri,challenge,expires_at)
    SELECT ?,grant_id,redirect_uri,challenge,? FROM oauth_requests WHERE id=? AND grant_id=?`,
        await sha256(code),
        t + 60,
        r.id,
        grant
      )
    )
  const [changed] = await c.env.DB.batch(statements)
  if (!changed?.meta.changes) {
    await pending(c) // Already answered/expired is distinct from selecting somebody else's app.
    denied()
  }
  return c.json({ redirect_to: r.redirect_uri ? redirectTo(r.redirect_uri, { code, state: r.state! }) : null })
})
oauth.post("/api/oauth/requests/:id/deny", async (c) => {
  const r = await pending(c)
  const change = await sql(
    c.env,
    "UPDATE oauth_requests SET status='denied' WHERE id=? AND status='pending' AND expires_at>unixepoch()",
    r.id
  ).run()
  if (!change.meta.changes) missing()
  return c.json({
    redirect_to: r.redirect_uri ? redirectTo(r.redirect_uri, { error: "access_denied", state: r.state! }) : null
  })
})

// An exchange stamps its single-use input with the new access token's *hash*. The two inserts
// below can only see the winning exchange, in the same D1 transaction. No raw tokens persist.
async function exchange(c: Ctx, cl: Client, b: Record<string, unknown>, type: string) {
  const access = `bh_a_${secret()}`,
    refresh = `bh_r_${secret()}`,
    marker = await sha256(access),
    refreshHash = await sha256(refresh),
    t = seconds(),
    ms = Date.now()
  const active = "SELECT id FROM oauth_grants WHERE client_id=? AND revoked_at IS NULL"
  let source: string,
    hash: string,
    column = "hash"
  const q: D1PreparedStatement[] = []
  if (type === "authorization_code") {
    const verifier = field(b.code_verifier, 128)
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return invalidGrant()
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))
    const challenge = btoa(String.fromCharCode(...digest))
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
    source = "oauth_codes"
    hash = await sha256(field(b.code))
    q.push(
      sql(
        c.env,
        `UPDATE oauth_codes SET spent_by=? WHERE hash=? AND challenge=? AND redirect_uri=? AND spent_by IS NULL
      AND expires_at>unixepoch() AND grant_id IN (${active})`,
        marker,
        hash,
        challenge,
        field(b.redirect_uri, 2048),
        cl.id
      )
    )
  } else if (type === "refresh_token") {
    source = "oauth_tokens"
    hash = await sha256(field(b.refresh_token))
    q.push(
      sql(
        c.env,
        `UPDATE oauth_grants SET revoked_at=? WHERE revoked_at IS NULL AND client_id=? AND id IN
      (SELECT grant_id FROM oauth_tokens WHERE hash=? AND kind='refresh' AND spent_by IS NOT NULL)`,
        t,
        cl.id,
        hash
      ),
      sql(
        c.env,
        `UPDATE oauth_tokens SET spent_by=? WHERE hash=? AND kind='refresh' AND spent_by IS NULL AND expires_at>unixepoch()
        AND grant_id IN (${active})`,
        marker,
        hash,
        cl.id
      )
    )
  } else {
    source = "oauth_requests"
    column = "device_hash"
    hash = await sha256(field(b.device_code))
    q.push(
      sql(
        c.env,
        "SELECT status,expires_at,next_poll FROM oauth_requests WHERE device_hash=? AND client_id=?",
        hash,
        cl.id
      ),
      sql(
        c.env,
        `UPDATE oauth_requests SET status='consumed',spent_by=? WHERE device_hash=? AND status='approved' AND next_poll<=?
         AND expires_at>unixepoch() AND grant_id IN (${active})`,
        marker,
        hash,
        ms,
        cl.id
      ),
      sql(
        c.env,
        `UPDATE oauth_requests SET poll_interval=poll_interval+CASE WHEN next_poll>?1 THEN 5 ELSE 0 END,
        next_poll=?1+1000*(poll_interval+CASE WHEN next_poll>?1 THEN 5 ELSE 0 END)
        WHERE device_hash=?2 AND client_id=?3 AND expires_at>unixepoch() AND status IN ('pending','approved')`,
        ms,
        hash,
        cl.id
      )
    )
  }
  for (const [key, kind, ttl] of [
    [marker, "access", accessTTL],
    [refreshHash, "refresh", refreshTTL]
  ] as const) {
    q.push(
      sql(
        c.env,
        `INSERT INTO oauth_tokens(hash,grant_id,kind,expires_at) SELECT ?,grant_id,?,? FROM ${source}
      WHERE ${column}=? AND spent_by=?`,
        key,
        kind,
        t + ttl,
        hash,
        marker
      )
    )
  }
  const result = await c.env.DB.batch<{ status: string; expires_at: number; next_poll: number }>(q)
  if (!result.at(-1)?.meta.changes) {
    if (type === deviceGrant) {
      const r = result[0]?.results[0]
      if (r && r.status !== "consumed") {
        if (r.expires_at <= seconds()) invalid("Device request expired", "expired_token")
        if (r.status === "denied") invalid("User denied access", "access_denied")
        if (r.next_poll > ms) invalid("Increase polling interval by 5 seconds", "slow_down")
        if (r.status === "pending") invalid("Waiting for user authorization", "authorization_pending")
      }
    }
    return invalidGrant()
  }
  return c.json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: accessTTL, scope })
}
oauth.post("/oauth/token", async (c) => {
  const b = await params(c),
    cl = await client(c, b.client_id),
    type = field(b.grant_type, 128)
  if (!cl) invalid("Unknown client", "invalid_client")
  if (!grants.includes(type)) invalid("Unsupported grant type", "unsupported_grant_type")
  allowedGrant(cl, type)
  scopeResource(c, b)
  return exchange(c, cl, b, type)
})
oauth.post("/oauth/revoke", async (c) => {
  const b = await params(c),
    cl = await client(c, b.client_id)
  if (!cl) invalid("Unknown client", "invalid_client")
  await sql(
    c.env,
    `UPDATE oauth_grants SET revoked_at=unixepoch() WHERE client_id=? AND revoked_at IS NULL AND id IN
    (SELECT grant_id FROM oauth_tokens WHERE hash=?)`,
    cl.id,
    await sha256(field(b.token))
  ).run()
  return c.body(null, 200)
})
oauth.get("/api/me/agents", async (c) => {
  const user = signedIn(c),
    items = await rows<{
      id: string
      client_name: string
      created_at: number
      last_used_at: number | null
      apps: string
    }>(
      sql(
        c.env,
        `SELECT g.id,cl.name client_name,g.created_at,g.last_used_at,(SELECT json_group_array(json_object('slug',a.slug,'name',a.name))
     FROM oauth_grant_apps ga JOIN apps a ON a.id=ga.app_id JOIN members m ON m.app_id=a.id AND m.user_id=g.user_id WHERE ga.grant_id=g.id) apps
     FROM oauth_grants g JOIN oauth_clients cl ON cl.id=g.client_id WHERE g.user_id=? AND g.revoked_at IS NULL ORDER BY g.created_at DESC`,
        user.id
      )
    )
  return c.json(
    items.map((r) => ({
      ...r,
      created_at: iso(r.created_at),
      last_used_at: r.last_used_at === null ? null : iso(r.last_used_at),
      apps: JSON.parse(r.apps)
    })) satisfies ConnectedAgent[]
  )
})
oauth.delete("/api/me/agents/:id", async (c) => {
  const user = signedIn(c),
    r = await sql(
      c.env,
      "UPDATE oauth_grants SET revoked_at=unixepoch() WHERE id=? AND user_id=? AND revoked_at IS NULL",
      c.req.param("id"),
      user.id
    ).run()
  if (!r.meta.changes) missing()
  return c.json({ ok: true })
})
