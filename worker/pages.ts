import type { Ctx } from "./core"
import { appUrl, rows, sql } from "./core"
import { visibleIssues, workspaceActivitySQL } from "./issues"
import { preview, statuses } from "./previews"

// Dev serves workspaces under /<slug>. The apex also understands these old page links;
// the production sitemap always points to the canonical workspace subdomain instead.
const homePages = new Set([
  "",
  "index.html",
  "signin",
  "workspaces",
  "agents",
  "new",
  "oauth",
  "device",
  "_design",
  "robots.txt",
  "sitemap.xml"
])
function workspace(c: Ctx): string | null {
  const url = new URL(c.req.url),
    domain = c.env.APP_DOMAIN
  if (domain && url.hostname !== domain) {
    if (!url.hostname.endsWith(`.${domain}`)) return "" // unknown host, never the apex
    return url.hostname.slice(0, -domain.length - 1)
  }
  let first: string
  try {
    first = decodeURIComponent(url.pathname.split("/")[1] ?? "")
  } catch {
    return ""
  }
  return homePages.has(first) ? null : first
}
const origin = (c: Ctx) =>
  c.env.APP_DOMAIN ? `https://${c.env.APP_DOMAIN}` : new URL(c.env.PUBLIC_ORIGIN || c.req.url).origin
const xml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
const notFound = (c: Ctx) => c.text("Workspace not found", 404, { "X-Robots-Tag": "noindex" })
async function visibility(c: Ctx, slug: string) {
  return sql(c.env, "SELECT public FROM apps WHERE slug=?", slug).first<number>("public")
}
export async function page(c: Ctx) {
  const slug = workspace(c),
    url = new URL(c.req.url)
  const subdomain = c.env.APP_DOMAIN && url.hostname.endsWith(`.${c.env.APP_DOMAIN}`)
  const path = !subdomain && slug !== null ? url.pathname.replace(/^\/[^/]+/, "") || "/" : url.pathname
  const segment = /^\/issues\/([^/]+)\/?$/.exec(path)?.[1]
  // SQLite's numeric affinity would otherwise resolve e.g. /issues/1e1 as issue 10.
  const number = segment === undefined ? null : /^[1-9]\d*$/.test(segment) && Number.isSafeInteger(Number(segment)) ? segment : "0"
  const [p, asset] = await Promise.all([
    preview(c.env, slug, number, true),
    c.env.ASSETS.fetch(new Request(new URL("/", url), { headers: { Accept: "text/html" } }))
  ])
  if (!asset.ok) return asset
  const { card, article } = p,
    o = origin(c),
    appPath = (path: string) => appUrl(c.env, o, card.slug, path)
  const canonical = card.kind === "home" ? `${o}/` : appPath(article ? `/issues/${card.number}` : "/")
  const image =
    card.kind === "home"
      ? `${o}/og/home.png`
      : appPath(`/og/${article ? `issues/${card.number}` : "app"}.png?v=${p.v}${p.reply ? `&a=${p.reply}` : ""}`)
  const title = article ? `${card.title} · #${card.number} · ${card.name}` : card.title,
    desc = article?.description ?? card.description
  const noindex = !p.listed || !(/^\/(?:index\.html)?$/.test(path) || number !== null)
  const icon = card.icon ? `/icon/${card.slug}/${card.icon}` : null
  const meta = (k: string, value: string) =>
    `<meta ${k.startsWith("og:") || k.startsWith("article:") ? "property" : "name"}="${k}" content="${xml(value)}">`
  const tags = [
    `<title>${xml(title)}</title>`,
    meta("description", desc),
    `<link rel="canonical" href="${xml(canonical)}">`,
    meta("og:site_name", "Bellhop"),
    meta("og:type", article ? "article" : "website"),
    meta("og:title", title),
    meta("og:description", desc),
    meta("og:url", canonical),
    meta("og:image", image),
    meta("og:image:type", "image/png"),
    meta("og:image:width", "1200"),
    meta("og:image:height", "630"),
    meta("og:image:alt", title),
    meta("twitter:card", "summary_large_image"),
    meta("twitter:title", title),
    meta("twitter:description", desc),
    meta("twitter:image", image),
    meta("twitter:image:alt", title),
    meta("theme-color", card.status ? statuses[card.status].color : "#161616"),
    `<link rel="icon" href="${xml(icon ?? "/favicon.svg")}"><link rel="apple-touch-icon" href="${xml(icon ?? "/apple-touch-icon.png")}">`
  ]
  if (noindex) tags.push(meta("robots", "noindex"))
  if (article)
    tags.push(
      meta("article:published_time", article.published),
      meta("article:modified_time", article.modified),
      meta("twitter:label1", "Status"),
      meta("twitter:data1", article.summary),
      meta("twitter:label2", "Reporter"),
      meta("twitter:data2", article.reporter)
    )
  const headers = new Headers(asset.headers)
  for (const h of ["etag", "last-modified", "content-length", "content-range"]) headers.delete(h)
  headers.set("Cache-Control", "public, max-age=0, must-revalidate")
  if (noindex) headers.set("X-Robots-Tag", "noindex")
  const rw = new HTMLRewriter()
  for (const selector of [
    "title",
    'meta[name="description"]',
    'meta[name="robots"]',
    'meta[name="theme-color"]',
    'meta[property^="og:"]',
    'meta[property^="article:"]',
    'meta[name^="twitter:"]',
    'link[rel="canonical"]',
    'link[rel="icon"]',
    'link[rel="apple-touch-icon"]'
  ])
    rw.on(`head ${selector}`, {
      element: (e) => {
        e.remove()
      }
    })
  return rw
    .on("head", {
      element: (e) => {
        e.append(tags.join("\n"), { html: true })
      }
    })
    .transform(new Response(asset.body, { status: p.code, headers }))
}

