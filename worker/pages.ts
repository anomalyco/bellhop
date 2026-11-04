import type { Ctx } from "./core"
import { appUrl, rows, sql } from "./core"
import { visibleIssues, workspaceActivitySQL } from "./issues"
import { viewerApp } from "./apps"
import { outsider, sees } from "./visibility"

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
  const slug = workspace(c), url = new URL(c.req.url)
  const subdomain = c.env.APP_DOMAIN && url.hostname.endsWith(`.${c.env.APP_DOMAIN}`)
  const number = (subdomain ? /^\/issues\/(\d+)\/?$/ : /^\/[^/]+\/issues\/(\d+)\/?$/).exec(url.pathname)?.[1]
  let listed: number | null = 1, status: 404 | 410 | undefined
  if (slug !== null && number) {
    const r = await sql(c.env, `SELECT a.public,i.id,i.private,i.hidden IS NOT NULL hidden,json_extract(i.author,'$.id') reporter,t.number tombstone
      FROM apps a LEFT JOIN issues i ON i.app_id=a.id AND i.number=?1 LEFT JOIN issue_tombstones t ON t.app_id=a.id AND t.number=?1 WHERE a.slug=?2`,number,slug)
      .first<{public:number;id:string|null;private:number;hidden:number;reporter:string;tombstone:number|null}>()
    listed = r?.public ?? null
    if (!r?.id) status = r?.tombstone ? 410 : 404
    else {
      const gate = {private:!!r.private,hidden:!!r.hidden,reporter:r.reporter}
      if (!sees(outsider,gate)) {
        listed=0
        if (!sees((await viewerApp(c,slug)).viewer,gate)) status=404
      }
    }
  } else if (slug !== null) {
    listed=await visibility(c,slug)
    if (listed===null) status=404
  }
  // The assets binding serves the actual index document at /. Requesting /index.html can
  // produce an asset canonicalization redirect. Do not rewrite its HTML or cache visibility.
  const headers = new Headers(c.req.raw.headers)
  if (status) {
    headers.delete("If-None-Match")
    headers.delete("If-Modified-Since")
  }
  const asset = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.url), { headers }))
  const res = new Response(asset.body, { status: status ?? asset.status, headers: asset.headers })
  res.headers.set("Cache-Control", "no-store")
  if (!listed || status) res.headers.set("X-Robots-Tag", "noindex")
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
