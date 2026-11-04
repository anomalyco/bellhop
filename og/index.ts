import { render } from "@cf-wasm/og/workerd"
import mono from "./fonts/OpenTUIMono-Bold.ttf"
import inter from "./fonts/Inter-Latin.ttf"
import jacket from "../brand/bellhop-mark.svg"
import type { PreviewCard } from "../worker/previews"
import type { ReactNode } from "react"

const fonts = [
  { name: "OpenTUI", data: mono, weight: 700 as const },
  { name: "Inter", data: inter, weight: 400 as const }
]
const monoFace = { fontFamily: "OpenTUI", fontWeight: 700 }
const clamp = (lines: number) => ({
  display: "block",
  lineClamp: lines,
  overflow: "hidden",
  textOverflow: "ellipsis",
  wordBreak: "break-word"
})
const styles = {
  open: ["Open", "#76daa2"],
  in_progress: ["In progress", "#88acff"],
  waiting: ["Waiting", "#eac47c"],
  closed: ["Closed", "#bcb4d2"]
} as const
type Style = Record<string, string | number>
const el = (type: string, props: Record<string, unknown>) => ({ type, key: null, props })
const box = (style: Style, ...children: ReactNode[]) =>
  el("div", { style: { display: "flex", ...style }, children: children.length === 1 ? children[0] : children })
const text = (s: string, style: Style) => el("div", { style, children: s })
const dataSvg = (s: string) => `data:image/svg+xml;base64,${btoa(s)}`
const mark = dataSvg(jacket.replace("#f2f2f2", "#ffffff"))

// Uploads are at most 1 MiB, but compressed icons can declare enormous decoded dimensions.
// Only hand bounded PNG/JPEGs to the rasterizer. WebP uses the jacket; uploads stay untouched.
function dimensions(bytes: Uint8Array, mime: string) {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (mime === "image/png" && bytes.length >= 24) return [d.getUint32(16), d.getUint32(20)] as const
  if (mime === "image/jpeg")
    for (let i = 2; i + 9 < bytes.length;) {
      if (bytes[i++] !== 255) break
      const m = bytes[i++]!
      if (m === 255) {
        i--
        continue
      }
      if (m === 0xda || m === 0xd9) break
      if ([0xc0, 0xc1, 0xc2].includes(m)) return [d.getUint16(i + 5), d.getUint16(i + 3)] as const
      const len = d.getUint16(i)
      if (len < 2) break
      i += len
    }
  return [0, 0] as const
}
async function iconSource(env: { MEDIA: R2Bucket }, c: PreviewCard) {
  if (!c.icon) return mark
  const r = await env.MEDIA.get(`${c.appId}/icons/${c.icon}`)
  if (!r) return mark
  const mime = r.httpMetadata?.contentType ?? ""
  if (r.size > 1024 * 1024 || !["image/png", "image/jpeg"].includes(mime)) {
    await r.body.cancel()
    return mark
  }
  const bytes = new Uint8Array(await r.arrayBuffer()),
    [w, h] = dimensions(bytes, mime)
  if (!w || !h || w * h > 4_194_304) return mark
  let binary = ""
  for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384))
  return `data:${mime};base64,${btoa(binary)}`
}

const dot = (color: string) => box({ width: 10, height: 10, borderRadius: 5, background: color, flexShrink: 0 })
const tile = (src: string, size: number) =>
  el("img", {
    src,
    width: size,
    height: size,
    style: { borderRadius: Math.round((size * 16) / 72), objectFit: "cover" }
  })
function design(c: PreviewCard, icon: string) {
  const host = c.slug ? `${c.slug}.blhp.app` : "blhp.app"
  const identity = box(
    { alignItems: "center", gap: 22 },
    tile(icon, c.kind === "issue" ? 72 : 108),
    box(
      { flexDirection: "column", gap: 5, width: 875 },
      text(c.name, { ...monoFace, fontSize: 32, ...clamp(1) }),
      text(host, { fontSize: 23, color: "#a2a2a2" })
    )
  )
  let body: ReactNode,
    foot: ReactNode = null
  if (c.kind === "issue" && c.status) {
    body = box(
      { flexDirection: "column", gap: 14 },
      text(c.title, { ...monoFace, fontSize: 58, lineHeight: 1.09, letterSpacing: -1.9, ...clamp(3) }),
      text(`#${c.number}`, { ...monoFace, fontSize: 29, color: "#a2a2a2" })
    )
    const [status, color] = styles[c.status]
    const chip = (color: string, name: string, state = false) =>
      box(
        {
          alignItems: "center",
          gap: 10,
          padding: "9px 15px",
          borderRadius: 24,
          background: state ? "#282c2b" : "#242424",
          border: "1px solid #353535",
          color: state ? color : "#dedede",
          fontSize: 21
        },
        dot(color),
        text(name, { maxWidth: 138, ...clamp(1) })
      )
    foot = box(
      { alignItems: "center", justifyContent: "space-between", gap: 20 },
      box(
        { gap: 8, alignItems: "center" },
        chip(color, status, true),
        ...c.labels.slice(0, 3).map((l) => chip(`#${l.color}`, l.name))
      ),
      c.agent
        ? box(
            { alignItems: "center", gap: 10 },
            text(`Answered by ${c.agent}`, { maxWidth: 264, fontSize: 20, color: "#c4c4c4", ...clamp(1) }),
            box(
              {
                ...monoFace,
                fontSize: 16,
                padding: "3px 7px",
                borderRadius: 5,
                background: "#2d3144",
                color: "#aebcff"
              },
              "AI"
            )
          )
        : null
    )
  } else {
    body = box(
      { flexDirection: "column", gap: 16 },
      // The header already says "Bellhop", so the home card leads with what it is.
      text(c.kind === "home" ? "Live support for your product" : `${c.name} support`, {
        ...monoFace,
        fontSize: 76,
        lineHeight: 1.05,
        letterSpacing: -2.8,
        ...clamp(2)
      }),
      text(c.kind === "home" ? "Your agent answers issues as they come in." : c.description.slice(0, 350), {
        fontSize: 37,
        color: "#bdbdbd",
        lineHeight: 1.2,
        ...clamp(3)
      })
    )
  }
  return box(
    {
      width: 1200,
      height: 630,
      padding: 64,
      flexDirection: "column",
      justifyContent: "space-between",
      backgroundColor: "#161616",
      color: "#fff",
      fontFamily: "Inter"
    },
    identity,
    body,
    foot
  )
}
export default {
  async fetch(req: Request, env: { MEDIA: R2Bucket }): Promise<Response> {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/render") return new Response(null, { status: 404 })
    const card = await req.json<PreviewCard>()
    const src = await iconSource(env, card)
    const png = await render(design(card, src), {
      width: 1200,
      height: 630,
      fonts,
      defaultFont: { data: inter },
      emoji: "twemoji",
      // Resolve only Twemoji glyphs. Do not send text from a post to external font services.
      loadAdditionalAsset: (language, _segment, next) => (language === "emoji" ? next() : [])
    }).asPng()
    return new Response(png.image, { headers: { "Content-Type": "image/png" } })
  }
}
