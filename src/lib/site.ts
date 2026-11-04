// Production serves each app on <slug>.<VITE_APP_DOMAIN> and the home page on the bare domain. Without
// VITE_APP_DOMAIN (dev, the tailnet URL) apps live under /<slug> on one host.
const domain: string = import.meta.env.VITE_APP_DOMAIN ?? ""
const { protocol, hostname, port } = window.location
const suffix = port ? `:${port}` : ""

/** The app this subdomain belongs to, or null on the home domain and in path mode. */
export const hostSlug = domain && hostname.endsWith(`.${domain}`) ? hostname.slice(0, -domain.length - 1) : null
export const onHome = !!domain && hostname === domain

/** First path segments that are the home domain's own pages, not workspaces under /<slug> (path mode). */
export const homeSegments = new Set(["_design", "oauth", "device", "agents", "signin", "workspaces", "new", "reports", "settings"])

/**
 * A link to `rest` ("/issues/3", "/settings", "?q=…") inside an app. Same-app links stay relative so client-side
 * navigation works; from the home domain or another app it's an absolute URL on that app's subdomain.
 */
export function appPath(slug: string, rest = "") {
  const tail = rest === "/" ? "" : rest
  const rooted = tail.startsWith("/") ? tail : `/${tail}`
  if (hostSlug === slug) return rooted
  if (domain) return `${protocol}//${slug}.${domain}${suffix}${rooted}`
  return `/${slug}${tail}`
}

/** A link to the home domain (sign-in, your applications). */
export function homeUrl(path = "/") {
  return hostSlug ? `${protocol}//${domain}${suffix}${path}` : path
}

export const isAbsolute = (href: string) => /^https?:\/\//.test(href)

/** Sign-in lives on the home domain; from an app subdomain it returns to the full URL, otherwise to a path. */
export function signInHref() {
  const back = hostSlug ? window.location.href : window.location.pathname + window.location.search
  return homeUrl(back === "/" || back.startsWith("/signin") ? "/signin" : `/signin?next=${encodeURIComponent(back)}`)
}

/** The home domain as people read it: "blhp.app" in production, this host in path mode. */
export const homeLabel = () => domain || window.location.host

/** How an app's public address reads: "acme.blhp.app" in production, "/acme" in path mode. */
export const appLabel = (slug: string) => (domain ? `${slug}.${domain}` : `/${slug}`)

/** How a workspace address is typed: a subdomain ("<slug>.blhp.app") in production, a path ("host/<slug>") in path mode. */
export function addressParts(): { prefix: string; suffix: string } {
  return domain ? { prefix: "", suffix: `.${domain}` } : { prefix: `${window.location.host}/`, suffix: "" }
}

/** The workspace's full public URL, for copying and sharing. */
export const appUrl = (slug: string) => new URL(appPath(slug), window.location.href).href

/** The MCP endpoint on the home domain, absolute. */
export const mcpUrl = () => new URL(homeUrl("/mcp"), window.location.href).href
