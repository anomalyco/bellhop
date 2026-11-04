import { Hono } from "hono"
import type { Bindings, Ctx } from "./core"

// Stable URLs for the embeddable chat widget and the public SDK:
//   /widget/v1.js  a tiny loader: installs the `Bellhop` call queue, then loads the content-hashed widget bundle
//   /sdk/v1.js     the SDK as one ES module (import { createClient } from "https://blhp.app/sdk/v1.js")
// The loaders change with each deploy and only the current build's hashed bundles exist, so they cache briefly
// (60 s, then 5 minutes stale while revalidating) and the widget loader recovers if its bundle is gone: it fetches
// itself again once with a cache-buster. The hashed bundles under /assets/ are immutable. Both are readable
// cross-origin. vite.config.ts records the hashed names in index.html.
export const widget = new Hono<Bindings>()

const vite = (c: Ctx) => c.env.DEV_LOGIN === "1" && !c.env.APP_DOMAIN
const origin = (c: Ctx) => (c.env.APP_DOMAIN ? `https://${c.env.APP_DOMAIN}` : new URL(c.req.url).origin)
const apiBase = (c: Ctx) => (c.env.APP_DOMAIN ? `https://api.${c.env.APP_DOMAIN}/v1` : `${new URL(c.req.url).origin}/v1`)

let hints: Promise<Record<string, string>> | null = null
function bundles(c: Ctx): Promise<Record<string, string>> {
  hints ??= c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), { headers: { Accept: "text/html" } }))
    .then((r) => r.text())
    .then((html) => {
      const found = Object.fromEntries([...html.matchAll(/<link data-bh-preload="(widget|sdk)-script" href="([^"]+)">/g)].map((m) => [m[1]!, m[2]!]))
      if (!found.widget || !found.sdk) {
        if (!vite(c)) console.error("bellhop.embed_assets_missing")
        hints = null
      }
      return found
    })
  return hints
}

function headers(c: Ctx, dev = false) {
  c.header("Content-Type", "text/javascript; charset=utf-8")
  c.header("Cache-Control", dev ? "no-store" : "public, max-age=60, stale-while-revalidate=300")
  c.header("Access-Control-Allow-Origin", "*")
  c.header("Cross-Origin-Resource-Policy", "cross-origin")
  c.header("X-Content-Type-Options", "nosniff")
}

widget.get("/widget/v1.js", async (c) => {
  // The hashed classic-script bundle from a build; under the Vite dev server (no build), the source module graph.
  const built = (await bundles(c)).widget
  const dev = !built && vite(c)
  const src = built ?? (dev ? `${origin(c)}/src/widget/main.ts` : null)
  if (!src) return c.text("// Widget unavailable", 503, { "Cache-Control": "no-store" })
  const config = { apiBase: apiBase(c), turnstileSiteKey: c.env.TURNSTILE_SITE_KEY || undefined }
  headers(c, dev)
  return c.body(`/* Chat widget loader v1 */
(function () {
  var w = window, d = document, s = d.currentScript, b = (w.Bellhop = w.Bellhop || {})
  if (b.version) return
  b.q = b.q || []
  ;["init", "identify", "open", "close", "toggle", "newConversation", "on", "logout"].forEach(function (m) {
    b[m] = b[m] || function () { b.q.push([m, [].slice.call(arguments)]) }
  })
  var c = (b._c = b._c || ${JSON.stringify(config)})
  if (s) ["key", "locale", "theme", "position"].forEach(function (k) { var v = s.getAttribute("data-" + k); if (v) c[k] = v })
  if (b._loading) return
  b._loading = 1
  var e = d.createElement("script")
  e.src = ${JSON.stringify(src.startsWith("http") ? src : origin(c) + src)}
  e.async = true
  ${dev ? 'e.type = "module"' : ""}
  // A cached loader can outlive its bundle after a deploy: fetch a fresh loader once, which loads the current one.
  // Also when the "bundle" loaded but didn't start (a fallback page served in its place).
  e.onload = function () {
    if (!(w.Bellhop && w.Bellhop.version)) e.onerror()
  }
  e.onerror = function () {
    if (b._retried) return
    b._retried = 1
    b._loading = 0
    var r = d.createElement("script")
    r.src = ${JSON.stringify(origin(c) + "/widget/v1.js")} + "?r=" + Date.now()
    r.async = true
    ;(d.head || d.documentElement).appendChild(r)
  }
  ;(d.head || d.documentElement).appendChild(e)
})()
`)
})

widget.get("/sdk/v1.js", async (c) => {
  const file = (await bundles(c)).sdk
  if (!file && vite(c)) {
    headers(c, true)
    return c.body(`export * from ${JSON.stringify(origin(c) + "/src/sdk/index.ts")}\n`)
  }
  const res = file ? await c.env.ASSETS.fetch(new Request(new URL(file, c.req.url))) : null
  if (!res?.ok) return c.text("// SDK unavailable", 503, { "Cache-Control": "no-store" })
  headers(c)
  return c.body(await res.text())
})
