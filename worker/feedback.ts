import type { Actor, FeedbackCreated, Locale, SystemInfo } from "../shared/api"
import { LOCALES } from "../shared/api"
import { ApiFailure, bad, dbError, email, fail, hex, input, now, secret, sha256, sql, str, uid, type Ctx } from "./core"
import { createIssue, type Access } from "./mutations"
import { imageType } from "./icons"
import { allowed, clientIP, enforce } from "./rate-limits"
import { reserveConfirmation, sendConfirmation } from "./mail-routes"
import { checkHost, type Scope } from "./v1/access"
import { replay } from "./v1/replay"

const MiB = 1024 * 1024
/** Feedback limits, also documented in the v1 OpenAPI description. */
export const feedbackLimits = {
  request: 30 * MiB,
  screenshots: 5,
  screenshot: 10 * MiB,
  screenshotTotal: 20 * MiB,
  subject: 200,
  message: 20000,
  metadataKeys: 64,
  metadataKey: 64,
  metadataValue: 2000,
  logs: 10,
  log: MiB,
  field: 200,
  perIpMinute: 10,
  perKeyMinute: 60,
  perInstallHour: 10,
  perKeyDay: 1000,
  bytesPerKeyDay: 1024 * MiB
}
const L = feedbackLimits
const tooLarge = (message = "Feedback exceeds the upload limit") => fail(413, "too_large", message)
const unsupported = (message: string) => fail(415, "unsupported_media_type", message)
type Shot = { name: string; mime: string; bytes: Uint8Array }

export function feedbackCors(c: Ctx) {
  c.header("Access-Control-Allow-Origin", "*")
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS")
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type")
  c.header("Access-Control-Expose-Headers", "Retry-After")
  c.header("Access-Control-Max-Age", "86400")
  c.header("Cache-Control", "no-store")
}
async function readBody(c: Ctx) {
  if (Number(c.req.header("content-length")) > L.request) {
    await c.req.raw.body?.pipeTo(new WritableStream())
    tooLarge()
  }
  const reader = c.req.raw.body?.getReader()
  if (!reader) bad("Missing feedback")
  let buffer = new Uint8Array(65536),
    size = 0
  try {
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      const end = size + r.value.byteLength
      if (end > L.request) {
        buffer = new Uint8Array(0)
        while (!(await reader.read()).done) {
          /* discard the rest of a chunked upload */
        }
        tooLarge()
      }
      if (end > buffer.length) {
        const next = new Uint8Array(Math.min(L.request, Math.max(end, buffer.length * 2)))
        next.set(buffer.subarray(0, size))
        buffer = next
      }
      buffer.set(r.value, size)
      size = end
    }
  } finally {
    reader.releaseLock()
  }
  return buffer.subarray(0, size)
}
const digest = async (bytes: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", bytes))
function json(bytes: Uint8Array) {
  try {
    return input(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)))
  } catch (e) {
    if (e instanceof ApiFailure) throw e
    return bad("Invalid feedback JSON")
  }
}
const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const
function shot(index: number, name: unknown, bytes: Uint8Array): Shot {
  if (bytes.length > L.screenshot) tooLarge("Each screenshot must be 10 MB or smaller")
  const mime = imageType(bytes)
  if (!mime) return unsupported("Screenshots must be PNG, JPEG or WebP images")
  const given = typeof name === "string" ? name.trim() : ""
  const safe = given && given.length <= 255 && !/[\/\\\x00-\x1f\x7f]/.test(given) && given !== "." && given !== ".."
  return { name: safe ? given : "screenshot-" + (index + 1) + "." + extensions[mime], mime, bytes }
}
// JSON (base64 screenshots) or multipart (a "payload" part and "screenshot" file parts), one shape after parsing.
async function parse(c: Ctx) {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (type !== "application/json" && type !== "multipart/form-data")
    unsupported("Send application/json or multipart/form-data")
  const bytes = await readBody(c)
  const shots: Shot[] = []
  let b: Record<string, unknown>,
    // What a retry must repeat: the JSON body, or the payload part and the screenshot parts (not the boundary).
    material: () => Promise<string>
  if (type === "application/json") {
    b = json(bytes)
    material = async () => JSON.stringify(["json", await digest(bytes)])
    const list = b.screenshots ?? []
    if (!Array.isArray(list)) bad("Invalid screenshots")
    if (list.length > L.screenshots) bad("At most 5 screenshots")
    list.forEach((item, i) => {
      const s = input(item)
      str(s.content_type, "screenshot content_type", 100)
      const data = str(s.data, "screenshot data", Math.ceil((L.screenshot * 4) / 3) + 4)
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4) bad("Screenshot data must be base64")
      let decoded: Uint8Array
      try {
        decoded = Uint8Array.from(atob(data), (x) => x.charCodeAt(0))
      } catch {
        return bad("Screenshot data must be base64")
      }
      shots.push(shot(i, s.name, decoded))
    })
  } else {
    let form: FormData
    try {
      form = await new Response(bytes, { headers: { "content-type": c.req.header("content-type")! } }).formData()
    } catch {
      return bad("Invalid multipart body")
    }
    const payload = form.get("payload")
    if (payload === null) return bad("Missing payload part")
    const text = typeof payload === "string" ? new TextEncoder().encode(payload) : new Uint8Array(await payload.arrayBuffer())
    b = json(text)
    material = async () =>
      JSON.stringify(["multipart", await digest(text), await Promise.all(shots.map(async (s) => [s.name, await digest(s.bytes)]))])
    if (b.screenshots !== undefined) bad("Send screenshots as screenshot parts")
    const files = form.getAll("screenshot")
    if (files.length > L.screenshots) bad("At most 5 screenshots")
    for (const [i, f] of files.entries()) {
      if (typeof f === "string") return bad("screenshot parts must be files")
      shots.push(shot(i, f.name, new Uint8Array(await f.arrayBuffer())))
    }
  }
  if (shots.reduce((n, s) => n + s.bytes.length, 0) > L.screenshotTotal)
    tooLarge("Screenshots must be 20 MB or smaller in total")
  return { b, shots, bytes: bytes.length, material }
}
const optional = (v: unknown, key: string, max = L.field) =>
  v === undefined || v === null ? undefined : str(v, key, max).trim() || undefined
