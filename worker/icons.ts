import { Hono } from "hono"
import { detail } from "./apps"
import { fail, missing, sql, uid } from "./core"
import { requireTeam } from "./permissions"
import type { Bindings, Ctx } from "./core"

const maxSize = 1024 * 1024
const iconKey = (app: string, version: string) => `${app}/icons/${version}`
const tooLarge = () => fail(413, "too_large", "App icons must be 1 MB or smaller")
const unsupported = () => fail(415, "unsupported_media_type", "Use a PNG, JPEG, or WebP image with its matching Content-Type")

function imageType(bytes: Uint8Array) {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4))
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) && tag(12) === "IHDR") return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (tag(0) === "RIFF" && tag(8) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(tag(12))) return "image/webp"
  return null
}

async function readIcon(c: Ctx) {
  const oversized = Number(c.req.header("content-length")) > maxSize
  const mime = c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  const stream = c.req.raw.body
  if (!stream) return oversized ? tooLarge() : unsupported()
  // Drain rejected bodies without retaining them so the transport can finish its error response.
  // Count actual bytes even without Content-Length (chunked uploads).
  const reader = stream.getReader()
  const buffer = !oversized && mime && ["image/png", "image/jpeg", "image/webp"].includes(mime) ? new Uint8Array(maxSize) : null
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (buffer && size + value.length <= maxSize) buffer.set(value, size)
      size += value.length
    }
  } finally {
    reader.releaseLock()
  }
  if (oversized || size > maxSize) return tooLarge()
  if (!buffer || !mime) return unsupported()
  const bytes = buffer.subarray(0, size)
  if (imageType(bytes) !== mime) return unsupported()
  return { bytes, mime }
}

async function replaceIcon(c: Ctx, image: Awaited<ReturnType<typeof readIcon>> | null) {
  const app = c.var.app, version = image ? uid() : null
  if (image && version) await c.env.MEDIA.put(iconKey(app.id, version), image.bytes, { httpMetadata: { contentType: image.mime } })
  // Swap the D1 pointer and capture its previous value in one transaction. Concurrent uploads
  // each delete only the version they displaced, never bytes behind a still-current URL.
  let previous: string | null
  try {
    const [result] = await c.env.DB.batch<{ icon_version: string | null }>([
      sql(c.env, "SELECT icon_version FROM apps WHERE id=?", app.id),
      sql(c.env, "UPDATE apps SET icon_version=?,icon_mime=? WHERE id=?", version, image?.mime ?? null, app.id)
    ])
    previous = result!.results[0]!.icon_version
  } catch (error) {
    if (version) await c.env.MEDIA.delete(iconKey(app.id, version))
    throw error
  }
  if (previous) await c.env.MEDIA.delete(iconKey(app.id, previous))
  c.set("app", { ...app, icon_url: version ? `/icon/${app.slug}/${version}` : null })
  return c.json(await detail(c))
}

export const icons = new Hono<Bindings>()
icons.put("/api/apps/:slug/icon", async (c) => {
  requireTeam(c, "setup")
  return replaceIcon(c, await readIcon(c))
})
icons.delete("/api/apps/:slug/icon", (c) => {
  requireTeam(c, "setup")
  return replaceIcon(c, null)
})
icons.get("/icon/:slug/:version", async (c) => {
  const { slug, version } = c.req.param()
  const app = await sql(c.env, "SELECT id,icon_mime FROM apps WHERE slug=? AND icon_version=?", slug, version)
    .first<{ id: string; icon_mime: string }>()
  if (!app) missing()
  const icon = await c.env.MEDIA.get(iconKey(app.id, version))
  if (!icon) missing()
  return c.body(icon.body, 200, {
    "Content-Type": app.icon_mime,
    "Content-Length": String(icon.size),
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cache-Control": "public, max-age=31536000, immutable"
  })
})
