import type { Ctx } from "./core"
import { appUrl, rows, sql } from "./core"
import { visibleIssues, workspaceActivitySQL } from "./issues"
import { preview, snippet, statuses } from "./previews"
import type { Actor, IssueStatus } from "../shared/api"

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
  const capability = /^\/new\/?$/.test(path) ? url.searchParams.get("metadata") : null
  if (capability !== null) {
    const result = await sql(
      c.env,
      `SELECT a.slug,m.expires_at FROM report_metadata m JOIN apps a ON a.id=m.app_id WHERE m.id=?1 AND m.ready=1 AND m.issue_id IS NULL AND (?2 IS NULL OR a.slug=?2)
      UNION ALL SELECT a.slug,'expired' FROM expired_reports e JOIN apps a ON a.id=e.app_id WHERE e.id=?1 AND (?2 IS NULL OR a.slug=?2)`,
      capability,
      slug
    ).first<{ slug: string; expires_at: string }>()
    c.header("Referrer-Policy", "no-referrer")
    c.header("Cache-Control", "no-store")
    if (!result || result.expires_at === "expired" || result.expires_at <= new Date().toISOString()) {
      const title = result ? "This report has expired" : "Report not found"
      return c.html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} · Bellhop</title><meta name="robots" content="noindex"></head><body><h1>${title}</h1><p>Return to the app to start a new report.</p></body></html>`,
        result ? 410 : 404,
        { "X-Robots-Tag": "noindex" }
      )
    }
    if (slug === null)
      return c.redirect(appUrl(c.env, origin(c), result.slug, `/new?metadata=${encodeURIComponent(capability)}`), 302)
  }
  const segment = /^\/issues\/([^/]+)\/?$/.exec(path)?.[1]
  // SQLite's numeric affinity would otherwise resolve e.g. /issues/1e1 as issue 10.
  const number =
    segment === undefined ? null : /^[1-9]\d*$/.test(segment) && Number.isSafeInteger(Number(segment)) ? segment : "0"
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
  if (slug && p.code === 200 && (number || /^\/(?:index\.html)?$/.test(path))) {
    const href = appPath(number ? `/issues/${number}/feed.atom` : "/feed.atom")
    tags.push(`<link rel="alternate" type="application/atom+xml" href="${xml(href)}">`)
  }
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
  if (capability !== null) {
    headers.set("Cache-Control", "no-store")
    headers.set("Referrer-Policy", "no-referrer")
  }
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

type AtomEntry = { id: string; title: string; href: string; author: string; updated: string; summary: string }
const atomText = (value: string) =>
  xml(value.replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, ""))
function authorName(raw: string) {
  const a = JSON.parse(raw) as Actor
  return a.name && !/\S+@\S+/.test(a.name)
    ? a.name
    : a.type === "guest"
      ? a.handle
      : a.type === "agent"
        ? "Agent"
        : "Reporter"
}
export async function atom(c: Ctx, number?: string) {
  const slug = workspace(c),
    o = origin(c)
  if (!slug || slug === "feed.atom" || (number !== undefined && !/^[1-9]\d*$/.test(number))) return notFound(c)
  const link = (path: string) => appUrl(c.env, o, slug, path)
  const where = `i.app_id=a.id AND i.private=0 AND i.hidden IS NULL`
  type Row = {
    id: string
    number: number
    title: string
    actor: string
    body: string
    updated: string
    kind: "issue" | "comment" | "status"
  }
  type Scope = { name: string; public: number; created_at: string; issue_id: string | null; issue_title: string | null }
  const target = `SELECT i.id FROM issues i JOIN apps a ON ${where} WHERE a.slug=?1 AND i.number=?2`
  // Same snapshot for visibility, feed identity and entries; no cookies, comment bodies
  // from internal notes, or team-only timeline events enter this projection.
  const [context, page] = await c.env.DB.batch([
    number
      ? sql(
          c.env,
          `SELECT a.name,a.public,i.created_at,i.id issue_id,i.title issue_title FROM apps a JOIN issues i ON ${where} WHERE a.slug=? AND i.number=?`,
          slug,
          number
        )
      : sql(c.env, "SELECT name,public,created_at,NULL issue_id,NULL issue_title FROM apps WHERE slug=?", slug),
    number
      ? sql(
          c.env,
          `WITH target AS (${target}) SELECT c.id,c.author actor,substr(c.body,1,4096) body,c.updated_at updated,'comment' kind FROM comments c WHERE c.issue_id=(SELECT id FROM target) AND c.hidden IS NULL AND c.internal=0
        UNION ALL SELECT e.id,e.actor,e.data,e.created_at,'status' FROM issue_events e WHERE e.issue_id=(SELECT id FROM target) AND e.type='status_changed' ORDER BY updated DESC,id DESC LIMIT 50`,
          slug,
          number
        )
      : sql(
          c.env,
          `SELECT i.id,i.number,i.title,i.author actor,substr(i.body,1,4096) body,i.updated_at updated,'issue' kind FROM apps a JOIN issues i ON ${where} WHERE a.slug=? ORDER BY i.updated_at DESC,i.id DESC LIMIT 50`,
          slug
        )
  ])
  const s = context!.results[0] as Scope | undefined
  if (!s) return c.text("Feed not found", 404, { "X-Robots-Tag": "noindex", "Cache-Control": "no-store" })
  const href = link(number ? `/issues/${number}` : "/"),
    self = link(number ? `/issues/${number}/feed.atom` : "/feed.atom"),
    title = number ? `${s.issue_title} · #${number} · ${s.name}` : `${s.name} issues`
  const entries = (page!.results as Row[]).map((r): AtomEntry => {
    const author = authorName(r.actor),
      base = { id: `tag:blhp.app,2026:${r.kind}/${r.id}`, author, updated: r.updated }
    if (r.kind === "status") {
      const d = JSON.parse(r.body) as { from: IssueStatus; to: IssueStatus; close_reason: string | null }
      const state = statuses[d.to].name
      return {
        ...base,
        href,
        title: `Status: ${state}`,
        summary: `${statuses[d.from].name} → ${state}${d.close_reason ? ` (${d.close_reason.replaceAll("_", " ")})` : ""}`
      }
    }
    return {
      ...base,
      href: number ? href : link(`/issues/${r.number}`),
      title: number ? `Reply by ${author}` : r.title,
      summary: snippet(r.body, 320)
    }
  })
  const tag = (name: string, value: string) => `<${name}>${atomText(value)}</${name}>`,
    alt = (h: string) => `<link rel="alternate" href="${xml(h)}"/>`
  const doc = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${tag("id", s.issue_id ? `tag:blhp.app,2026:thread/${s.issue_id}` : self)}${tag("title", title)}${tag("updated", entries[0]?.updated ?? s.created_at)}<author><name>Bellhop</name></author>${alt(href)}<link rel="self" type="application/atom+xml" href="${xml(self)}"/>${entries.map((e) => `<entry>${tag("id", e.id)}${tag("title", e.title)}${tag("updated", e.updated)}${alt(e.href)}<author>${tag("name", e.author)}</author>${tag("summary", e.summary)}</entry>`).join("")}</feed>`
  return c.body(doc, 200, {
    "Content-Type": "application/atom+xml; charset=utf-8",
    "Cache-Control": s.public ? "public, max-age=0, s-maxage=60" : "private, no-store",
    ...(!s.public && { "X-Robots-Tag": "noindex" })
  })
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
