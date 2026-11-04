import type { Ctx } from "./core"
import { appUrl, bad, rows, sql } from "./core"
import { pageContext, pagePayload } from "./page-payload"
import type { Actor, Issue, IssueStatus, PagePayload } from "../shared/api"
import { visibleIssues, workspaceActivitySQL } from "./issues"
import { preview, snippet, statuses } from "./previews"

// Dev serves workspaces under /<slug>. The apex also understands these old page links;
// the production sitemap always points to the canonical workspace subdomain instead.
const homePages = new Set([
  "/",
  "/signin",
  "/workspaces",
  "/agents",
  "/reports",
  "/settings/notifications",
  "/new",
  "/oauth/consent",
  "/device",
  "/_design"
])
const homeSegments = new Set([
  "index.html",
  "robots.txt",
  "sitemap.xml",
  ...Array.from(homePages, (p) => p.split("/")[1]!)
])
function workspace(c: Ctx, url = new URL(c.req.url)): string | null {
  const domain = c.env.APP_DOMAIN
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
  return homeSegments.has(first) ? null : first
}
const origin = (c: Ctx) =>
  c.env.APP_DOMAIN ? `https://${c.env.APP_DOMAIN}` : new URL(c.env.PUBLIC_ORIGIN || c.req.url).origin
const xml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;")
const notFound = (c: Ctx) => c.text("Workspace not found", 404, { "X-Robots-Tag": "noindex" })
async function visibility(c: Ctx, slug: string) {
  return sql(c.env, "SELECT public FROM apps WHERE slug=?", slug).first<number>("public")
}
function location(c: Ctx, url: URL) {
  const slug = workspace(c, url),
    subdomain = c.env.APP_DOMAIN && url.hostname.endsWith(`.${c.env.APP_DOMAIN}`)
  const path = !subdomain && slug !== null ? url.pathname.replace(/^\/[^/]+/, "") || "/" : url.pathname
  return { slug, path, homePage: homePages.has(path.replace(/\/$/, "") || "/") }
}
// Resolve a Bellhop URL locally; oEmbed never fetches a caller-supplied URL or uses cookies.
export async function oembed(c: Ctx) {
  if ((c.req.query("format") ?? "json") !== "json") bad("Only JSON oEmbed is supported")
  const u = URL.parse(c.req.query("url") ?? ""),
    site = c.env.APP_DOMAIN,
    o = origin(c)
  if (
    !u ||
    u.username ||
    u.password ||
    !["https:", "http:"].includes(u.protocol) ||
    (site
      ? !(u.hostname === site || u.hostname.endsWith("." + site)) ||
        (u.protocol !== "https:" && site !== "localhost") ||
        (u.port && site !== "localhost")
      : u.origin !== o)
  )
    return notFound(c)
  const { slug, path } = location(c, u),
    n = /^\/issues\/([1-9]\d*)\/?$/.exec(path)?.[1]
  if (!slug || (!n && path !== "/") || (n && !Number.isSafeInteger(Number(n)))) return notFound(c)
  const row = await (
    n
      ? sql(
          c.env,
          `SELECT i.title,coalesce(json_extract(i.author,'$.name'),json_extract(i.author,'$.handle'),'Guest') author FROM apps a JOIN issues i ON i.app_id=a.id WHERE a.public=1 AND a.slug=? AND i.number=? AND i.private=0 AND i.hidden IS NULL`,
          slug,
          n
        )
      : sql(c.env, "SELECT name title,name author FROM apps WHERE public=1 AND slug=?", slug)
  ).first<{ title: string; author: string }>()
  if (!row) return notFound(c)
  return c.json({
    version: "1.0",
    type: "link",
    title: row.title,
    author_name: row.author,
    provider_name: "Bellhop",
    provider_url: o,
    thumbnail_url: appUrl(c.env, o, slug, n ? `/og/issues/${n}.png` : "/og/app.png"),
    thumbnail_width: 1200,
    thumbnail_height: 630
  })
}
export async function pageApi(c: Ctx) {
  const input = c.req.query("path")
  if (!input || !input.startsWith("/") || input.startsWith("//") || /[\\\u0000-\u001f]/.test(input))
    bad("Expected a local page path")
  const url = new URL(input, c.req.url),
    target = location(c, url)
  const { payload, status } = await pagePayload(c, target, url.searchParams, await pageContext(c))
  return c.json(payload, status, { "Cache-Control": "private, no-store", Vary: "Cookie" })
}
const bootScript = (payload: PagePayload) =>
  `<script id="bh-boot" type="application/json">${JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")}</script>`
