import { Hono, type MiddlewareHandler } from "hono"
import { sha256 } from "./core"
import type { Bindings, Ctx } from "./core"
import { docPages, type DocPage } from "./docs-content"
import { OG_DESIGN_VERSION, type PreviewCard } from "./previews"
import icon192 from "../src/docs/icon-192.png?inline"
import icon512 from "../src/docs/icon-512.png?inline"

// Public developer docs at https://blhp.app/docs: server-rendered HTML with no app JavaScript,
// plus Markdown twins, /llms.txt and /llms-full.txt. Nothing here depends on the viewer, so
// responses are publicly cacheable for a few minutes (short, so a deploy shows up quickly).
export const docs = new Hono<Bindings>()

const cacheable = "public, max-age=300"
const xml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")
const origin = (c: Ctx) =>
  c.env.APP_DOMAIN ? `https://${c.env.APP_DOMAIN}` : new URL(c.env.PUBLIC_ORIGIN || c.req.url).origin
const vite = (c: Ctx) => c.env.DEV_LOGIN === "1" && !c.env.APP_DOMAIN
const markdownUrl = (o: string, p: DocPage) => `${o}/docs/${p.slug}.md`
/** Root-relative links read fine in the browser; Markdown copies get absolute ones. */
const absolute = (o: string, markdown: string) => markdown.replace(/\]\(\//g, `](${o}/`)

// Docs live on the apex only. Workspace hosts send every docs URL there.
const apexOnly: MiddlewareHandler<Bindings> = async (c, next) => {
  const domain = c.env.APP_DOMAIN,
    url = new URL(c.req.url)
  if (domain && url.hostname !== domain && url.hostname.endsWith(`.${domain}`))
    return c.redirect(`https://${domain}${url.pathname}${url.search}`, 301)
  await next()
}
for (const path of ["/docs", "/docs/*", "/llms.txt", "/llms-full.txt", "/og/docs/*"]) docs.use(path, apexOnly)

// Vite builds docs.css and docs.ts with hashed names; vite.config.ts records them in index.html
// as inert <link data-bh-preload="docs-style|docs-script"> hints. The Vite dev server serves sources.
let built: Promise<{ style: string | null; script: string | null }> | null = null
function assets(c: Ctx) {
  if (vite(c)) return Promise.resolve({ style: "/src/styles/docs.css", script: "/src/docs/main.ts" })
  built ??= c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), { headers: { Accept: "text/html" } }))
    .then((r) => r.text())
    .then((html) => {
      const hint = (kind: string) =>
        new RegExp(`<link data-bh-preload="${kind}" href="([^"]+)">`).exec(html)?.[1] ?? null
      const found = { style: hint("docs-style"), script: hint("docs-script") }
      if (!found.style) {
        console.error("bellhop.docs_assets_missing")
        built = null
      }
      return found
    })
  return built
}

const policy = [
  "default-src 'self'",
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://cloudflareinsights.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'"
].join("; ")
function headers(c: Ctx, type: string) {
  c.header("Content-Type", type)
  c.header("Cache-Control", cacheable)
  c.header("X-Content-Type-Options", "nosniff")
  if (type.startsWith("text/html")) {
    c.header("Content-Security-Policy", policy)
    c.header("Referrer-Policy", "strict-origin-when-cross-origin")
  }
}

const ogVersion = async (p: DocPage) => (await sha256(`${p.title}\n${OG_DESIGN_VERSION}`)).slice(0, 8)
const jsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c")

