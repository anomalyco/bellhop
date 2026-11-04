import { bad, fail, hex, now, sql, uid, type Ctx } from "../core"
import { chunked, uploadSpec } from "../media"
import { enforce } from "../rate-limits"
import { apiOrigin, liveGuard, type Scope } from "./access"
import { signedFiles } from "./signed-media"
import { replay } from "./replay"

const enc = new TextEncoder(),
  maxHeaders = 16384
const joined = (a: Uint8Array, b: Uint8Array) => {
  const v = new Uint8Array(a.length + b.length)
  v.set(a)
  v.set(b, a.length)
  return v
}
function index(buf: Uint8Array, needle: Uint8Array, offset = 0) {
  for (
    let at = buf.indexOf(needle[0]!, offset);
    at >= 0 && at + needle.length <= buf.length;
    at = buf.indexOf(needle[0]!, at + 1)
  ) {
    if (needle.every((v, i) => buf[at + i] === v)) return at
  }
  return -1
}
// formData() buffers the entire request. Read exactly one `file` part, retaining
// only the header or a delimiter-sized tail across transport chunks.
async function filePart(c: Ctx) {
  const m =
    /^multipart\/form-data\s*;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=? -]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))\s*$/i.exec(
      c.req.header("Content-Type") ?? ""
    )
  if (!m) fail(415, "expected_multipart", "Expected multipart/form-data with one file")
  const boundary = m[1] ?? m[2]!,
    reader = c.req.raw.body?.getReader() ?? bad("Empty upload"),
    separator = enc.encode("\r\n\r\n"),
    marker = enc.encode("\r\n--" + boundary)
  let buf: Uint8Array = new Uint8Array(),
    at = -1
  try {
    while ((at = index(buf, separator)) < 0) {
      if (buf.length > maxHeaders) bad("Multipart headers too large")
      const r = await reader.read()
      if (r.done) bad("Incomplete multipart upload")
      buf = joined(buf, r.value)
    }
    if (at > maxHeaders) bad("Multipart headers too large")
    const [first, ...lines] = new TextDecoder().decode(buf.subarray(0, at)).split("\r\n")
    if (first !== "--" + boundary) bad("Invalid multipart boundary")
    let name: string | undefined, mime: string | undefined
    for (const line of lines) {
      const disposition = /^content-disposition:\s*form-data;\s*name="file";\s*filename="([^"\r\n]+)"\s*$/i.exec(line),
        type = /^content-type:\s*(.+)$/i.exec(line)
      if (disposition && name === undefined) name = disposition[1]
      else if (type && mime === undefined) mime = type[1]
      else bad("Expected one multipart file")
    }
    const spec = uploadSpec(name, mime ?? "application/octet-stream")
    buf = buf.subarray(at + 4)
    async function* chunks() {
      try {
        for (;;) {
          let from = 0,
            found = false
          for (;;) {
            const i = index(buf, marker, from)
            if (i < 0 || i + marker.length + 2 > buf.length) break
            const p = i + marker.length
            if (buf[p] === 13 && buf[p + 1] === 10) bad("Only one multipart file is accepted")
            if (buf[p] === 45 && buf[p + 1] === 45) {
              if (i) yield buf.subarray(0, i)
              buf = buf.subarray(p + 2)
              found = true
              break
            }
            from = i + 1
          }
          if (found) {
            for (;;) {
              if (buf.length > 2) bad("Unexpected multipart data")
              const r = await reader.read()
              if (r.done) break
              buf = joined(buf, r.value)
            }
            if (buf.length && !(buf.length === 2 && buf[0] === 13 && buf[1] === 10)) bad("Invalid multipart ending")
            return
          }
          const split = Math.max(0, buf.length - marker.length - 4)
          if (split) yield buf.subarray(0, split)
          buf = buf.slice(split)
          const r = await reader.read()
          if (r.done) bad("Incomplete multipart upload")
          buf = joined(buf, r.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
    const it = chunks(),
      stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const n = await it.next()
            if (n.done) controller.close()
            else controller.enqueue(n.value)
          } catch (e) {
            controller.error(e)
          }
        },
        async cancel() {
          await it.return(undefined)
        }
      })
    return { spec, stream }
  } catch (e) {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
    throw e
  }
}
export async function upload(c: Ctx, s: Scope) {
  const env = c.env,
    who = s.user!.id
  await enforce(c, "RL_UPLOAD", "v1:upload:" + s.hash)
  if (await sql(env, "SELECT 1 FROM blocks WHERE app_id=? AND actor_id=?", s.app, who).first())
    fail(403, "blocked", "Blocked from writing")
  if (
    await sql(
      env,
      "SELECT 1 FROM attachments WHERE owner_id=? AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hour') LIMIT 1 OFFSET 39",
      who
    ).first()
  )
    fail(429, "rate_limited", "Hourly upload limit reached")
  const { spec, stream } = await filePart(c),
    id = uid(),
    object = `${s.app}/${id}`,
    digest = new crypto.DigestStream("SHA-256")
  digest.digest.catch(() => {})
  await sql(env, "INSERT INTO api_upload_gc VALUES(?,unixepoch()+86400)", object).run()
  let claimed = false
  let first = true
  async function admit(part: Uint8Array) {
    if (first && spec.kind === "video") {
      const ascii = (offset: number, len: number) => String.fromCharCode(...part.subarray(offset, offset + len))
      const container =
        (part.length >= 12 && ascii(4, 4) === "ftyp") ||
        (ascii(0, 4) === "RIFF" && ascii(8, 4) === "AVI ") ||
        (part[0] === 0x1a &&
          part[1] === 0x45 &&
          part[2] === 0xdf &&
          part[3] === 0xa3 &&
          /webm|matroska/.test(ascii(4, 512))) ||
        (ascii(0, 4) === "OggS" && ascii(4, 256).includes("theora"))
      if (!container) fail(415, "unsupported_video", "Unknown video container")
    }
    first = false
    const charge = (scope: string) =>
      sql(
        env,
        "INSERT INTO api_upload_bytes VALUES(?,date('now'),?,?) ON CONFLICT(app_id,day,scope) DO UPDATE SET bytes=bytes+excluded.bytes",
        s.app,
        scope,
        part.length
      )
    // Charge each admitted R2 part, including interrupted streams and retries. A
    // failed budget check rolls back both counters before those bytes reach storage.
    await env.DB.batch([liveGuard(c, s), charge("workspace"), charge(s.hash)])
  }
  try {
    const size = await chunked(env.MEDIA, object, stream, spec.mime, spec.limit, digest.getWriter(), admit),
      fingerprint = JSON.stringify([spec.name, spec.mime, size, hex(await digest.digest)])
    return await replay(c, s, "/v1/uploads", fingerprint, async () => {
      await env.DB.batch([
        liveGuard(c, s),
        sql(
          env,
          "INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?)",
          id,
          s.app,
          who,
          object,
          spec.name,
          spec.mime,
          size,
          spec.kind,
          now()
        ),
        sql(env, "INSERT INTO api_pending_uploads VALUES(?,unixepoch()+86400)", id),
        sql(env, "DELETE FROM api_upload_gc WHERE object_key=?", object)
      ])
      claimed = true
      const [file] = await signedFiles({ env, app: s.app, who, origin: apiOrigin(c) }, [
        { id, name: spec.name, type: spec.mime, size }
      ])
      return c.json(file!, 201)
    })
  } finally {
    if (!claimed) {
      await env.MEDIA.delete(object)
      await sql(env, "DELETE FROM api_upload_gc WHERE object_key=?", object).run()
    }
  }
}
export async function sweepUploads(env: Env) {
  await sql(env, "DELETE FROM api_upload_bytes WHERE day<date('now')").run()
  const [, rs] = await env.DB.batch<{ object_key: string }>([
    sql(
      env,
      `DELETE FROM attachments WHERE id IN(SELECT id FROM api_pending_uploads WHERE expires<=unixepoch() AND NOT EXISTS(SELECT 1 FROM attachment_links WHERE attachment_id=api_pending_uploads.id) LIMIT 100)`
    ),
    sql(env, "SELECT object_key FROM api_upload_gc WHERE due<=unixepoch() LIMIT 100")
  ])
  const keys = rs!.results.map((r) => r.object_key)
  if (keys.length) {
    await env.MEDIA.delete(keys)
    await sql(
      env,
      "DELETE FROM api_upload_gc WHERE object_key IN(SELECT value FROM json_each(?))",
      JSON.stringify(keys)
    ).run()
  }
}
