import { getCookie, setCookie } from "hono/cookie"
import type { Actor, Me } from "../shared/api"
import { missing, sha256, sql, type Ctx } from "./core"

export const contactTTL = 30 * 86400
export function hostWorkspace(c: Ctx) {
  const u = new URL(c.req.url),
    domain = c.env.APP_DOMAIN
  if (domain) return u.hostname.endsWith("." + domain) ? u.hostname.slice(0, -domain.length - 1) : null
  const api = /^\/api\/(?:live\/)?apps\/([a-z0-9-]+)(?:\/|$)/.exec(u.pathname)
  if (api) return api[1]!
  const explicit = c.req.query("app")
  if (explicit && /^[a-z0-9-]{2,40}$/.test(explicit)) return explicit
  const ref = URL.parse(c.req.header("Referer") ?? "")
  return ref && (ref.origin === u.origin || ref.origin === c.env.PUBLIC_ORIGIN)
    ? ref.pathname.split("/")[1] || null
    : null
}
export function contactHost(c: Ctx, slug: string) {
  return !c.env.APP_DOMAIN || new URL(c.req.url).hostname === `${slug}.${c.env.APP_DOMAIN}`
}
const key = (slug: string) => `__Host-bh_contact_${slug}`
export function contactCookie(c: Ctx, slug: string, raw: string, age = contactTTL) {
  setCookie(c, key(slug), raw, { path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: age })
}
export async function contactHash(c: Ctx, slug: string) {
  const t = contactHost(c, slug) && getCookie(c, key(slug))
  return t && /^[a-f0-9]{64}$/.test(t) ? sha256(t) : null
}
export type ContactIdentity = { contact: NonNullable<Me["contact"]>; hash: string }
// /api/page composes the session and workspace readers concurrently. Share this
// request's renewal only; a subsequent request always revalidates the credential.
export function activeContact(c: Ctx, slug: string): Promise<ContactIdentity | null> {
  const reads = c.var.contactReads ?? new Map<string, Promise<ContactIdentity | null>>()
  c.set("contactReads", reads)
  let found = reads.get(slug)
  if (!found) {
    found = renew(c, slug)
    reads.set(slug, found)
  }
  return found
}
async function renew(c: Ctx, slug: string) {
  const hash = await contactHash(c, slug)
  if (!hash) return null
  const lookup = sql(
    c.env,
    `SELECT t.id,t.name,t.email,t.external_id,t.verified_via,s.renewed_at<=unixepoch()-86400 due FROM contact_sessions s JOIN contacts t ON t.id=s.contact_id AND t.app_id=s.app_id JOIN apps a ON a.id=s.app_id WHERE s.hash=? AND s.expires>unixepoch() AND a.slug=? AND a.mode='helpdesk'`,
    hash,
    slug
  )
  type Read = NonNullable<Me["contact"]> & { due: number }
  const current = await lookup.first<Read>()
  if (!current) return null
  const { due, ...initial } = current
  if (!due) return { contact: initial, hash }
  const [touch, , read] = await c.env.DB.batch<Read & { age: number }>([
    sql(
      c.env,
      `UPDATE contact_sessions SET renewed_at=unixepoch(),expires=min(unixepoch()+CAST(? AS INTEGER),created_at+7776000) WHERE hash=? AND expires>unixepoch() AND renewed_at<=unixepoch()-86400 AND app_id=(SELECT id FROM apps WHERE slug=? AND mode='helpdesk') RETURNING expires-unixepoch() age`,
      contactTTL,
      hash,
      slug
    ),
    sql(
      c.env,
      `UPDATE contacts SET last_seen_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()>0 AND id=(SELECT contact_id FROM contact_sessions WHERE hash=?)`,
      hash
    ),
    lookup
  ])
  if (!read!.results[0]) return null
  const { due: _renewed, ...contact } = read!.results[0]
  if (touch!.results[0]) contactCookie(c, slug, getCookie(c, key(slug))!, touch!.results[0].age)
  return { contact, hash }
}
export const contactActor = (t: NonNullable<Me["contact"]>): Actor => ({
  type: "guest",
  id: t.id,
  name: t.name,
  handle: "contact-" + t.id.slice(3, 11)
})
export function assertContactHost(c: Ctx) {
  if (!contactHost(c, c.var.app.slug) || !c.var.desk) missing()
}