async function render(c: Ctx, page: DocPage | null) {
  const pages = docPages(),
    o = origin(c),
    { style, script } = await assets(c)
  const title = page ? (page.slug === "index" ? page.title : `${page.title} · Bellhop docs`) : "Page not found · Bellhop docs"
  const description = page?.description ?? "This page isn't part of the Bellhop developer docs."
  const canonical = page ? `${o}${page.path}` : null
  const image = page ? `${o}/og/docs/${page.slug}.png?v=${await ogVersion(page)}` : null
  const meta = (k: string, v: string) =>
    `<meta ${k.startsWith("og:") ? "property" : "name"}="${k}" content="${xml(v)}">`
  const head = [
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${xml(title)}</title>`,
    meta("description", description),
    `<meta name="theme-color" content="#161616">`,
    `<link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
    `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
    `<link rel="manifest" href="/docs/site.webmanifest">`,
    `<link rel="preload" href="/fonts/InterVariable-Latin.woff2" as="font" type="font/woff2" crossorigin>`,
    `<link rel="preload" href="/fonts/OpenTUIMono-Regular.woff2" as="font" type="font/woff2" crossorigin>`,
    style ? `<link rel="stylesheet" href="${xml(style)}">` : "",
    script ? `<script type="module" src="${xml(script)}"></script>` : ""
  ]
  if (page && canonical && image) {
    head.push(
      `<link rel="canonical" href="${xml(canonical)}">`,
      `<link rel="alternate" type="text/markdown" href="${xml(markdownUrl(o, page))}">`,
      `<link rel="describedby" href="${xml(`${o}/llms.txt`)}">`,
      meta("og:site_name", "Bellhop"),
      meta("og:type", "website"),
      meta("og:title", title),
      meta("og:description", description),
      meta("og:url", canonical),
      meta("og:image", image),
      meta("og:image:type", "image/png"),
      meta("og:image:width", "1200"),
      meta("og:image:height", "630"),
      meta("og:image:alt", title),
      meta("og:locale", "en_US"),
      meta("twitter:card", "summary_large_image"),
      meta("twitter:title", title),
      meta("twitter:description", description),
      meta("twitter:image", image),
      meta("twitter:image:alt", title)
    )
    const site = { "@type": "WebSite", "@id": `${o}/#website`, name: "Bellhop", url: `${o}/` }
    const webPage = {
      "@type": "WebPage",
      "@id": canonical,
      url: canonical,
      name: title,
      description,
      inLanguage: "en",
      isPartOf: page.slug === "index" ? { "@id": site["@id"] } : site
    }
    const graph = page.slug === "index" ? [site, webPage] : [webPage]
    head.push(
      `<script type="application/ld+json">${jsonLd({ "@context": "https://schema.org", "@graph": graph })}</script>`
    )
  } else head.push(meta("robots", "noindex"))

  const nav = pages
    .map((p) => {
      const current = p.slug === page?.slug
      const sub =
        current && p.headings.length
          ? `<ul class="sub">${p.headings.map((h) => `<li><a href="#${xml(h.id)}">${xml(h.text)}</a></li>`).join("")}</ul>`
          : ""
      return `<li><a href="${p.path}"${current ? ` aria-current="page"` : ""}>${xml(p.nav)}</a>${sub}</li>`
    })
    .join("")
  const body = page
    ? page.html
    : `<h1>Page not found</h1><p>There's no docs page at this address. Try the <a href="/docs">overview</a>.</p>`
  const footer = [
    page ? `<a href="${xml(`/docs/${page.slug}.md`)}">View as Markdown</a>` : "",
    `<a href="/llms.txt">llms.txt</a>`,
    `<a href="/">Bellhop</a>`
  ]
    .filter(Boolean)
    .join("")
  return `<!doctype html>
<html lang="en">
<head>
${head.filter(Boolean).join("\n")}
</head>
<body>
<a class="skip" href="#content">Skip to content</a>
<header class="top">
<a class="brand" href="/"><img src="/favicon.svg" alt="" width="20" height="20">Bellhop</a>
<span class="slash" aria-hidden="true">/</span>
<a class="section" href="/docs">Docs</a>
</header>
<div class="layout">
<nav class="side" aria-label="Docs"><p class="label">Developers</p><ul>${nav}</ul></nav>
<main id="content">
<article class="prose">
${body}</article>
<footer class="foot">${footer}</footer>
</main>
</div>
</body>
</html>
`
}