function fields<K extends string>(v: unknown, key: string, keys: readonly K[]) {
  if (v === undefined || v === null) return null
  const o = input(v),
    out: Partial<Record<K, string>> = {}
  for (const k of Object.keys(o)) if (!keys.includes(k as K)) bad("Unknown " + key + " field: " + k)
  for (const k of keys) {
    const value = optional(o[k], key + "." + k)
    if (value !== undefined) out[k] = value
  }
  return Object.keys(out).length ? out : null
}
function metadata(v: unknown) {
  if (v === undefined || v === null) return {}
  const entries = Object.entries(input(v))
  if (entries.length > L.metadataKeys) bad("At most 64 metadata keys")
  return Object.fromEntries(
    entries.map(([k, value]) => {
      if (!k.length || k.length > L.metadataKey || /[\x00-\x1f\x7f]/.test(k)) bad("Metadata keys must be 1-64 characters")
      return [k, str(value, "metadata value", L.metadataValue, true)]
    })
  )
}
function logs(v: unknown) {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > L.logs) bad("At most 10 logs")
  const seen = new Set<string>(),
    enc = new TextEncoder()
  return v.map((entry) => {
    const item = input(entry),
      name = str(item.name, "log name", 255)
    if (/[\/\\\p{Cc}\p{Cs}]/u.test(name) || name === "." || name === ".." || seen.has(name))
      bad("Invalid or duplicate log name")
    seen.add(name)
    if (typeof item.content !== "string") bad("Expected text log content")
    const bytes = enc.encode(item.content)
    if (bytes.length > L.log) tooLarge("Each log must be 1 MB or smaller")
    return { name, bytes, id: "ml_" + uid() }
  })
}
const locale = (tag: string | undefined): Locale | undefined =>
  tag
    ? (LOCALES.find((l) => l.toLowerCase() === tag.toLowerCase()) ??
      LOCALES.find((l) => l === tag.split(/[-_]/)[0]!.toLowerCase()))
    : undefined
// A stable per-(app, install) reporter that never reveals the install id: a keyed hash of it.
async function installActor(env: Env, app: string, install: string) {
  if (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32) fail(503, "misconfigured", "Feedback signing unavailable")
  const enc = new TextEncoder(),
    key = await crypto.subtle.importKey("raw", enc.encode(env.COOKIE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign"
    ])
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode("bellhop-feedback-install-v1:" + app + ":" + install))).slice(0, 32)
}
function rethrow(e: unknown): never {
  throw (e instanceof ApiFailure ? e : e instanceof Error ? dbError(e) : null) ?? e
}
const firstLine = (s: string) => {
  const line = s.trim().split(/\r?\n/)[0]!.trim()
  return line.length > 80 ? line.slice(0, 79) + "…" : line
}

