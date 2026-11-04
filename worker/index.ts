import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { apps, loadApp } from "./apps"
import { auth, currentUser, firstContact } from "./auth"
import { ApiFailure, dbError, denied, missing, sql } from "./core"
import type { Bindings, Ctx } from "./core"
import { appRoom, issueRoom } from "./events"
import { icons } from "./icons"
import { issueNumber } from "./issues"
import { issues } from "./mutations"
import { media } from "./media"
import { mcp } from "./mcp"
import { oauth } from "./oauth"
import { queue } from "./webhooks"
export { Room } from "./room"

const api = new Hono<Bindings>()
const limit = bodyLimit({
  maxSize: 512 * 1024,
  onError: (c) => c.json({ error: { code: "too_large", message: "JSON payload too large" } }, 413)
})
api.use("*", async (c, next) => {
  if (!c.req.path.startsWith("/media/")) c.header("Cache-Control", "no-store")
  const publicOAuth = /^\/oauth\/(register|device|token|revoke)$/.test(c.req.path) || c.req.path.startsWith("/.well-known/")
  if (publicOAuth) {
    // Machine endpoints never use browser sessions. Consent and account APIs keep the usual origin guard.
    c.header("Access-Control-Allow-Origin", "*")
    c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    c.header("Access-Control-Allow-Headers", "Content-Type, Accept")
    if (c.req.method === "OPTIONS") return c.body(null, 204)
  }
  if (!publicOAuth && c.req.path !== "/mcp" && !c.req.path.startsWith("/icon/")) firstContact(c)
  const origin = c.req.header("origin")
  // Behind a TLS-terminating proxy the request URL is http while the browser's Origin is PUBLIC_ORIGIN.
  const allowed = origin === new URL(c.req.url).origin || (!!c.env.PUBLIC_ORIGIN && origin === c.env.PUBLIC_ORIGIN)
  if (!publicOAuth && origin && !allowed && (c.req.method !== "GET" || c.req.header("upgrade"))) denied()
  if (c.req.path.startsWith("/api/") || c.req.path === "/oauth/authorize") await currentUser(c)
  if (["POST", "PUT", "PATCH"].includes(c.req.method) && !/^\/api\/apps\/[^/]+\/(uploads|icon)$/.test(c.req.path))
    return limit(c, next)
  await next()
})
api.use("/api/apps/:slug/*", async (c, next) => {
  await loadApp(c)
  await next()
})
api.route("/", auth)
api.route("/", oauth)
api.route("/", apps)
api.route("/", icons)
api.route("/", issues)
api.route("/", media)
async function live(c: Ctx, number?: string) {
  const app = await sql(c.env, "SELECT id FROM apps WHERE slug=?", c.req.param("slug")).first<string>("id")
  if (!app) missing()
  let room = appRoom(c.env, app)
  if (number !== undefined) {
    const id = await sql(
      c.env,
      "SELECT id FROM issues WHERE app_id=? AND number=?",
      app,
      issueNumber(number)
    ).first<string>("id")
    if (!id) missing()
    room = issueRoom(c.env, id)
  }
  return room.fetch(c.req.raw)
}
api.get("/api/live/apps/:slug", (c) => live(c))
api.get("/api/live/apps/:slug/issues/:number", (c) => live(c, c.req.param("number")))
api.route("/", mcp)
api.notFound((c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404))
api.onError((e, c) => {
  const err = e instanceof ApiFailure ? e : dbError(e)
  if (err) return c.json({ error: { code: err.code, message: err.message } }, err.status)
  console.error("bellhop.request_failed", { method: c.req.method, path: c.req.path, message: e.message })
  return c.json({ error: { code: "internal_error", message: "Internal server error" } }, 500)
})
export default { fetch: api.fetch, queue }