docs.get("/docs", async (c) => {
  headers(c, "text/html; charset=utf-8")
  return c.body(await render(c, docPages()[0]!))
})
docs.get("/docs/sitemap.xml", (c) => {
  const o = origin(c)
  headers(c, "application/xml; charset=utf-8")
  const urls = docPages()
    .map((p) => `<url><loc>${xml(o + p.path)}</loc></url>`)
    .join("")
  return c.body(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`
  )
})
// /llms.txt covers the whole site; /docs/llms.txt is the same file, at the docs base where tools look.
docs.get("/llms.txt", (c) => llmsIndex(c))
docs.get("/docs/llms.txt", (c) => llmsIndex(c))
function llmsIndex(c: Ctx) {
  const o = origin(c),
    pages = docPages()
  headers(c, "text/plain; charset=utf-8")
  return c.body(`# Bellhop

> Bellhop gives each product a live support site at https://<slug>.blhp.app, where people report issues and agents answer them. These docs cover what developers can build on it: report metadata uploads from apps, agents over MCP, webhooks, and Atom feeds, oEmbed and preview images.

Every page is Markdown. ${o}/llms-full.txt has all of them in one file.

## Docs

${pages.map((p) => `- [${p.nav}](${markdownUrl(o, p)}): ${p.description}`).join("\n")}

## Endpoints

- [MCP server](${o}/mcp): Streamable HTTP; sign in with OAuth or a token agent.
- [OAuth authorization server metadata](${o}/.well-known/oauth-authorization-server): RFC 8414 discovery for MCP clients.
- [OAuth protected resource metadata](${o}/.well-known/oauth-protected-resource): RFC 9728 discovery for MCP clients.

## Optional

- [Bellhop](${o}/): the home page.
`)
}
docs.get("/llms-full.txt", (c) => llmsFull(c))
docs.get("/docs/llms-full.txt", (c) => llmsFull(c))
function llmsFull(c: Ctx) {
  const o = origin(c)
  headers(c, "text/plain; charset=utf-8")
  return c.body(
    docPages()
      .map((p) => `<!-- ${o}${p.path} -->\n\n${absolute(o, p.markdown).trim()}\n`)
      .join("\n\n")
  )
}

// Preview cards for docs pages, rendered by bellhop-og like the other cards. The card has no
// user input, so the stored PNG is keyed by page and design version and ignores the query.
docs.get("/og/docs/:file", async (c) => {
  const slug = /^([a-z]+)\.png$/.exec(c.req.param("file"))?.[1]
  const page = docPages().find((p) => p.slug === slug)
  if (!page) return c.notFound()
  const v = await ogVersion(page)
  const key = `og/docs/${page.slug}/${v}.png`
  const cacheKey = new Request(`${origin(c)}/.bellhop-cache/${key}`)
  const hit = await caches.default.match(cacheKey)
  if (hit) return hit
  const imageHeaders = {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff"
  }
  const saved = await c.env.MEDIA.get(key)
  let png: ArrayBuffer
  if (saved) png = await saved.arrayBuffer()
  else {
    const card: PreviewCard = {
      kind: "docs",
      appId: "docs",
      name: "Bellhop",
      slug: "",
      icon: null,
      title: page.title,
      description: page.description,
      number: null,
      status: null,
      labels: [],
      agent: null
    }
    const rendered = await c.env.OG.fetch("https://renderer.internal/render", {
      method: "POST",
      body: JSON.stringify(card)
    })
    if (!rendered.ok) return c.text("Preview temporarily unavailable", 503, { "Cache-Control": "no-store" })
    png = await rendered.arrayBuffer()
    await c.env.MEDIA.put(key, png, { httpMetadata: { contentType: "image/png" } })
  }
  const res = new Response(png, { headers: imageHeaders })
  c.executionCtx.waitUntil(caches.default.put(cacheKey, res.clone()))
  return res
})

// An installed docs page opens the docs. The icons are the favicon at the sizes manifests need.
docs.get("/docs/site.webmanifest", (c) => {
  headers(c, "application/manifest+json; charset=utf-8")
  return c.body(
    JSON.stringify({
      name: "Bellhop developer docs",
      short_name: "Bellhop docs",
      description: docPages()[0]!.description,
      start_url: "/docs",
      scope: "/docs",
      display: "browser",
      theme_color: "#161616",
      background_color: "#161616",
      icons: [192, 512].map((size) => ({ src: `/docs/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png" }))
    })
  )
})
for (const [size, data] of [
  [192, icon192],
  [512, icon512]
] as const) {
  const bytes = Uint8Array.from(atob(data.slice(data.indexOf(",") + 1)), (ch) => ch.charCodeAt(0))
  docs.get(`/docs/icon-${size}.png`, (c) =>
    c.body(bytes, 200, {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
      "X-Content-Type-Options": "nosniff"
    })
  )
}

docs.get("/docs/*", async (c) => {
  const path = c.req.path
  if (path.endsWith("/")) return c.redirect(path.replace(/\/+$/, "") || "/docs", 301)
  const md = /^\/docs\/([a-z]+)\.md$/.exec(path)
  if (md) {
    const page = docPages().find((p) => p.slug === md[1])
    if (!page) return c.text("Not found", 404, { "X-Robots-Tag": "noindex" })
    headers(c, "text/markdown; charset=utf-8")
    return c.body(absolute(origin(c), page.markdown))
  }
  const page = docPages().find((p) => p.slug !== "index" && p.path === path)
  if (page) {
    headers(c, "text/html; charset=utf-8")
    return c.body(await render(c, page))
  }
  headers(c, "text/html; charset=utf-8")
  c.header("Cache-Control", "no-store")
  c.header("X-Robots-Tag", "noindex")
  return c.body(await render(c, null), 404)
})
