import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { apps, detail, loadApp } from "./apps"
import { auth, currentUser, firstContact } from "./auth"
import { ApiFailure, dbError, denied, missing, reservedSlugs, sql } from "./core"
import type { Bindings, Ctx } from "./core"
import { appRoom, feedRoom, issueRoom } from "./events"
import { icons } from "./icons"
import { feed, feedApps, getIssue, issueNumber, listIssues } from "./issues"
import { bySlug } from "./read-scope"
import { issues } from "./mutations"
import { media } from "./media"
import { mcp } from "./mcp"
import { oauth } from "./oauth"
import { agents } from "./agents"
import { queue } from "./webhooks"
import { page, robots, sitemap } from "./pages"
export { Room } from "./room"

const api = new Hono<Bindings>()
const limit = bodyLimit({
  maxSize: 512 * 1024,
  onError: (c) => c.json({ error: { code: "too_large", message: "JSON payload too large" } }, 413)
})
api.use("*", async (c, next) => {
  if (!c.req.path.startsWith("/media/")) c.header("Cache-Control", "no-store")
  const publicOAuth =
    /^\/oauth\/(register|device|token|revoke)$/.test(c.req.path) || c.req.path.startsWith("/.well-known/")
  if (publicOAuth) {
    // Machine endpoints never use browser sessions. Consent and account APIs keep the usual origin guard.
    c.header("Access-Control-Allow-Origin", "*")
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    c.header("Access-Control-Allow-Headers", "Content-Type, Accept")
    if (c.req.method === "OPTIONS") return c.body(null, 204)
  }
  if (
    !publicOAuth &&
    (/^\/(api|auth)\//.test(c.req.path) || c.req.path === "/oauth/authorize") &&
    !/^\/api\/feed(?:\/|$)/.test(c.req.path)
  )
    firstContact(c)
  const origin = c.req.header("origin")
  // Behind a TLS-terminating proxy the request URL is http while the browser's Origin is PUBLIC_ORIGIN.
  const allowed = origin === new URL(c.req.url).origin || (!!c.env.PUBLIC_ORIGIN && origin === c.env.PUBLIC_ORIGIN)
  if (!publicOAuth && origin && !allowed && (c.req.method !== "GET" || c.req.header("upgrade"))) denied()
  if (
    (c.req.path.startsWith("/api/") && !/^\/api\/(live\/|feed(?:\/|$))/.test(c.req.path)) ||
    c.req.path === "/oauth/authorize"
  )
    await currentUser(c)
  if (["POST", "PUT", "PATCH"].includes(c.req.method) && !/^\/api\/apps\/[^/]+\/(uploads|icon)$/.test(c.req.path))
    return limit(c, next)
  await next()
})
// These readers include their app/role lookup in their own batch; other routes still load the
// complete actor and app context before handling writes or checking workspace permissions.
api.get("/api/apps/:slug", async (c) => c.json(await detail(c, bySlug(c))))
api.get("/api/feed", async (c) => c.json(await feed(c.env, c.req.query())))
api.get("/api/feed/apps", async (c) => c.json(await feedApps(c.env)))
api.get("/api/apps/:slug/issues", async (c) => {
  const { state, label, cursor, q } = c.req.query()
  return c.json(await listIssues(c.env, bySlug(c), { state, label, cursor, query: q }))
})
api.get("/api/apps/:slug/issues/:number", async (c) =>
  c.json(await getIssue(c.env, bySlug(c), issueNumber(c.req.param("number"))))
)
api.use("/api/apps/:slug/*", async (c, next) => {
  await loadApp(c)
  await next()
})
api.route("/", auth)
api.route("/", oauth)
api.route("/", agents)
api.route("/", apps)
api.route("/", icons)
api.route("/", issues)
api.route("/", media)
async function live(c: Ctx, number?: string) {
  const slug = c.req.param("slug")
  const query =
    number === undefined
      ? sql(c.env, "SELECT id FROM apps WHERE slug=?", slug)
      : sql(
          c.env,
          "SELECT i.id FROM apps a JOIN issues i ON i.app_id=a.id WHERE a.slug=? AND i.number=?",
          slug,
          issueNumber(number)
        )
  const id = await query.first<string>("id")
  if (!id) missing()
  return (number === undefined ? appRoom(c.env, id) : issueRoom(c.env, id)).fetch(c.req.raw)
}
api.get("/api/live/apps/:slug", (c) => live(c))
api.get("/api/live/apps/:slug/issues/:number", (c) => live(c, c.req.param("number")))
api.get("/api/live/feed", (c) => feedRoom(c.env).fetch(c.req.raw))
api.route("/", mcp)
api.get("/robots.txt", robots)
api.get("/sitemap.xml", sitemap)
api.get("*", (c) => {
  // Never turn unknown API/protocol routes into successful SPA documents.
  const path = c.req.path
  if (/^\/(api|auth|media|icon|mcp|\.well-known)(\/|$)/.test(path)) return c.notFound()
  if (/^\/oauth(?:\/|$)/.test(path) && (/^\/oauth\/(register|authorize|device|token|revoke)\/?$/.test(path) || !c.req.header("accept")?.includes("text/html"))) return c.notFound()
  if (!c.env.APP_DOMAIN) {
    if (/^\/(?:@|src\/|node_modules\/)/.test(path)) return c.env.ASSETS.fetch(c.req.raw)
    const meta = /^\/([a-z0-9-]+)\/(robots\.txt|sitemap\.xml)$/.exec(path)
    if (meta && !reservedSlugs.has(meta[1]!)) return meta[2] === "robots.txt" ? robots(c) : sitemap(c)
  }
  return page(c)
})
api.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404))
api.onError((e, c) => {
  const err = e instanceof ApiFailure ? e : dbError(e)
  if (err) return c.json({ error: { code: err.code, message: err.message } }, err.status)
  console.error("bellhop.request_failed", { method: c.req.method, path: c.req.path, message: e.message })
  return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500)
})
export default { fetch: api.fetch, queue }
