import { Hono } from "hono"
import type { IdentityKey, NewIdentityKey } from "../shared/api"
import { recorded } from "./audit"
import { body, denied, fail, missing, now, secret, sql, str, uid, type Bindings, type Ctx } from "./core"
import { can } from "./permissions"

const enc = new TextEncoder()
type KeyPurpose = "host-identity/v1" | "approval-signing/v1"
async function wrappingKey(env: Env, purpose: KeyPurpose) {
  const secret = purpose === "approval-signing/v1" ? env.APPROVAL_KEK : env.COOKIE_SECRET
  if (!secret || secret.length < 32)
    fail(
      503,
      "misconfigured",
      purpose === "approval-signing/v1"
        ? "APPROVAL_KEK is required (at least 32 characters)"
        : "Identity encryption unavailable"
    )
  const material = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("Bellhop"), info: enc.encode(purpose) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}
const aad = (app: string, id: string) => enc.encode(JSON.stringify([app, id]))
export async function seal(env: Env, app: string, id: string, value: string, purpose: KeyPurpose = "host-identity/v1") {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(app, id) },
    await wrappingKey(env, purpose),
    enc.encode(value)
  )
  return btoa(String.fromCharCode(...iv, ...new Uint8Array(ciphertext)))
}
export async function unseal(env: Env, app: string, id: string, cipher: string, purpose: KeyPurpose) {
  const bytes = Uint8Array.from(atob(cipher), (x) => x.charCodeAt(0))
  return crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: aad(app, id) },
    await wrappingKey(env, purpose),
    bytes.subarray(12)
  )
}
export async function verifier(env: Env, app: string, id: string, cipher: string) {
  return crypto.subtle.importKey(
    "raw",
    await unseal(env, app, id, cipher, "host-identity/v1"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  )
}

export const identityKeys = new Hono<Bindings>()
const path = "/api/apps/:slug/identity-keys",
  fields = "id,name,preview,created_at,last_used_at"
// Recheck the admin grant and mode at the database operation as well as at the HTTP boundary.
const grant = `SELECT a.id FROM apps a JOIN members m ON m.app_id=a.id WHERE a.id=? AND a.mode='helpdesk' AND m.user_id=? AND m.role IN ('admin','owner')`
function admin(c: Ctx) {
  if (!c.var.desk) fail(403, "helpdesk_only", "Help desk workspace required")
  if (!c.var.user || !can(c.var.app.role, "setup")) denied()
  return [c.var.app.id, c.var.user.id] as const
}
identityKeys.get(path, async (c) => {
  const access = admin(c)
  return c.json(
    (
      await sql(
        c.env,
        `SELECT ${fields} FROM identity_keys WHERE app_id=(${grant}) ORDER BY created_at,id`,
        ...access
      ).all<IdentityKey>()
    ).results
  )
})
identityKeys.post(path, async (c) => {
  const access = admin(c),
    name = str((await body(c)).name, "name", 120).trim(),
    id = uid(),
    raw = "bh_id_" + secret(),
    preview = "bh_id_…" + raw.slice(-4)
  const write = sql(
    c.env,
    `INSERT INTO identity_keys(id,name,preview,cipher,created_at,app_id) SELECT ?,?,?,?,?,id FROM (${grant}) RETURNING ${fields}`,
    id,
    name,
    preview,
    await seal(c.env, access[0], id, raw),
    now(),
    ...access
  )
  const r = await recorded<IdentityKey>(c.env, write, access[0], c.var.actor, "identity_key.created", { preview })
  return c.json({ ...(r.results[0] ?? denied()), secret: raw } satisfies NewIdentityKey, 201)
})
identityKeys.delete(path + "/:id", async (c) => {
  const access = admin(c),
    id = c.req.param("id")
  const row =
    (await sql(c.env, `SELECT preview FROM identity_keys WHERE app_id=(${grant}) AND id=?`, ...access, id).first<{
      preview: string
    }>()) ?? missing()
  const r = await recorded(
    c.env,
    sql(c.env, `DELETE FROM identity_keys WHERE app_id=(${grant}) AND id=?`, ...access, id),
    access[0],
    c.var.actor,
    "identity_key.revoked",
    { preview: row.preview }
  )
  if (!r.meta.changes) missing()
  return c.json({ ok: true })
})