/** POST /v1/feedback (and /api/apps/:slug/feedback): one in-app feedback submission, authorized by a report key. */
export async function submitFeedback(c: Ctx, slug?: string) {
  feedbackCors(c)
  if (c.req.method === "OPTIONS") return c.body(null, 204)
  if (!slug) checkHost(c)
  await enforce(c, "RL_UPLOAD", "feedback-ip:" + clientIP(c))
  const bearer = /^Bearer (bh_pub_[a-f0-9]{64})$/i.exec(c.req.header("Authorization") ?? "")?.[1]
  const invalid = () => fail(401, "invalid_report_key", "Invalid workspace report key")
  if (!bearer) return invalid()
  const env = c.env,
    host = !slug && env.APP_DOMAIN ? new URL(c.req.url).hostname : null,
    // On a workspace host the key must be that workspace's; api.<domain> and dev take the key's workspace.
    scope = slug ?? (host && host !== "api." + env.APP_DOMAIN ? host.slice(0, -env.APP_DOMAIN.length - 1) : null),
    key = await sql(
      env,
      "SELECT k.id,a.id app_id,a.slug,a.name,a.public,a.mode FROM report_keys k JOIN apps a ON a.id=k.app_id WHERE k.hash=? AND (?2 IS NULL OR a.slug=?2)",
      await sha256(bearer),
      scope
    ).first<{ id: string; app_id: string; slug: string; name: string; public: number; mode: string }>()
  if (!key) return invalid()
  if (key.mode !== "tracker") fail(403, "feedback_unavailable", "Help desk workspaces don't take feedback")
  const { b, shots, bytes, material } = await parse(c)
  const accept = async () => {
    const known = ["subject", "message", "email", "anonymous", "user", "app", "device", "install_id", "metadata", "category", "screenshots", "logs"]
    for (const k of Object.keys(b)) if (!known.includes(k)) bad("Unknown field: " + k)
    if (b.anonymous !== undefined && typeof b.anonymous !== "boolean") bad("anonymous must be a boolean")
    const anonymous = b.anonymous === true,
      message = str(b.message, "message", L.message),
      subject = optional(b.subject, "subject", L.subject),
      app = fields(b.app, "app", ["name", "version", "build"] as const),
      device = fields(b.device, "device", ["platform", "os", "model", "locale"] as const),
      meta = metadata(b.metadata),
      category = optional(b.category, "category", 60),
      // Anonymous keeps no email, user, install id or logs, whatever was sent (they're still validated).
      sentEmail = b.email !== undefined && b.email !== null && b.email !== "" ? email(b.email) : null,
      sentUser = fields(b.user, "user", ["id", "name"] as const),
      sentInstall = optional(b.install_id, "install_id"),
      sentLogs = logs(b.logs),
      address = anonymous ? null : sentEmail,
      user = anonymous ? null : sentUser,
      install = anonymous ? undefined : sentInstall,
      files = anonymous ? [] : sentLogs
    const actorId = install ? await installActor(env, key.app_id, install) : secret().slice(0, 32),
      actor: Actor = {
        type: "guest",
        id: actorId,
        name: user?.name?.slice(0, 120) || "Anonymous",
        handle: "guest-" + actorId.slice(0, 4)
      }
    const info: SystemInfo = {}
    for (const [k, v] of [
      ["App", app?.name],
      ["Version", app?.version],
      ["Build", app?.build],
      ["Platform", device?.platform],
      ["OS", device?.os],
      ["Model", device?.model],
      ["Locale", device?.locale]
    ] as const)
      if (v) info[k] = v
    // Budgets first: nothing is stored or uploaded for a refused submission. Reservations are never refunded.
    const minute = Math.floor(Date.now() / 60000),
      hour = Math.floor(Date.now() / 3600000),
      stored = shots.reduce((n, s) => n + s.bytes.length, 0) + files.reduce((n, l) => n + l.bytes.length, 0)
    const window = (scope: "key" | "install", id: string, bucket: number, cap: number) =>
      sql(
        env,
        "INSERT INTO feedback_rate VALUES(?,?,?,1,?) ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN bucket=excluded.bucket THEN hits+1 ELSE 1 END,bucket=excluded.bucket,cap=excluded.cap",
        scope + ":" + id,
        scope,
        bucket,
        cap
      )
    try {
      await env.DB.batch([
        window("key", key.id, minute, L.perKeyMinute),
        ...(install ? [window("install", actorId, hour, L.perInstallHour)] : []),
        sql(
          env,
          "INSERT INTO feedback_key_daily(key_id,day,n,bytes) VALUES(?,date('now'),1,?) ON CONFLICT(key_id) DO UPDATE SET n=CASE WHEN day=excluded.day THEN n+1 ELSE 1 END,bytes=CASE WHEN day=excluded.day THEN bytes+excluded.bytes ELSE excluded.bytes END,day=excluded.day",
          key.id,
          Math.max(bytes, stored)
        )
      ])
    } catch (e) {
      const code = e instanceof Error ? dbError(e)?.code : undefined
      if (code === "key_rate_limited") c.header("Retry-After", String(60 - (Math.floor(Date.now() / 1000) % 60)))
      if (code === "install_rate_limited") c.header("Retry-After", String(3600 - (Math.floor(Date.now() / 1000) % 3600)))
      rethrow(e)
    }
    const at = now(),
      objects: string[] = [],
      shotIds = shots.map(() => uid()),
      report = Object.keys(meta).length || files.length ? "md_" + secret() : null,
      title = subject ?? firstLine(message)
    try {
      for (const [i, s] of shots.entries()) {
        objects.push(key.app_id + "/" + shotIds[i])
        await env.MEDIA.put(objects[i]!, s.bytes, { httpMetadata: { contentType: s.mime } })
      }
      for (const l of files) {
        objects.push("reports/" + key.app_id + "/" + l.id)
        await env.MEDIA.put(objects.at(-1)!, l.bytes, { httpMetadata: { contentType: "text/plain" } })
      }
      if (shots.length)
        await env.DB.batch(
          shots.map((s, i) =>
            sql(env, "INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?)", shotIds[i], key.app_id, actorId, objects[i], s.name, s.mime, s.bytes.length, "image", at)
          )
        )
      const a: Access = {
        env,
        ctx: c.executionCtx,
        app: { id: key.app_id, slug: key.slug, name: key.name, public: !!key.public },
        actor,
        role: null,
        origin: env.PUBLIC_ORIGIN || new URL(c.req.url).origin,
        locale: locale(device?.locale),
        serverWrite: (issue) => [
          // Feedback is private whatever the workspace's default: only the team and agents see it.
          sql(env, "UPDATE issues SET private=1 WHERE id=?", issue),
          sql(
            env,
            "INSERT INTO feedback(issue_id,app_id,anonymous,email,user,app,device,install,install_hash,platform,app_version,category,screenshots,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            issue,
            key.app_id,
            Number(anonymous),
            address,
            user && JSON.stringify(user),
            app && JSON.stringify(app),
            device && JSON.stringify(device),
            install ?? null,
            install ? actorId : null,
            device?.platform?.toLowerCase() ?? null,
            app?.version ?? null,
            category ?? null,
            JSON.stringify(shotIds),
            at
          ),
          ...Object.entries(meta).map(([k, v]) => sql(env, "INSERT INTO feedback_meta VALUES(?,?,?)", issue, k, v)),
          ...(category
            ? [
                sql(env, "INSERT OR IGNORE INTO issue_labels SELECT ?,id FROM labels WHERE app_id=? AND name=?", issue, key.app_id, category),
                sql(
                  env,
                  "INSERT INTO issue_events SELECT ?,?,'labeled',?,json_object('label',json_object('id',id,'name',name,'color',color,'description',description)),? FROM labels WHERE app_id=? AND name=?",
                  uid(),
                  issue,
                  JSON.stringify(actor),
                  at,
                  key.app_id,
                  category
                )
              ]
            : []),
          ...(report
            ? [
                sql(
                  env,
                  "INSERT INTO report_metadata(id,app_id,title,message,source,system,context,fingerprint,created_at,expires_at,ready,issue_id) VALUES(?,?,?,NULL,?,?,?,NULL,?,NULL,1,?)",
                  report,
                  key.app_id,
                  title,
                  JSON.stringify({ name: app?.name ?? "Feedback form", ...(app?.version && { version: app.version }) }),
                  JSON.stringify(info),
                  JSON.stringify(meta),
                  at,
                  issue
                ),
                ...files.map((l) =>
                  sql(
                    env,
                    "INSERT INTO report_logs(id,metadata_id,name,size,object_key) VALUES(?,?,?,?,?)",
                    l.id,
                    report,
                    l.name,
                    l.bytes.length,
                    "reports/" + key.app_id + "/" + l.id
                  )
                )
              ]
            : []),
          sql(env, "UPDATE report_keys SET last_used_at=max(coalesce(last_used_at,''),?) WHERE id=?", at, key.id)
        ]
      }
      const issue = await createIssue(
        a,
        {
          title,
          body: message,
          ...(Object.keys(info).length && { system_info: info }),
          ...(shots.length && { attachment_ids: shotIds })
        },
        { c, operator: actor, staff: false }
      )
      return c.json(
        {
          number: issue.number,
          received_at: at,
          email: address ? await subscribe(c, key, issue.id, actor, address, locale(device?.locale) ?? null) : "none"
        } satisfies FeedbackCreated,
        201
      )
    } catch (e) {
      // Remove what a failed submission uploaded (nothing references it unless the issue committed).
      const committed = await sql(env, "SELECT 1 FROM feedback WHERE app_id=? AND screenshots=? AND created_at=?", key.app_id, JSON.stringify(shotIds), at).first()
      if (!committed) {
        if (shots.length) await sql(env, "DELETE FROM attachments WHERE id IN (SELECT value FROM json_each(?))", JSON.stringify(shotIds)).run()
        for (const o of objects) await env.MEDIA.delete(o)
      }
      rethrow(e)
    }
  }
  if (c.req.header("Idempotency-Key") === undefined) return accept()
  // A retry with the same key and the same feedback gets the first answer: no second issue, no second email.
  const s: Scope = {
    key: key.id,
    kind: "publishable",
    user: null,
    origin: null,
    family: "",
    hash: "",
    app: key.app_id,
    slug: key.slug,
    name: key.name,
    mode: key.mode,
    allow_anonymous: 0,
    require_verified_email: 0
  }
  return replay(c, s, "/v1/feedback", await material(), accept, "feedback_replays")
}
// One confirmation through the existing double opt-in; nothing else reaches an address until it's confirmed.
async function subscribe(
  c: Ctx,
  app: { app_id: string; name: string },
  issue: string,
  actor: Actor,
  address: string,
  locale: Locale | null
): Promise<FeedbackCreated["email"]> {
  const env = c.env
  if (await sql(env, "SELECT 1 FROM mail_suppressed WHERE address=?", address).first()) return "none"
  // The same install already confirmed this address in this app: no second confirmation.
  const known = await sql(
    env,
    "SELECT 1 FROM mail_subs s JOIN issues i ON i.id=s.issue_id WHERE i.app_id=? AND s.actor_id=? AND s.address=? AND s.state='on' AND s.user_id IS NULL LIMIT 1",
    app.app_id,
    actor.id,
    address
  ).first()
  const insert = (state: "on" | "pending") =>
    sql(
      env,
      "INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,address,state,reason,requested,locale) VALUES(?,?,?,?,'opened',unixepoch(),?)",
      issue,
      actor.id,
      address,
      state,
      locale
    )
  if (known) {
    await insert("on").run()
    return "not_needed"
  }
  if (!(await allowed(c, "RL_UPLOAD", "confirm:addr:" + (await sha256(address))))) return "limited"
  let reservation: { id: string; nonce: string; address: string } | undefined
  try {
    const [, r] = await env.DB.batch<{ id: string; nonce: string; address: string }>([
      insert("pending"),
      reserveConfirmation(env, issue, actor.id)
    ])
    reservation = r!.results[0]
  } catch (e) {
    if (dbError(e as Error)?.code === "confirmation_daily_limit") return "limited"
    throw e
  }
  // Another confirmation to this address is still waiting (sent within a day): don't send a second one.
  if (!reservation) return "limited"
  const trusted = (await sql(env, "SELECT trusted FROM apps WHERE id=?", app.app_id).first<number>("trusted")) ?? 0
  try {
    await sendConfirmation(env, reservation, address, { locale, trusted, workspace: app.name })
  } catch (e) {
    console.error("bellhop.feedback_confirmation_failed", { message: (e as Error).message })
    return "limited"
  }
  return "sent"
}