const hasVideo = (post: Pick<Issue, "attachments" | "body">) =>
  post.attachments.some((a) => a.kind === "video") ||
  /(?:^|[\s(<])\/media\/[^\s()<>]+\.(?:mp4|m4v|webm|mov|ogv)(?=[?#)>\s]|$)/i.test(post.body)
export async function page(c: Ctx) {
  const url = new URL(c.req.url),
    target = location(c, url),
    { slug, path } = target
  const vite = c.env.DEV_LOGIN === "1" && !c.env.APP_DOMAIN,
    nonce = vite ? crypto.randomUUID() : null
  const wsHost = new URL(c.env.PUBLIC_ORIGIN && !c.env.APP_DOMAIN ? c.env.PUBLIC_ORIGIN : url).host
  const policy = [
    "default-src 'self'",
    `script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com${vite ? " 'sha256-Z2/iFzh9VMlVkEOar1f/oSHWwQk3ve1qk/C2WdsC4Xk='" : ""}`,
    `style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}`,
    "font-src 'self'",
    "img-src 'self' data: blob: https://lh3.googleusercontent.com",
    "media-src 'self' blob:",
    `connect-src 'self' wss://${wsHost} ${url.protocol === "http:" ? "ws://" + wsHost + " " : ""}https://challenges.cloudflare.com https://cloudflareinsights.com`,
    "frame-src https://challenges.cloudflare.com",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'"
  ].join("; ")
  c.header("Content-Security-Policy", policy)
  const capability = /^\/new\/?$/.test(path) ? url.searchParams.get("metadata") : null
  const ctx = await pageContext(c)
  c.header("Cache-Control", "private, no-store")
  c.header("Vary", "Cookie")
  if (capability !== null) c.header("Referrer-Policy", "no-referrer")
  if (capability !== null && slug === null) {
    const result = await sql(
      c.env,
      `SELECT a.slug,m.expires_at FROM report_metadata m JOIN apps a ON a.id=m.app_id WHERE m.id=?1 AND m.ready=1 AND m.issue_id IS NULL
      UNION ALL SELECT a.slug,'expired' FROM expired_reports e JOIN apps a ON a.id=e.app_id WHERE e.id=?1`,
      capability
    ).first<{ slug: string; expires_at: string }>()
    if (!result || result.expires_at === "expired" || result.expires_at <= new Date().toISOString()) {
      const title = result ? "This report has expired" : "Report not found"
      const { payload } = await pagePayload(c, target, url.searchParams, ctx)
      return c.html(
        `<!doctype html><html lang="${payload.me.locale}"><head><meta charset="utf-8"><title>${title} · Bellhop</title><meta name="robots" content="noindex"></head><body><h1>${title}</h1><p>Return to the app to start a new report.</p>${bootScript(payload)}</body></html>`,
        result ? 410 : 404,
        { "X-Robots-Tag": "noindex" }
      )
    }
    return c.redirect(appUrl(c.env, origin(c), result.slug, `/new?metadata=${encodeURIComponent(capability)}`), 302)
  }
  const segment = /^\/issues\/([^/]+)\/?$/.exec(path)?.[1]
  // SQLite's numeric affinity would otherwise resolve e.g. /issues/1e1 as issue 10.
  const number =
    segment === undefined ? null : /^[1-9]\d*$/.test(segment) && Number.isSafeInteger(Number(segment)) ? segment : "0"
  const [p, { payload, status }, asset] = await Promise.all([
    preview(c.env, slug, number, true, ctx.read),
    pagePayload(c, target, url.searchParams, ctx),
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
  const desk = payload.app?.mode === "helpdesk"
  const title = desk ? payload.app!.name : article ? `${card.title} · #${card.number} · ${card.name}` : card.title,
    desc = article?.description ?? card.description
  const noindex = desk || !p.listed || !(/^\/(?:index\.html)?$/.test(path) || number !== null)
  const icon = card.icon ? `/icon/${card.slug}/${card.icon}` : null
  const meta = (k: string, value: string) =>
    `<meta ${k.startsWith("og:") || k.startsWith("article:") ? "property" : "name"}="${k}" content="${xml(value)}">`
  const tags = [
    `<title>${xml(title)}</title>`,
    meta("description", desc),
    `<link rel="canonical" href="${xml(canonical)}">`,
    meta("og:site_name", desk ? payload.app!.name : "Bellhop"),
    meta("og:type", article ? "article" : "website"),
    meta("og:title", title),
    meta("og:description", desc),
    meta("og:url", canonical),
    ...(desk
      ? []
      : [
          meta("og:image", image),
          meta("og:image:type", "image/png"),
          meta("og:image:width", "1200"),
          meta("og:image:height", "630"),
          meta("og:image:alt", title),
          meta("twitter:card", "summary_large_image")
        ]),
    meta("twitter:title", title),
    meta("twitter:description", desc),
    ...(desk ? [] : [meta("twitter:image", image)]),
    meta("twitter:image:alt", title),
    meta("theme-color", card.status ? statuses[card.status].color : "#161616"),
    `<link rel="icon" href="${xml(icon ?? "/favicon.svg")}"><link rel="apple-touch-icon" href="${xml(icon ?? "/apple-touch-icon.png")}">`
  ]
  if (noindex) tags.push(meta("robots", "noindex"))
  if (slug === null) tags.push(`<link rel="describedby" href="${xml(`${o}/llms.txt`)}">`)
  if (slug && p.listed && p.code === 200 && (article || path === "/"))
    tags.push(
      `<link rel="alternate" type="application/json+oembed" href="${xml(`${o}/oembed?url=${encodeURIComponent(canonical)}&format=json`)}">`
    )
  if (nonce) tags.push(`<meta property="csp-nonce" nonce="${nonce}">`)
  if (!desk && slug && p.code === 200 && (number || /^\/(?:index\.html)?$/.test(path))) {
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
  headers.set("Content-Security-Policy", policy)
  for (const h of ["etag", "last-modified", "content-length", "content-range"]) headers.delete(h)
  headers.set("Cache-Control", "private, no-store")
  headers.append("Vary", "Cookie")
  if (capability !== null) {
    headers.set("Referrer-Policy", "no-referrer")
  }
  if (noindex) headers.set("X-Robots-Tag", "noindex")
  const rw = new HTMLRewriter()
  const { route } = payload
  const markdown = route.kind === "issue" || route.kind === "new"
  const video =
    route.kind === "issue" &&
    (hasVideo(route.issue) || route.issue.timeline.some((item) => item.kind === "comment" && hasVideo(item.comment)))
  rw.on("head link[data-bh-preload]", {
    element(e) {
      const kind = e.getAttribute("data-bh-preload")
      const needed = kind === "markdown" ? markdown : video && (kind === "video" || kind === "video-style")
      if (!needed) {
        e.remove()
        return
      }
      e.removeAttribute("data-bh-preload")
      e.setAttribute("crossorigin", "")
      e.setAttribute("rel", kind === "video-style" ? "preload" : "modulepreload")
      if (kind === "video-style") e.setAttribute("as", "style")
    }
  })
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
    .on("html", {
      element(e) {
        e.setAttribute("lang", payload.me.locale)
      }
    })
    .on("head", {
      element: (e) => {
        e.append(tags.join("\n"), { html: true })
      }
    })
    .on("body", {
      element: (e) => {
        e.append(bootScript(payload), { html: true })
      }
    })
    .transform(c.newResponse(asset.body, { status, headers }))
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
      : sql(
          c.env,
          "SELECT name,public,created_at,NULL issue_id,NULL issue_title FROM apps WHERE slug=? AND mode!='helpdesk'",
          slug
        ),
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
  const host = workspace(c)
  if (host && (await sql(c.env, "SELECT 1 FROM apps WHERE slug=? AND mode='helpdesk'", host).first()))
    return notFound(c)
  const path = c.env.APP_DOMAIN ? c.req.path : c.req.path.replace(/^\/[^/]+(?=\/og\/)/, "")
  const home = c.req.path === "/og/home.png",
    number = /^\/og\/issues\/([1-9]\d*)\.png$/.exec(path)?.[1] ?? null
  if (!home && !number && path !== "/og/app.png") return c.notFound()
  const slug = home ? null : workspace(c)
  const subdomain = c.env.APP_DOMAIN && new URL(c.req.url).hostname.endsWith(`.${c.env.APP_DOMAIN}`)
  if (!home && (slug === null || (!subdomain && path === c.req.path))) return c.notFound()
  const { card, v, reply, code } = await preview(c.env, slug, number, false)
  if (!home && card.kind === "home") return notFound(c)
  const key = `og/${card.appId}/${card.number ?? card.kind}/${v}.png`
  // The public URL is not a cache key: arbitrary queries, a stale version, or a now-private
  // issue must never choose which bytes to read. This synthetic URL isn't a public route.
  const cacheKey = new Request(`${origin(c)}/.bellhop-cache/${key}?a=${reply}`)
  const cache = caches.default,
    hit = await cache.match(cacheKey)
  const forRequest = (image: Response) => {
    if (!number || code === 200) return image
    const h = new Headers(image.headers)
    h.set("Cache-Control", "no-store")
    h.set("X-Robots-Tag", "noindex")
    return new Response(image.body, { status: code, headers: h })
  }
  if (hit) return forRequest(hit)
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
  return forRequest(res)
}
export async function robots(c: Ctx) {
  const slug = workspace(c),
    listed = slug === null ? 1 : await visibility(c, slug)
  if (listed === null) return notFound(c)
  const sitemap = slug === null ? `${origin(c)}/sitemap.xml` : appUrl(c.env, origin(c), slug, "/sitemap.xml")
  const docs = slug === null ? `\nSitemap: ${origin(c)}/docs/sitemap.xml` : ""
  return c.text(`User-agent: *\n${listed ? `Allow: /\nSitemap: ${sitemap}${docs}` : "Disallow: /"}\n`)
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
    doc = `<sitemapindex ${ns}><sitemap><loc>${xml(`${o}/docs/sitemap.xml`)}</loc></sitemap>${apps.map((a) => `<sitemap><loc>${xml(appUrl(c.env, o, a.slug, "/sitemap.xml"))}</loc></sitemap>`).join("")}</sitemapindex>`
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
