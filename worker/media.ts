import { Hono, type MiddlewareHandler } from "hono"
import type { Attachment } from "../shared/api"
import { allowWrite } from "./auth"
import { viewerApp } from "./apps"
import { authenticate } from "./mcp"
import { sees, seesComment } from "./visibility"
import { bad, fail, missing, now, sql, str, uid } from "./core"
import type { Bindings } from "./core"
import { guestWrite } from "./guest-history"
import { attachment } from "./issues"
import type { AttachmentRow } from "./issues"
import { reportLog } from "./report-data"
import type { Ctx } from "./core"
import { authorize, checkHost, cors, preflightAllowed } from "./v1/access"
import { signedFile } from "./v1/signed-media"
import { clientIP, enforce } from "./rate-limits"

const MiB = 1024 * 1024
function tooLarge(): never {
  return fail(413, "too_large", "File exceeds the upload limit")
}

// R2 put needs a fixed-length stream. For chunked requests, bound memory to one multipart part.
export async function chunked(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream<Uint8Array>,
  mime: string,
  limit: number,
  digest?: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView>,
  admit?: (part: Uint8Array) => Promise<void>
) {
  const options = { httpMetadata: { contentType: mime } },
    reader = body.getReader(),
    buffer = new Uint8Array(5 * MiB),
    parts: R2UploadedPart[] = []
  let upload: R2MultipartUpload | undefined,
    used = 0,
    size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) tooLarge()
      if (digest) await digest.write(value)
      for (let i = 0; i < value.length; ) {
        const n = Math.min(buffer.length - used, value.length - i)
        buffer.set(value.subarray(i, i + n), used)
        used += n
        i += n
        if (used === buffer.length) {
          if (admit) await admit(buffer)
          upload ??= await bucket.createMultipartUpload(key, options)
          parts.push(await upload.uploadPart(parts.length + 1, buffer))
          used = 0
        }
      }
    }
    if (!size) bad("Empty upload")
    if (used && admit) await admit(buffer.subarray(0, used))
    if (upload) {
      if (used) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)))
      await upload.complete(parts)
    } else await bucket.put(key, buffer.subarray(0, used), options)
    if (digest) await digest.close()
    return size
  } catch (e) {
    await reader.cancel().catch(() => {})
    if (digest) await digest.abort().catch(() => {})
    if (upload) await upload.abort()
    throw e
  } finally {
    reader.releaseLock()
  }
}
export const media = new Hono<Bindings>()
export function uploadSpec(filename: unknown, contentType: string) {
  const name = str(filename, "file name", 255).trim()
  if (/[\/\\\x00-\x1f\x7f]/.test(name) || name === "." || name === "..") bad("Invalid file name")
  const raw = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  const mime = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(raw) ? raw : "application/octet-stream"
  const kind: Attachment["kind"] = mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : "file"
  return { name, mime, kind, limit: (kind === "image" ? 10 : kind === "video" ? 100 : 25) * MiB }
}
media.post("/api/apps/:slug/uploads", async (c) => {
  await allowWrite(c)
  const { name, mime, kind, limit } = uploadSpec(c.req.query("name"), c.req.header("Content-Type") ?? ""),
    len = c.req.header("content-length"),
    body = c.req.raw.body
  if (!body) bad("Empty upload")
  if (len !== undefined && (!/^\d+$/.test(len) || !Number(len))) bad("Invalid content length")
  if (len !== undefined && Number(len) > limit) {
    // Let the HTTP transport finish consuming the rejected request without buffering or storing it.
    await body.pipeTo(new WritableStream())
    tooLarge()
  }
  const app = c.var.app,
    actor = c.var.actor,
    env = c.env,
    id = uid(),
    key = `${app.id}/${id}`
  const recent = await sql(
    env,
    "SELECT count(*) n FROM attachments WHERE owner_id=? AND created_at>=?",
    actor.id,
    new Date(Date.now() - 3600000).toISOString()
  ).first<number>("n")
  if ((recent ?? 0) >= 40) fail(429, "rate_limited", "Hourly upload limit reached")
  const size =
    len === undefined
      ? await chunked(env.MEDIA, key, body, mime, limit)
      : (await env.MEDIA.put(key, body, { httpMetadata: { contentType: mime } })).size
  try {
    if (size > limit) tooLarge()
    const insert = sql(
      env,
      "INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?)",
      id,
      app.id,
      actor.id,
      key,
      name,
      mime,
      size,
      kind,
      now()
    )
    if (actor.type === "guest" && !c.var.contact) await env.DB.batch([insert, guestWrite(env, c.var.guestHash)])
    else await insert.run()
  } catch (e) {
    await env.MEDIA.delete(key)
    throw e
  }
  return c.json(attachment({ id, name, mime, size, kind }), 201)
})
// Uploads remain on their existing route. Widgets can fetch the regular media
// URL with their bearer (never a credential in an <img> URL or query string).
export const endUserMedia:MiddlewareHandler<Bindings>=async(c,next)=>{
  const id=c.req.param('id')!,name=c.req.param('name')!
  if (/^Bearer bh_sk_/i.test(c.req.header("Authorization") ?? "")) {
    await enforce(c, "RL_V1_IP", "v1:media:" + clientIP(c))
    const s = await authorize(c, "server")
    const file =
      (await sql(
        c.env,
        "SELECT f.name,f.mime,f.kind,f.size,f.object_key FROM attachments f JOIN attachment_links l ON l.attachment_id=f.id JOIN issues i ON i.id=l.issue_id AND i.app_id=f.app_id WHERE f.app_id=? AND f.id=? AND f.name=?",
        s.app,
        id,
        name
      ).first<AttachmentRow & { object_key: string }>()) ?? missing()
    return serveFile(c, file, true)
  }
  if ((c.req.method === "GET" || c.req.method === "HEAD") && c.req.query("sig") !== undefined) {
    c.header("Referrer-Policy", "no-referrer")
    c.header("Cache-Control", "private, max-age=0, must-revalidate")
    await enforce(c, "RL_V1_IP", "v1:media:" + clientIP(c))
    const r = await serveFile(c, await signedFile(c, id, name), true)
    r.headers.set("Referrer-Policy", "no-referrer")
    r.headers.set("Cache-Control", "private, max-age=0, must-revalidate")
    return r
  }
  if(c.req.method==='OPTIONS'){
    checkHost(c)
    const origin = c.req.header("Origin")
    if(!origin||c.req.header('Access-Control-Request-Method')!=='GET')missing()
    if (!(await preflightAllowed(c, origin))) missing()
    cors(c, origin)
    c.header("Access-Control-Allow-Headers", "Authorization, Range, If-None-Match")
    c.header("Access-Control-Allow-Methods", "GET")
    c.header("Access-Control-Max-Age", "86400")
    return c.body(null, 204)
  }
  if(!/^Bearer bh_us_/i.test(c.req.header('Authorization')??''))return next()
  await enforce(c, "RL_V1_IP", "v1:media:" + clientIP(c))
  const s = await authorize(c, "session")
  const file=await sql(c.env,`SELECT f.name,f.mime,f.kind,f.size,f.object_key FROM attachments f JOIN attachment_links l ON l.attachment_id=f.id JOIN issues i ON i.id=l.issue_id AND i.app_id=f.app_id LEFT JOIN comments m ON m.id=l.comment_id AND m.issue_id=i.id WHERE f.app_id=? AND f.id=? AND f.name=? AND i.hidden IS NULL AND json_extract(i.author,'$.id')=? AND (l.comment_id IS NULL OR (m.internal=0 AND m.hidden IS NULL))`,s.app,id,name,s.user!.id).first<AttachmentRow&{object_key:string}>()??missing()
  const r=await serveFile(c,file,true);if(s.origin){r.headers.set('Access-Control-Allow-Origin',s.origin);r.headers.set('Vary','Origin')}return r
}
function range(value: string, size: number) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!m || (!m[1] && !m[2])) return null
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])),
    end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= end && start < size
    ? { offset: start, length: end - start + 1 }
    : null
}
media.get("/media/:id/:name", async (c) => {
  c.header("Cache-Control", "private, no-store")
  if (c.req.param("id").startsWith("ml_")) {
    const id = c.req.param("id"),
      slug =
        (await sql(
          c.env,
          "SELECT a.slug FROM report_logs l JOIN report_metadata m ON m.id=l.metadata_id JOIN apps a ON a.id=m.app_id WHERE l.id=?",
          id
        ).first<string>("slug")) ?? missing()
    const { viewer, app } = await viewerApp(c, slug)
    if (c.req.header("Authorization")) {
      const agent = await authenticate(c)
      if (!agent?.apps.some((a) => a.id === app.id)) missing()
      viewer.team = true
      viewer.actorId = agent.actor.id
    }
    const file = await reportLog(c.env, id, app.id, viewer, c.req.query("metadata"))
    if (!file || file.name !== c.req.param("name")) missing()
    return serveFile(c, { ...file, kind: "file", mime: "text/plain" }, true)
  }
  const a = await sql(
    c.env,
    `SELECT a.id,a.name,a.mime,a.size,a.kind,a.object_key,a.owner_id,a.app_id,app.slug,l.issue_id,i.private,i.hidden,c.internal,
     json_extract(i.author,'$.id') reporter,c.hidden comment_hidden FROM attachments a JOIN apps app ON app.id=a.app_id
     LEFT JOIN attachment_links l ON l.attachment_id=a.id LEFT JOIN issues i ON i.id=l.issue_id LEFT JOIN comments c ON c.id=l.comment_id WHERE a.id=?`,
    c.req.param("id")
  ).first<
    AttachmentRow & {
      object_key: string
      slug: string
      app_id: string
      owner_id: string
      issue_id: string | null
      private: number
      hidden: string | null
      comment_hidden: string | null
      internal: number | null
      reporter: string
    }
  >()
  if (!a || a.name !== c.req.param("name")) missing()
  const restricted = !a.issue_id || !!a.private || !!a.hidden || !!a.comment_hidden || !!a.internal
  if (restricted) {
    const { viewer } = await viewerApp(c, a.slug)
    if (c.req.header("Authorization")) {
      const agent = await authenticate(c)
      if (!agent?.apps.some((app) => app.id === a.app_id)) missing()
      viewer.team = true
      viewer.actorId = agent.actor.id
    }
    if (
      !a.issue_id
        ? !viewer.team && viewer.actorId !== a.owner_id
        : !sees(viewer, { private: !!a.private, hidden: !!a.hidden, reporter: a.reporter }) ||
          !seesComment(viewer, a.comment_hidden) ||
          (!!a.internal && !viewer.team)
    )
      missing()
  }
  return serveFile(c, a, restricted)
})
async function serveFile(
  c: Ctx,
  a: Pick<AttachmentRow, "name" | "mime" | "kind" | "size"> & { object_key: string },
  restricted: boolean
) {
  const size = a.size,
    requested = c.req.header("range"),
    slice = requested ? range(requested, a.size) : null,
    validator = c.req.header("If-None-Match")
  function unsatisfiable() {
    c.header("Content-Range", `bytes */${size}`)
    c.header("Accept-Ranges", "bytes")
    return c.json({ error: { code: "invalid_range", message: "Range not satisfiable" } }, 416)
  }
  if (requested && !slice && !validator) return unsatisfiable()
  const obj = await c.env.MEDIA.get(a.object_key, {
    ...(slice && { range: slice }),
    ...(validator && { onlyIf: new Headers({ "If-None-Match": validator }) })
  })
  if (!obj) missing()
  const cache = {
    "Cache-Control": restricted ? "private, no-store" : "public, max-age=31536000, immutable",
    ETag: obj.httpEtag
  }
  if (!("body" in obj)) return new Response(null, { status: 304, headers: cache })
  if (requested && !slice) {
    await obj.body.cancel()
    return unsatisfiable()
  }
  const inline = a.kind === "video" || (a.kind === "image" && !/svg/i.test(a.mime)),
    safe = encodeURIComponent(a.name).replace(/['()*]/g, (s) => "%" + s.charCodeAt(0).toString(16))
  const headers = new Headers({
    "Content-Type": a.mime,
    "Content-Length": String(slice?.length ?? a.size),
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${safe}`,
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    ...cache,
    "Content-Security-Policy": "sandbox; default-src 'none'"
  })
  if (slice) headers.set("Content-Range", `bytes ${slice.offset}-${slice.offset + slice.length - 1}/${a.size}`)
  return new Response(obj.body, { headers, status: slice ? 206 : 200 })
}
