import type { EndUser } from "../../shared/v1"
import type { Locale } from "../../shared/api"
import { denied, fail, missing, sha256, sql, type Ctx } from "../core"
import { clientIP, enforce } from "../rate-limits"

export type Auth = "public" | "key" | "publishable" | "session" | "server" | "shared" | "widget" | "email"
type Workspace = {
  app: string
  slug: string
  name: string
  mode: string
  allow_anonymous: number
  require_verified_email: number
}
export type Scope = Workspace & {
  key: string
  kind: "publishable" | "secret"
  origin: string | null
  hash: string
  user: EndUser | null
  family: string
  replayContact?: string
}
const workspace = "a.id app,a.slug,a.name,a.mode,a.allow_anonymous,a.require_verified_email,k.id key,k.kind"
const rejected = () => fail(401, "invalid_credential", "Invalid or expired credential")
export function checkHost(c: Ctx, slug?: string) {
  const domain = c.env.APP_DOMAIN,
    h = new URL(c.req.url).hostname
  if (domain && h !== `api.${domain}` && (slug ? h !== `${slug}.${domain}` : !h.endsWith("." + domain))) missing()
}
export function cors(c: Ctx, origin: string) {
  c.header("Access-Control-Allow-Origin", origin)
  c.header("Access-Control-Expose-Headers", "Challenge-Token, Retry-After")
  c.header("Vary", "Origin")
}
export function apiOrigin(c: Ctx) {
  return c.env.APP_DOMAIN ? `https://api.${c.env.APP_DOMAIN}` : new URL(c.env.PUBLIC_ORIGIN || c.req.url).origin
}
export function ownOrigin(env: Env, slug: string, origin: string | null, requestOrigin: string) {
  if (!origin) return false
  if (env.APP_DOMAIN) return origin === `https://${slug}.${env.APP_DOMAIN}`
  return (
    origin === env.PUBLIC_ORIGIN ||
    (origin === requestOrigin && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname))
  )
}
export async function preflightAllowed(c: Ctx, origin: string, app: string | null = null) {
  const domain = c.env.APP_DOMAIN,
    h = new URL(c.req.url),
    slug = domain && h.hostname !== `api.${domain}` ? h.hostname.slice(0, -domain.length - 1) : null
  return sql(
    c.env,
    `SELECT 1 FROM api_keys k JOIN apps a ON a.id=k.app_id WHERE k.kind='publishable' AND a.mode='helpdesk' AND (?1 IS NULL OR a.slug=?1) AND (?2 IS NULL OR a.id=?2) AND (?3 OR ?4='https://'||a.slug||'.'||?5 OR EXISTS(SELECT 1 FROM api_origins WHERE key_id=k.id AND origin=?4)) LIMIT 1`,
    slug,
    app,
    Number(!domain && ownOrigin(c.env, "", origin, h.origin)),
    origin,
    domain || null
  ).first()
}
export async function authorize(c: Ctx, auth: Exclude<Auth, "public">): Promise<Scope> {
  const m = /^Bearer (bh_(pk|sk|us)_[0-9a-f]{64})$/i.exec(c.req.header("Authorization") ?? "")
  if (m?.[2]?.toLowerCase() === "sk" && c.req.raw.headers.has("Origin")) denied()
  if (!m) return rejected()
  const session = m[2] === "us"
  if ((auth === "server" && m[2] !== "sk") || (auth === "shared" && m[2] === "pk")) denied()
  if ((auth === "widget" || auth === "email") && m[2] === "sk") denied()
  if (!["shared", "server", "widget", "email"].includes(auth) && (auth === "session") !== session) return rejected()
  const hash = await sha256(m[1]!),
    origin = c.req.header("origin") ?? null,
    env = c.env
  const row = session
    ? await sql(
        env,
        `SELECT ${workspace},s.family,s.origin bound,coalesce(t.id,s.anon_id) actor,coalesce(t.name,s.anon_name) display,t.email,t.external_id,t.verified_via,coalesce(t.locale,s.locale) locale,s.anon_id IS NOT NULL anonymous
    FROM api_sessions s JOIN apps a ON a.id=s.app_id JOIN api_keys k ON k.id=s.key_id LEFT JOIN contacts t ON t.id=s.contact_id AND t.app_id=s.app_id WHERE s.hash=? AND s.expires>unixepoch()`,
        hash
      ).first<
        Workspace & {
          key: string
          kind: Scope["kind"]
          bound: string | null
          family: string
          actor: string
          display: string | null
          email: string | null
          external_id: string | null
          verified_via: EndUser["verified_via"]
          locale: Locale
          anonymous: number
        }
      >()
    : await sql(
        env,
        `SELECT ${workspace},NULL actor FROM api_keys k JOIN apps a ON a.id=k.app_id WHERE k.hash=?`,
        hash
      ).first<Workspace & Pick<Scope, "key" | "kind"> & { actor: null }>()
  if (!row) return rejected()
  checkHost(c, row.slug)
  if (row.kind === "publishable" && !origin) denied()
  if (origin !== null) {
    if ("bound" in row && row.bound !== null && row.bound !== origin) denied()
    const allowed = await sql(
      env,
      `SELECT 1 FROM api_origins o JOIN api_keys p ON p.id=o.key_id WHERE p.app_id=? AND o.origin=? AND (?='secret' OR p.id=?)`,
      row.app,
      origin,
      row.kind,
      row.key
    ).first()
    if (!allowed && !ownOrigin(env, row.slug, origin, new URL(c.req.url).origin)) denied()
    cors(c, origin)
  }
  if (row.mode !== "helpdesk") fail(403, "helpdesk_only", "Help desk workspace required")
  if ("anonymous" in row && row.anonymous && !row.allow_anonymous)
    fail(403, "anonymous_disabled", "Anonymous sessions are disabled")
  if (auth === "publishable" && row.kind !== "publishable") denied()
  const user: EndUser | null =
    row.actor !== null
      ? {
          id: row.actor,
          name: row.display,
          email: row.email,
          external_id: row.external_id,
          verified_via: row.verified_via,
          anonymous: !!row.anonymous,
          locale: row.locale
        }
      : null
  if (auth === "email" && user && !user.anonymous) denied()
  const family = "family" in row ? row.family : hash
  if (user) {
    const typing = c.req.path.endsWith("/typing"),
      read = c.req.method === "GET" || c.req.method === "HEAD"
    await enforce(
      c,
      read || typing ? "RL_V1_READ" : "RL_TEAM",
      `v1:${typing ? "typing" : read ? "read" : "write"}:${family}`
    )
  } else if (row.kind === "secret") {
    if (c.req.path === "/v1/sessions") await enforce(c, "RL_TEAM", `v1:mint:${row.key}:${clientIP(c)}`)
    await enforce(c, "RL_V1_SECRET", "v1:secret:" + row.key)
  } else if (auth === "widget") await enforce(c, "RL_V1_READ", `v1:workspace:${row.key}:${clientIP(c)}`)
  else await enforce(c, "RL_TEAM", `v1:mint:${row.key}:${clientIP(c)}`)
  await sql(
    env,
    "UPDATE api_keys SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND (last_used_at IS NULL OR last_used_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))",
    row.key
  ).run()
  return { ...row, hash, origin, user, family }
}
export function liveGuard(c: Ctx, s: Scope, id?: string) {
  return sql(
    c.env,
    `INSERT INTO api_guard SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM api_sessions s JOIN apps a ON a.id=s.app_id WHERE s.hash=? AND s.app_id=? AND a.mode='helpdesk' AND s.expires>unixepoch() AND (s.anon_id IS NULL OR a.allow_anonymous) ${id ? "AND EXISTS(SELECT 1 FROM issues i WHERE i.app_id=a.id AND i.id=? AND i.hidden IS NULL AND json_extract(i.author,'$.id')=coalesce(s.contact_id,s.anon_id))" : ""})`,
    s.hash,
    s.app,
    ...(id ? [id] : [])
  )
}
