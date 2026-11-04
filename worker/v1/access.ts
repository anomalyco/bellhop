import type { EndUser } from "../../shared/v1"
import type { Locale } from "../../shared/api"
import { denied, fail, missing, sha256, sql, type Ctx } from "../core"
import { enforce } from "../rate-limits"

export type Auth = "public" | "key" | "publishable" | "session"
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
export async function authorize(c: Ctx, auth: Exclude<Auth, "public">): Promise<Scope> {
  const m = /^Bearer (bh_(pk|sk|us)_[0-9a-f]{64})$/i.exec(c.req.header("Authorization") ?? "")
  if (m?.[2]?.toLowerCase() === "sk" && c.req.raw.headers.has("Origin")) denied()
  if (!m || (auth === "session") !== (m[2] === "us")) return rejected()
  const hash = await sha256(m[1]!),
    origin = c.req.header("origin") ?? null,
    env = c.env
  const row =
    auth === "session"
      ? await sql(
          env,
          `SELECT ${workspace},s.origin bound,coalesce(t.id,s.anon_id) actor,coalesce(t.name,s.anon_name) display,t.email,t.external_id,t.verified_via,coalesce(t.locale,s.locale) locale,s.anon_id IS NOT NULL anonymous
    FROM api_sessions s JOIN apps a ON a.id=s.app_id JOIN api_keys k ON k.id=s.key_id LEFT JOIN contacts t ON t.id=s.contact_id AND t.app_id=s.app_id WHERE s.hash=? AND s.expires>unixepoch()`,
          hash
        ).first<
          Workspace & {
            key: string
            kind: Scope["kind"]
            bound: string | null
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
    if (!allowed) denied()
    cors(c, origin)
  }
  if (row.mode !== "helpdesk") fail(403, "helpdesk_only", "Help desk workspace required")
  if ("anonymous" in row && row.anonymous && !row.allow_anonymous)
    fail(403, "anonymous_disabled", "Anonymous sessions are disabled")
  if (auth === "publishable" && row.kind !== "publishable") denied()
  await enforce(c, "RL_AGENT", "v1:key:" + row.key)
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
  if (user) await enforce(c, "RL_IP", "v1:session:" + hash)
  await sql(
    env,
    "UPDATE api_keys SET last_used_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND (last_used_at IS NULL OR last_used_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'))",
    row.key
  ).run()
  return { ...row, hash, origin, user }
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
