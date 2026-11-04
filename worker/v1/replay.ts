import { ApiFailure, dbError, fail, hex, sql, str, uid, type Ctx } from "../core"
import type { Scope } from "./access"

const enc = new TextEncoder(),
  dec = new TextDecoder()
const b64 = (bytes: Uint8Array) => {
  let raw = ""
  for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(raw)
}
// Seal private response bodies and key the fingerprint of low-entropy OTPs. Mint
// responses store a random ticket, not a bearer; retries rederive the credential
// from the ticket, the original Authorization header and the server's secret.
export async function replay(c: Ctx, s: Scope, route: string, raw: string, run: (seed?: string) => Promise<Response>) {
  const nonce = c.req.header("Idempotency-Key")
  if (nonce === undefined) return run()
  str(nonce, "Idempotency-Key", 200)
  const secret = c.env.COOKIE_SECRET
  if (!secret || secret.length < 32) fail(503, "misconfigured", "Replay storage unavailable")
  const root = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"]),
    derive = (label: string) => ({
      name: "HKDF",
      hash: "SHA-256",
      salt: enc.encode("Bellhop"),
      info: enc.encode("v1/replay/" + label)
    })
  const [aes, mac] = await Promise.all([
    crypto.subtle.deriveKey(derive("response"), root, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
    crypto.subtle.deriveKey(derive("request"), root, { name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"])
  ])
  const scope = s.user ? s.hash : s.key + ":" + (s.origin ?? ""),
    ids = [s.key, scope, route, nonce],
    where = "key_id=? AND scope=? AND route=? AND nonce=?",
    digest = hex(
      await crypto.subtle.sign("HMAC", mac, enc.encode(JSON.stringify([raw, c.req.header("Challenge-Token") ?? null])))
    ),
    additionalData = enc.encode(JSON.stringify([...ids, digest]))
  const [, reservation, read] = await c.env.DB.batch<{ digest: string; status: number | null; cipher: string | null }>([
    sql(c.env, `DELETE FROM api_replays WHERE ${where} AND expires<=unixepoch()`, ...ids),
    sql(
      c.env,
      `INSERT INTO api_replays(key_id,scope,route,nonce,digest,expires) VALUES(?,?,?,?,?,unixepoch()+86400) ON CONFLICT DO NOTHING`,
      ...ids,
      digest
    ),
    sql(c.env, `SELECT digest,status,cipher FROM api_replays WHERE ${where}`, ...ids)
  ])
  const deriveSeed = async (ticket: string) =>
    hex(
      await crypto.subtle.sign(
        "HMAC",
        mac,
        enc.encode(JSON.stringify(["issue", c.req.header("Authorization"), ticket, ...ids, digest]))
      )
    )
  if (!reservation!.meta.changes) {
    const r = read!.results[0]!
    if (r.digest !== digest) fail(422, "idempotency_mismatch", "Key already used for another request")
    if (!r.cipher || !r.status) {
      c.header("Retry-After", "1")
      fail(409, "request_pending", "Request is pending")
    }
    const bytes = Uint8Array.from(atob(r.cipher), (v) => v.charCodeAt(0)),
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData },
        aes,
        bytes.subarray(12)
      )
    const [body, ticket, session, challenge] = JSON.parse(dec.decode(plain))
    const seed = await deriveSeed(ticket)
    if (challenge) c.header("Challenge-Token", c.req.header("Challenge-Token") ?? seed)
    if (session) body.token = "bh_us_" + seed
    if (r.status === 429) c.header("Retry-After", "60")
    return c.json(body, r.status as 200)
  }
  // Keep an indeterminate reservation on infrastructure failure: never duplicate a committed write.
  let response: Response
  const ticket = uid(),
    seed = await deriveSeed(ticket)
  try {
    response = await run(seed)
  } catch (e) {
    const err = e instanceof ApiFailure ? e : e instanceof Error ? dbError(e) : null
    if (!err) throw e
    if (err.status === 429) c.header("Retry-After", "60")
    response = c.json({ error: { code: err.code, message: err.message } }, err.status)
  }
  const body = await response.clone().json<Record<string, unknown>>(),
    session = body.token === "bh_us_" + seed
  if (session) body.token = null
  const iv = crypto.getRandomValues(new Uint8Array(12)),
    cipher = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData },
        aes,
        enc.encode(JSON.stringify([body, ticket, session, response.headers.has("Challenge-Token")]))
      )
    ),
    sealed = new Uint8Array(12 + cipher.length)
  sealed.set(iv)
  sealed.set(cipher, 12)
  await sql(
    c.env,
    `UPDATE api_replays SET status=?,cipher=? WHERE ${where} AND digest=?`,
    response.status,
    b64(sealed),
    ...ids,
    digest
  ).run()
  return response
}
