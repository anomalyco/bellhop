import type { Upload } from "../../shared/v1"
import { fail, hex, missing, sql, type Ctx } from "../core"
import { checkHost } from "./access"

const enc = new TextEncoder(),
  ttl = 3600
async function key(env: Env) {
  if (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32) fail(503, "misconfigured", "Media signing unavailable")
  const root = await crypto.subtle.importKey("raw", enc.encode(env.COOKIE_SECRET), "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("Bellhop"), info: enc.encode("end-user-media/v1") },
    root,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  )
}
const payload = (app: string, who: string, id: string, expiry: number) =>
  enc.encode(JSON.stringify([app, who, id, expiry]))
export type Audience = { env: Env; app: string; who: string; origin: string }
export async function signedFiles(a: Audience, files: Omit<Upload, "url">[]): Promise<Upload[]> {
  if (!files.length) return []
  const mac = await key(a.env),
    e = Math.floor(Date.now() / 1000) + ttl
  return Promise.all(
    files.map(async (f) => {
      const sig = hex(await crypto.subtle.sign("HMAC", mac, payload(a.app, a.who, f.id, e)))
      const q = new URLSearchParams({ app: a.app, contact: a.who, e: String(e), sig })
      return { ...f, url: `${a.origin}/media/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name)}?${q}` }
    })
  )
}
export async function signedFile(c: Ctx, id: string, name: string) {
  const { app, contact, e, sig } = c.req.query(),
    t = Math.floor(Date.now() / 1000)
  if (
    !app ||
    !contact ||
    !e ||
    !/^\d{1,12}$/.test(e) ||
    +e <= t ||
    +e > t + ttl ||
    !sig ||
    !/^\p{ASCII_Hex_Digit}{64}$/u.test(sig)
  )
    missing()
  const ok = await crypto.subtle.verify(
    "HMAC",
    await key(c.env),
    Uint8Array.from(sig.match(/../g)!, (x) => parseInt(x, 16)),
    payload(app, contact, id, +e)
  )
  if (!ok) missing()
  const file =
    (await sql(
      c.env,
      `SELECT f.name,f.size,f.mime,f.kind,f.object_key,a.slug FROM attachments f JOIN apps a ON a.id=f.app_id
    LEFT JOIN attachment_links l ON l.attachment_id=f.id LEFT JOIN issues i ON i.id=l.issue_id AND i.app_id=f.app_id LEFT JOIN comments m ON m.id=l.comment_id AND m.issue_id=i.id
    WHERE f.id=?1 AND f.name=?2 AND a.id=?3 AND a.mode='helpdesk'
    AND (EXISTS(SELECT 1 FROM contacts WHERE id=?4 AND app_id=a.id) OR (a.allow_anonymous AND EXISTS(SELECT 1 FROM api_sessions WHERE anon_id=?4 AND app_id=a.id AND expires>unixepoch())))
    AND ((l.attachment_id IS NULL AND f.owner_id=?4 AND EXISTS(SELECT 1 FROM api_pending_uploads WHERE id=f.id AND expires>unixepoch()))
      OR (i.hidden IS NULL AND json_extract(i.author,'$.id')=?4 AND (l.comment_id IS NULL OR (m.internal=0 AND m.hidden IS NULL))))`,
      id,
      name,
      app,
      contact
    ).first<{
      name: string
      size: number
      mime: string
      kind: "image" | "video" | "file"
      object_key: string
      slug: string
    }>()) ?? missing()
  checkHost(c, file.slug)
  return file
}