export async function ogImage(c: Ctx) {
  const path = c.env.APP_DOMAIN ? c.req.path : c.req.path.replace(/^\/[^/]+(?=\/og\/)/, "")
  const home = c.req.path === "/og/home.png",
    number = /^\/og\/issues\/([1-9]\d*)\.png$/.exec(path)?.[1] ?? null
  if (!home && !number && path !== "/og/app.png") return c.notFound()
  const slug = home ? null : workspace(c)
  const subdomain = c.env.APP_DOMAIN && new URL(c.req.url).hostname.endsWith(`.${c.env.APP_DOMAIN}`)
  if (!home && (slug === null || (!subdomain && path === c.req.path))) return c.notFound()
  const { card, v, reply } = await preview(c.env, slug, number, false)
  if (!home && card.kind === "home") return notFound(c)
  const key = `og/${card.appId}/${card.number ?? card.kind}/${v}.png`
  // The public URL is not a cache key: arbitrary queries, a stale version, or a now-private
  // issue must never choose which bytes to read. This synthetic URL isn't a public route.
  const cacheKey = new Request(`${origin(c)}/.bellhop-cache/${key}?a=${reply}`)
  const cache = caches.default,
    hit = await cache.match(cacheKey)
  if (hit) return hit
  const headers = {
    "Content-Type": "image/png",
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff"
  }
  const saved = await c.env.MEDIA.get(key)
  let res: Response
  if (saved && (saved.customMetadata?.reply ?? "") === reply) res = new Response(saved.body, { headers })
  else {
    if (saved) await saved.body.cancel()
    const rendered = await c.env.OG.fetch("https://renderer.internal/render", {
      method: "POST",
      body: JSON.stringify(card)
    })
    if (!rendered.ok) return c.text("Preview temporarily unavailable", 503, { "Cache-Control": "no-store" })
    const png = await rendered.arrayBuffer()
    await c.env.MEDIA.put(key, png, { httpMetadata: { contentType: "image/png" }, customMetadata: { reply } })
    res = new Response(png, { headers })
  }
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()))
  return res
}
export async function robots(c: Ctx) {
  const slug = workspace(c),
    listed = slug === null ? 1 : await visibility(c, slug)
  if (listed === null) return notFound(c)
  const sitemap = slug === null ? `${origin(c)}/sitemap.xml` : appUrl(c.env, origin(c), slug, "/sitemap.xml")
  return c.text(`User-agent: *\n${listed ? `Allow: /\nSitemap: ${sitemap}` : "Disallow: /"}\n`)
}
export async function sitemap(c: Ctx) {
  const slug = workspace(c),
    ns = 'xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    o = origin(c)
  let doc: string
  if (slug === null) {
    const apps = await rows<{ slug: string }>(
      sql(c.env, "SELECT slug FROM apps WHERE public=1 ORDER BY slug LIMIT 50000")
    )
    doc = `<sitemapindex ${ns}>${apps.map((a) => `<sitemap><loc>${xml(appUrl(c.env, o, a.slug, "/sitemap.xml"))}</loc></sitemap>`).join("")}</sitemapindex>`
  } else {
    // Check visibility and enumerate URLs in the same snapshot: a just-unlisted workspace
    // cannot leave issue numbers behind in a response.
    const [app, issues] = await c.env.DB.batch<{ number: number; updated_at: string }>([
      sql(c.env, `SELECT ${workspaceActivitySQL} updated_at FROM apps a WHERE a.slug=? AND a.public=1`, slug),
      sql(
        c.env,
        `SELECT i.number,i.updated_at FROM apps a JOIN issues i ON ${visibleIssues("a.id")} WHERE a.slug=? AND a.public=1 ORDER BY i.number DESC LIMIT 49999`,
        slug
      )
    ])
    if (!app!.results.length) return notFound(c)
    const entry = (path: string, lastmod: string) =>
      `<url><loc>${xml(appUrl(c.env, o, slug, path))}</loc><lastmod>${xml(lastmod)}</lastmod></url>`
    const latest = app!.results[0]!.updated_at
    doc = `<urlset ${ns}>${entry("/", latest)}${issues!.results.map((i) => entry(`/issues/${i.number}`, i.updated_at)).join("")}</urlset>`
  }
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n${doc}\n`, 200, {
    "Content-Type": "application/xml; charset=utf-8"
  })
}
