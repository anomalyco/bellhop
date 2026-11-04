import type { Ctx } from "./core"
import { appUrl, rows, sql } from "./core"
import { visibleIssues, workspaceActivitySQL } from "./issues"

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
    listed = slug === null ? 1 : await visibility(c, slug)
  // The assets binding serves the actual index document at /. Requesting /index.html can
  // produce an asset canonicalization redirect. Do not rewrite its HTML or cache visibility.
  const headers = new Headers(c.req.raw.headers)
  if (listed === null) {
    headers.delete("If-None-Match")
    headers.delete("If-Modified-Since")
  }
  const asset = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), { headers }))
  const res = new Response(asset.body, { status: listed === null ? 404 : asset.status, headers: asset.headers })
  res.headers.set("Cache-Control", "no-store")
  if (!listed) res.headers.set("X-Robots-Tag", "noindex")
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
