import type { PagePayload } from "../../shared/api"
import { ApiFailure, bootGuestReady, failure, keys } from "./api"
import { fresh, holdFetchesUntilPaint, load, seed, seedError } from "./cache"
import { feedKey, listKey, parseQuery, type Filter } from "./issues"
import { homeSegments, hostSlug } from "./site"
import { setServerClock } from "./time"

// Whole pages in one request. The Worker embeds a PagePayload in every page's HTML (<script id="bh-boot">) and
// answers GET /api/page?path= with the same, so the first paint and in-app navigation each need one round trip
// at most. Everything here seeds the same cache keys the per-endpoint fetchers use, so pages read their data the
// usual way and refresh it the usual way.

/** What a path shows, in the SPA's own terms (mirrors main.tsx's routes and the Worker's page-payload.ts). */
export type PageRoute =
  | { kind: "feed"; filter: Filter }
  | { kind: "list"; slug: string; filter: Filter }
  | { kind: "issue"; slug: string; number: number }
  | { kind: "new"; slug: string; metadata: string | null }
  | { kind: "other"; slug: string | null }

export function routeOf(path: string): PageRoute {
  const url = new URL(path, window.location.origin)
  const q = url.searchParams.get("q") ?? "is:open"
  let slug: string | null
  let sub: string
  if (hostSlug) {
    slug = hostSlug
    sub = url.pathname
  } else {
    const [, first = "", ...rest] = url.pathname.split("/")
    let name = first
    try {
      name = decodeURIComponent(first)
    } catch {
      // A malformed segment can't name a workspace
    }
    slug = !name || homeSegments.has(name) ? null : name
    sub = slug === null ? url.pathname : `/${rest.join("/")}`
  }
  sub = sub.replace(/\/$/, "") || "/"
  if (slug === null) return sub === "/" ? { kind: "feed", filter: parseQuery(q) } : { kind: "other", slug: null }
  if (sub === "/") return { kind: "list", slug, filter: parseQuery(q) }
  const issue = /^\/issues\/([1-9]\d*)$/.exec(sub)
  if (issue) return { kind: "issue", slug, number: Number(issue[1]) }
  if (sub === "/new") return { kind: "new", slug, metadata: url.searchParams.get("metadata") }
  return { kind: "other", slug }
}

/** The cache key holding a route's main content, if it has one. */
export function routeKey(r: PageRoute): string | null {
  switch (r.kind) {
    case "feed":
      return feedKey(r.filter)
    case "list":
      return listKey(r.slug, r.filter)
    case "issue":
      return keys.issue(r.slug, r.number)
    case "new":
      return r.metadata ? keys.metadata(r.slug, r.metadata) : null
    case "other":
      return null
  }
}

/** The error a page that isn't there would have given from its own endpoint (404, or 410 "deleted"). */
const missing = (status: number) =>
  status === 410 ? new ApiFailure(410, "deleted", "This issue was deleted.") : new ApiFailure(404, "not_found", "Not found")

/** Seeds every key a payload covers, except `skip` (which a pending load() is about to fill). */
export function seedPage(payload: PagePayload, r: PageRoute, status = 200, skip?: string) {
  seed(keys.me, payload.me)
  seed(keys.config, payload.config)
  if (payload.app) seed(keys.app(payload.app.slug), payload.app)
  const main = routeKey(r)
  const put = <T>(key: string, data: T) => key !== skip && seed(key, data)
  const route = payload.route
  if (route.kind === "feed" && r.kind === "feed") {
    put(feedKey(r.filter), route.list)
    put(keys.feedApps, route.apps)
  } else if (route.kind === "list" && r.kind === "list") put(listKey(r.slug, r.filter), route.list)
  else if (route.kind === "issue" && r.kind === "issue") put(keys.issue(r.slug, r.number), route.issue)
  else if (route.kind === "new" && r.kind === "new" && r.metadata && route.metadata) put(keys.metadata(r.slug, r.metadata), route.metadata)
  else if (route.kind === "not_found" && r.kind === "issue" && payload.app && main && main !== skip) seedError(main, missing(status))
}

/** The route's main content out of a payload, or the error its own endpoint would have answered. */
function contentOf(payload: PagePayload, r: PageRoute, status: number): unknown {
  const route = payload.route
  if (route.kind === "feed" && r.kind === "feed") return route.list
  if (route.kind === "list" && r.kind === "list") return route.list
  if (route.kind === "issue" && r.kind === "issue") return route.issue
  if (route.kind === "new" && route.metadata) return route.metadata
  throw missing(status)
}

/** The boot payload in this page's HTML, if the Worker sent one. */
export function readBoot(): PagePayload | null {
  const el = document.getElementById("bh-boot")
  if (!el?.textContent) return null
  try {
    const payload = JSON.parse(el.textContent) as PagePayload
    return payload && payload.me && payload.config && payload.route ? payload : null
  } catch {
    return null
  }
}

/**
 * Before the first render: everything the first screen reads, from the HTML itself. The page response already set
 * the guest cookie, and its time anchors the relative-time clock.
 */
export function seedBoot(payload: PagePayload) {
  const nav = performance.getEntriesByType("navigation")[0] as (PerformanceNavigationTiming & { responseStatus?: number }) | undefined
  seedPage(payload, routeOf(window.location.pathname + window.location.search), nav?.responseStatus || 200)
  setServerClock(payload.now, performance.timeOrigin + (nav?.responseStart ?? 0))
  bootGuestReady()
  holdFetchesUntilPaint(document.getElementById("root"))
}

const inflight = new Map<string, Promise<{ payload: PagePayload; status: number }>>()

function fetchPage(path: string) {
  let p = inflight.get(path)
  if (p) return p
  p = (async () => {
    const res = await fetch(`/api/page?path=${encodeURIComponent(path)}`, { credentials: "same-origin" })
    // A page that isn't there still comes with the rest of its payload (404, or 410 for a deleted issue)
    if (!res.ok && res.status !== 404 && res.status !== 410) throw await failure(res)
    return { payload: (await res.json()) as PagePayload, status: res.status }
  })().finally(() => inflight.delete(path))
  inflight.set(path, p)
  return p
}

/**
 * One request for a whole page (in-app navigation, prefetch on intent). Its main content goes through load(), so a
 * page mounting meanwhile waits for this request instead of starting its own; the rest is seeded on arrival.
 */
export function loadPage(path: string): Promise<unknown> {
  const r = routeOf(path)
  const key = routeKey(r)
  if (!key) return fetchPage(path).then(({ payload, status }) => seedPage(payload, r, status))
  return load(key, () =>
    fetchPage(path).then(({ payload, status }) => {
      seedPage(payload, r, status, key)
      return contentOf(payload, r, status)
    }),
  )
}

/** Warms a page on intent (hover, focus, press) unless its content is fresh or already on its way. */
export function prefetchPage(path: string, maxAge = 15_000) {
  const key = routeKey(routeOf(path))
  if (!key || fresh(key, maxAge)) return
  loadPage(path).catch(() => {})
}
