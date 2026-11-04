import { Hono } from "hono"
import { recorded, auditActor } from "./audit"
import {
  appUrl,
  bad,
  body,
  fail,
  input,
  missing,
  now,
  secret,
  sha256,
  sql,
  str,
  uid,
  type Bindings,
  type Ctx
} from "./core"
import { clientIP, enforce } from "./rate-limits"
import { requireTeam } from "./permissions"
import { authenticate } from "./mcp"
import { decodeReport, getReport, reportQuery, purgeReportObjects, type ReportRow } from "./report-data"
import type { Viewer } from "./visibility"
import type { ReportKey } from "../shared/api"

const MiB = 1024 * 1024,
  ttl = 7 * 86400000
const tooLarge = () => fail(413, "too_large", "Report exceeds the upload limit")
async function jsonUpload(c: Ctx) {
  if (c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    fail(415, "unsupported_media_type", "Expected application/json")
  if (Number(c.req.header("content-length")) > 10 * MiB) {
    // As for ordinary uploads, drain without retaining bytes. Closing an in-flight
    // request body early can reset the connection instead of returning the JSON 413.
    await c.req.raw.body?.pipeTo(new WritableStream())
    tooLarge()
  }
  const reader = c.req.raw.body?.getReader()
  if (!reader) bad("Missing report")
  let buffer = new Uint8Array(65536),
    size = 0
  try {
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      const end = size + r.value.byteLength
      if (end > 10 * MiB) {
        buffer = new Uint8Array(0)
        while (!(await reader.read()).done) {
          /* discard the rest of a chunked upload */
        }
        tooLarge()
      }
      if (end > buffer.length) {
        const next = new Uint8Array(Math.min(10 * MiB, Math.max(end, buffer.length * 2)))
        next.set(buffer)
        buffer = next
      }
      buffer.set(r.value, size)
      size = end
    }
  } finally {
    reader.releaseLock()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buffer.subarray(0, size)))
  } catch {
    bad("Invalid report JSON")
  }
  return { payload: input(parsed), bytes: size }
}
function fields(value: unknown, limit: number) {
  if (value === undefined) return {}
  const entries = Object.entries(input(value))
  if (entries.length > 64) bad("At most 64 fields per section")
  return Object.fromEntries(entries.map(([k, v]) => [str(k, "field name", 120), str(v, "field value", limit, true)]))
}
function logs(value: unknown) {
  if (value === undefined) return []
  if (!Array.isArray(value)) bad("Expected logs")
  if (value.length > 20) tooLarge()
  const seen = new Set<string>(),
    enc = new TextEncoder()
  return value.map((entry) => {
    const item = input(entry),
      name = str(item.name, "log name", 255)
    if (/[\/\\\p{Cc}\p{Cs}]/u.test(name) || name === "." || name === ".." || seen.has(name))
      bad("Invalid or duplicate log name")
    seen.add(name)
    if (typeof item.content !== "string") bad("Expected text log content")
    if (item.content.length > 5 * MiB) tooLarge()
    const bytes = enc.encode(item.content)
    if (bytes.length > 5 * MiB) tooLarge()
    return { name, bytes, id: "ml_" + uid() }
  })
}
export async function uploadReport(c: Ctx) {
  c.header("Access-Control-Allow-Origin", "*")
  c.header("Access-Control-Allow-Methods", "POST, OPTIONS")
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type")
  c.header("Cache-Control", "no-store")
  if (c.req.method === "OPTIONS") return c.body(null, 204)
  await enforce(c, "RL_UPLOAD", `report-ip:${clientIP(c)}`)
  const bearer = /^Bearer (bh_pub_[a-f0-9]{64})$/i.exec(c.req.header("Authorization") ?? "")?.[1]
  const invalid = () => fail(401, "invalid_report_key", "Invalid workspace report key")
  if (!bearer) return invalid()
  const slug = c.req.param("slug")!,
    env = c.env,
    key = await sql(
      env,
      "SELECT k.id,k.app_id FROM report_keys k JOIN apps a ON a.id=k.app_id WHERE a.slug=? AND k.hash=?",
      slug,
      await sha256(bearer)
    ).first<{ id: string; app_id: string }>()
  if (!key) return invalid()
  await enforce(c, "RL_WRITE", `report-key:${key.id}`)
  const { payload: b, bytes } = await jsonUpload(c),
    id = "md_" + secret(),
    at = now(),
    expires = new Date(Date.now() + ttl).toISOString(),
    items = logs(b.logs),
    system = fields(b.system, 2048),
    context = fields(b.context, 4096)
  const src = b.source === undefined ? null : input(b.source),
    source = src && {
      name: str(src.name, "source name", 120),
      ...(src.version !== undefined && { version: str(src.version, "source version", 120) })
    }
  if (new TextEncoder().encode(JSON.stringify([system, context])).length > 256 * 1024) tooLarge()
  await env.DB.batch([
    // Reserve the accepted wire bytes and upload slot together, before writing any R2
    // objects. Review/deletion never refunds this daily abuse budget.
    sql(
      env,
      `INSERT INTO report_key_daily(key_id,day,uploads,bytes) SELECT id,date('now'),1,? FROM report_keys WHERE id=?
      ON CONFLICT(key_id) DO UPDATE SET day=excluded.day,uploads=CASE WHEN day=excluded.day THEN uploads+1 ELSE 1 END,
        bytes=CASE WHEN day=excluded.day THEN bytes+excluded.bytes ELSE excluded.bytes END`,
      bytes,
      key.id
    ),
    sql(
      env,
      `INSERT INTO report_metadata(id,app_id,title,message,source,system,context,fingerprint,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      id,
      key.app_id,
      b.title === undefined ? null : str(b.title, "title", 256, true),
      b.message === undefined ? null : str(b.message, "message", 8192, true),
      source && JSON.stringify(source),
      JSON.stringify(system),
      JSON.stringify(context),
      b.fingerprint === undefined ? null : str(b.fingerprint, "fingerprint", 256),
      at,
      expires
    ),
    ...items.map((l) =>
      sql(
        env,
        "INSERT INTO report_logs(id,metadata_id,name,size,object_key) VALUES(?,?,?,?,?)",
        l.id,
        id,
        l.name,
        l.bytes.length,
        `reports/${key.app_id}/${l.id}`
      )
    )
  ])
  // Stage the descriptors before R2 writes so interruption is recoverable by the expiry
  // sweep. Nothing is readable until all objects exist and the key is still authorized.
  try {
    for (const l of items)
      await env.MEDIA.put(`reports/${key.app_id}/${l.id}`, l.bytes, { httpMetadata: { contentType: "text/plain" } })
    const [ready] = await env.DB.batch([
      sql(
        env,
        "UPDATE report_metadata SET ready=1 WHERE id=? AND EXISTS(SELECT 1 FROM report_keys WHERE id=? AND app_id=report_metadata.app_id)",
        id,
        key.id
      ),
      sql(env, "UPDATE report_keys SET last_used_at=max(coalesce(last_used_at,''),?) WHERE id=?", at, key.id)
    ])
    if (!ready!.meta.changes) invalid()
  } catch (e) {
    await sql(env, "DELETE FROM report_metadata WHERE id=? AND ready=0", id).run()
    throw e
  }
  return c.json(
    {
      id,
      url: appUrl(env, env.PUBLIC_ORIGIN || new URL(c.req.url).origin, slug, `/new?metadata=${id}`),
      expires_at: expires
    },
    201
  )
}

const keyFields = "id,name,preview,created_at,last_used_at"
export const reports = new Hono<Bindings>(),
  base = "/api/apps/:slug"
reports.get(`${base}/report-keys`, async (c) => {
  requireTeam(c, "setup")
  return c.json(
    (
      await sql(
        c.env,
        `SELECT ${keyFields} FROM report_keys WHERE app_id=? ORDER BY created_at,id`,
        c.var.app.id
      ).all<ReportKey>()
    ).results
  )
})
reports.post(`${base}/report-keys`, async (c) => {
  requireTeam(c, "setup")
  const key = "bh_pub_" + secret(),
    name = str((await body(c)).name, "name", 120).trim()
  const id = uid(),
    preview = key.slice(0, 15) + "…"
  const r = await recorded<ReportKey>(
    c.env,
    sql(
      c.env,
      `INSERT INTO report_keys(id,app_id,name,preview,hash,created_at) VALUES(?,?,?,?,?,?) RETURNING ${keyFields}`,
      id,
      c.var.app.id,
      name,
      preview,
      await sha256(key),
      now()
    ),
    c.var.app.id,
    c.var.actor,
    "report_key.created",
    { type: "report_key", id, preview }
  )
  return c.json({ ...r.results[0], key }, 201)
})
reports.delete(`${base}/report-keys/:id`, async (c) => {
  requireTeam(c, "setup")
  const app = c.var.app.id,
    id = c.req.param("id"),
    [, r] = await c.env.DB.batch([
      sql(
        c.env,
        `INSERT INTO audit_log(app_id,actor,action,target) SELECT app_id,?,'report_key.revoked',json_object('type','report_key','id',id,'preview',preview) FROM report_keys WHERE app_id=? AND id=?`,
        auditActor(c.var.actor),
        app,
        id
      ),
      sql(c.env, "DELETE FROM report_keys WHERE app_id=? AND id=?", app, id)
    ])
  if (!r!.meta.changes) missing()
  return c.json({ ok: true })
})
export async function reportViewer(c: Ctx, app: string, browser: Viewer): Promise<Viewer> {
  if (c.req.header("Authorization")) {
    const agent = await authenticate(c)
    if (!agent?.apps.some((a) => a.id === app)) missing()
    return { actorId: agent.actor.id, team: true }
  }
  return browser
}
function viewer(c: Ctx) {
  return reportViewer(c, c.var.app.id, { actorId: c.var.actor.id, aliases: c.var.aliases, team: !!c.var.app.role })
}
reports.get(`${base}/metadata/:id`, async (c) =>
  c.json(await getReport(c.env, c.var.app.id, c.req.param("id"), await viewer(c)))
)
reports.delete(`${base}/metadata/:id/items`, async (c) => {
  const app = c.var.app.id,
    id = c.req.param("id"),
    v = await viewer(c),
    m = await getReport(c.env, app, id, v)
  if (m?.attached_to) fail(409, "already_attached", "Report already attached")
  const b = await body(c),
    names = (k: string) => {
      const a = b[k] ?? []
      if (!Array.isArray(a) || a.length > 64) bad(`Invalid ${k}`)
      return JSON.stringify(a.map((x) => str(x, k, 255)))
    }
  const [, , removed, result] = await c.env.DB.batch([
    sql(c.env, "INSERT INTO pending_report VALUES(?,?)", id, app),
    sql(
      c.env,
      `UPDATE report_metadata SET system=(SELECT json_group_object(key,value) FROM json_each(system) WHERE key NOT IN(SELECT value FROM json_each(?))), context=(SELECT json_group_object(key,value) FROM json_each(context) WHERE key NOT IN(SELECT value FROM json_each(?))) WHERE id=?`,
      names("system"),
      names("context"),
      id
    ),
    sql(
      c.env,
      "DELETE FROM report_logs WHERE metadata_id=? AND name IN(SELECT value FROM json_each(?)) RETURNING object_key",
      id,
      names("logs")
    ),
    reportQuery(c.env, app, v, "id", id)
  ])
  await purgeReportObjects(
    c.env,
    (removed!.results as { object_key: string }[]).map((l) => l.object_key)
  )
  return c.json(decodeReport(result!.results[0] as ReportRow))
})
