import type { Actor, FeedbackCreated, Locale, SystemInfo } from "../shared/api"
import { LOCALES } from "../shared/api"
import { ApiFailure, appUrl, bad, dbError, email, fail, hex, input, now, rows, secret, sha256, sql, str, uid, type Ctx } from "./core"
import { createIssue, type Access } from "./mutations"
import { imageExtensions, imageLimits, inspectImage } from "./images"
import { clientIP, enforce } from "./rate-limits"
import { sendFeedbackConfirmation } from "./mail-routes"
import { esc, mailOrigin, sendMail, workspaceSender } from "./mail-provider"
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
  bytesPerKeyDay: 1024 * MiB,
  perIpDay: 50,
  bytesPerIpDay: 100 * MiB,
  userName: 40
}
const L = feedbackLimits
const tooLarge = (message = "Feedback exceeds the upload limit") => fail(413, "too_large", message)
const unsupported = (message: string) => fail(415, "unsupported_media_type", message)
type Shot = { name: string; mime: string; bytes: Uint8Array }

export function feedbackCors(c: Ctx) {
  c.header("Access-Control-Allow-Origin", "*")
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS")
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key")
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
// The real header decides: type, dimensions and nothing hidden after the image. The stored name always carries the
// detected type's extension.
function shot(index: number, name: unknown, bytes: Uint8Array): Shot {
  if (bytes.length > L.screenshot) tooLarge("Each screenshot must be 10 MB or smaller")
  const info = inspectImage(bytes)
  if (info === "too_large") return tooLarge(`Screenshots can be at most ${imageLimits.side} px a side and ${imageLimits.pixels / 1e6} megapixels`)
  if (info === "invalid") return unsupported("Screenshots must be PNG, JPEG or WebP images")
  const given = typeof name === "string" ? name.trim() : "",
    base = given.replace(/\.[^.]*$/, "").replace(/[\/\\\p{Cc}\p{Cf}]/gu, "").trim().slice(0, 200)
  return { name: (base && base !== "." ? base : "screenshot-" + (index + 1)) + "." + imageExtensions[info.mime], mime: info.mime, bytes }
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
// Guest-name rules for the app's user name: shown to the team as the reporter.
function userName(name: string) {
  if ([...name].length > L.userName || /[\p{Cc}\p{Cf}]/u.test(name)) bad("user.name must be 1-40 characters without control or formatting characters")
  return name
}
// A keyed hash, so stored client counters never hold an IP address.
async function keyed(env: Env, label: string, value: string) {
  if (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32) fail(503, "misconfigured", "Feedback signing unavailable")
  const enc = new TextEncoder(),
    k = await crypto.subtle.importKey("raw", enc.encode(env.COOKIE_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(label + ":" + value))).slice(0, 32)
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
      "SELECT k.id,k.name key_name,k.feedback,a.id app_id,a.slug,a.name,a.public,a.mode FROM report_keys k JOIN apps a ON a.id=k.app_id WHERE k.hash=? AND (?2 IS NULL OR a.slug=?2)",
      await sha256(bearer),
      scope
    ).first<{ id: string; key_name: string; feedback: number; app_id: string; slug: string; name: string; public: number; mode: string }>()
  if (!key) return invalid()
  if (key.mode !== "tracker") fail(403, "feedback_unavailable", "Help desk workspaces don't take feedback")
  if (!key.feedback) fail(403, "feedback_disabled", "This report key can't send feedback; an admin can turn it on")
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
    if (sentUser?.name !== undefined) userName(sentUser.name)
    const actorId = install ? await installActor(env, key.app_id, install) : secret().slice(0, 32),
      actor: Actor = {
        type: "guest",
        id: actorId,
        name: user?.name || "Anonymous",
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
        // One client's share of the key's day comes first, so it can't use up the key's own caps.
        sql(
          env,
          "INSERT INTO feedback_ip_daily(key_id,client,day,n,bytes) VALUES(?,?,date('now'),1,?) ON CONFLICT(key_id,client) DO UPDATE SET n=CASE WHEN day=excluded.day THEN n+1 ELSE 1 END,bytes=CASE WHEN day=excluded.day THEN bytes+excluded.bytes ELSE excluded.bytes END,day=excluded.day",
          key.id,
          await keyed(env, "feedback-client-v1", clientIP(c)),
          Math.max(bytes, stored)
        ),
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
      if (code === "feedback_daily_limit" || code === "feedback_byte_quota") c.executionCtx.waitUntil(limitReached(c, key))
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
          email: address ? await keepAddress(env, key.app_id, issue.id, actor, address, locale(device?.locale) ?? null) : "none"
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
  // A retry with the same key and the same feedback gets the first answer: no second issue, no second email. Keys
  // are scoped to the install when there is one, and an unfinished first attempt holds its key for 2 minutes.
  const install = b.anonymous !== true && typeof b.install_id === "string" && b.install_id.trim() ? b.install_id.trim() : null
  const s: Scope = {
    key: key.id,
    kind: "publishable",
    user: null,
    origin: install && (await installActor(env, key.app_id, install)),
    family: "",
    hash: "",
    app: key.app_id,
    slug: key.slug,
    name: key.name,
    mode: key.mode,
    allow_anonymous: 0,
    require_verified_email: 0
  }
  return replay(c, s, "/v1/feedback", await material(), accept, { table: "feedback_replays", pending: 120 })
}
// The address waits as a pending subscription; nothing is sent at submission. The confirmation goes out when the team
// first replies (askToConfirm). The same install's confirmed address in this app needs no second confirmation.
async function keepAddress(env: Env, app: string, issue: string, actor: Actor, address: string, locale: Locale | null) {
  await sql(
    env,
    `INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,address,state,reason,requested,locale)
    SELECT ?1,?2,?3,CASE WHEN EXISTS(SELECT 1 FROM mail_subs s JOIN feedback f ON f.issue_id=s.issue_id WHERE f.app_id=?5 AND f.install_hash=?2
      AND s.actor_id=?2 AND s.address=?3 AND s.state='on' AND s.user_id IS NULL) THEN 'on' ELSE 'pending' END,'opened',0,?4
    WHERE NOT EXISTS(SELECT 1 FROM mail_suppressed WHERE address=?3)`,
    issue,
    actor.id,
    address,
    locale,
    app
  ).run()
  // Neutral: the answer never tells whether the address was confirmed, opted out or new.
  return "pending" as const
}
// When the team (or an agent) first replies in public to a feedback issue, its reporter's pending address gets one
// neutral email: "{workspace} replied to your feedback", with no reply text until they confirm. One at a time per
// (app, address), at most 3 a day; another reporter's address in another app is unaffected.
export async function askToConfirm(env: Env, issue: string) {
  const subs = await rows<{ id: string; nonce: string; address: string; app_id: string; name: string; trusted: number; locale: Locale | null }>(
    sql(
      env,
      `SELECT s.id,s.nonce,s.address,a.id app_id,a.name,a.trusted,s.locale FROM mail_subs s JOIN feedback f ON f.issue_id=s.issue_id JOIN apps a ON a.id=f.app_id
      WHERE s.issue_id=? AND s.state='pending' AND s.user_id IS NULL AND s.requested<unixepoch()-86400
      AND NOT EXISTS(SELECT 1 FROM mail_suppressed WHERE address=s.address)`,
      issue
    )
  )
  for (const s of subs) {
    let reserved: unknown
    try {
      const [r] = await env.DB.batch([
        sql(
          env,
          `INSERT INTO feedback_confirmations(app_id,address,day,sub_id,nonce,n) SELECT ?1,s.address,date('now'),s.id,s.nonce,1 FROM mail_subs s WHERE s.id=?2 AND s.state='pending'
          AND NOT EXISTS(SELECT 1 FROM feedback_confirmations d JOIN mail_subs p ON p.id=d.sub_id AND p.nonce=d.nonce WHERE d.app_id=?1 AND d.address=s.address AND p.state='pending' AND p.requested>=unixepoch()-86400)
          ON CONFLICT(app_id,address) DO UPDATE SET day=excluded.day,sub_id=excluded.sub_id,nonce=excluded.nonce,n=CASE WHEN day=excluded.day THEN n+1 ELSE 1 END RETURNING sub_id`,
          s.app_id,
          s.id
        ),
        sql(
          env,
          "UPDATE mail_subs SET requested=unixepoch() WHERE id=? AND nonce=? AND EXISTS(SELECT 1 FROM feedback_confirmations WHERE app_id=? AND address=? AND sub_id=? AND nonce=?)",
          s.id,
          s.nonce,
          s.app_id,
          s.address,
          s.id,
          s.nonce
        )
      ])
      reserved = r!.results[0]
    } catch (e) {
      if ((String((e as Error).message) + String((e as Error).cause ?? "")).includes("feedback_confirmation_limit")) continue
      throw e
    }
    if (!reserved) continue
    try {
      await sendFeedbackConfirmation(env, s, s.address, s)
    } catch (e) {
      await sql(env, "UPDATE mail_subs SET requested=0 WHERE id=? AND nonce=?", s.id, s.nonce).run()
      console.error("bellhop.feedback_confirmation_failed", { message: (e as Error).message })
    }
  }
}
// A report key hit its own daily cap: tell the workspace's admins once a day, and note it in the audit log.
async function limitReached(c: Ctx, key: { id: string; key_name: string; app_id: string; slug: string; name: string }) {
  const env = c.env
  const [first] = await env.DB.batch([
    sql(env, "INSERT INTO feedback_key_alerts(key_id,day) VALUES(?,date('now')) ON CONFLICT(key_id) DO UPDATE SET day=excluded.day WHERE day<excluded.day", key.id),
    sql(
      env,
      `INSERT INTO audit_log(app_id,actor,action,target,data) SELECT ?,?,'report_key.feedback_limited',json_object('type','report_key','id',id,'name',name,'preview',preview),
      json_object('submissions',?,'bytes',?) FROM report_keys WHERE id=? AND changes()>0`,
      key.app_id,
      JSON.stringify({ type: "agent", id: "system", name: "Bellhop" }),
      L.perKeyDay,
      L.bytesPerKeyDay,
      key.id
    )
  ])
  if (!first!.meta.changes) return
  const admins = await rows<{ email: string; locale: Locale | null; trusted: number }>(
    sql(
      env,
      `SELECT u.email,u.locale,a.trusted FROM team t JOIN users u ON u.id=t.user_id JOIN apps a ON a.id=t.app_id WHERE t.app_id=? AND t.role IN ('admin','owner')
      AND NOT EXISTS(SELECT 1 FROM mail_suppressed WHERE address=u.email)`,
      key.app_id
    )
  )
  const url = appUrl(env, mailOrigin(env), key.slug, "/settings"),
    subject = `Feedback paused: report key "${key.key_name}" reached today's limit`,
    text = `Feedback sent with the report key "${key.key_name}" in ${key.name} reached its daily limit (${L.perKeyDay} submissions or ${L.bytesPerKeyDay / MiB} MB). New feedback with this key is refused until midnight UTC; each client also has its own daily share, so this usually means unusual traffic.`
  for (const a of admins)
    await sendMail(env, `feedback-limit-${key.id}-${new Date().toISOString().slice(0, 10)}-${await sha256(a.email)}`, {
      to: a.email,
      fromName: workspaceSender(key.name, !!a.trusted),
      subject,
      text: `${text}\n\n${url}`,
      html: `<p>${esc(text)}</p><p><a href="${esc(url)}">${esc(key.name)} settings</a></p>`
    }).catch((e) => console.error("bellhop.feedback_limit_mail_failed", { message: (e as Error).message }))
}
