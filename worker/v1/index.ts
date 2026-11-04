import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { bad, denied, fail, input, missing, sql, type Bindings, type Ctx } from "../core"
import { enforce, clientIP } from "../rate-limits"
import { authorize, checkHost, cors, type Auth, type Scope } from "./access"
import { startEmail, mint, patchMe } from "./sessions"
import { conversations, items, mark, open, postMessage, typing, confirm, target } from "./conversations"
import { replay } from "./replay"
import { schemas, ref, string, type Schema } from "./schemas"

type Action = (c: Ctx, s: Scope, b: Record<string, unknown>, id: string, number: number, seed?: string) => unknown
type Route = {
  method: "GET" | "PATCH" | "POST" | "DELETE"
  path: string
  auth: Auth
  request?: keyof typeof schemas
  response: keyof typeof schemas
  run: Action
  status?: 200 | 201
  query?: Record<string, Schema>
}
const conv = "/conversations/:id"
// The dispatcher, OPTIONS and OpenAPI all enumerate this same table. No other v1 router is exported.
export const routes: Record<string, Route> = {
  openapi: { method: "GET", path: "/openapi.json", auth: "public", response: "OpenAPI", run: () => document() },
  createSession: {
    method: "POST",
    path: "/sessions",
    auth: "key",
    request: "SessionInput",
    response: "Session",
    run: (c, s, b, _id, _n, seed) => mint(c, s, b, false, seed),
    status: 201
  },
  startEmail: {
    method: "POST",
    path: "/sessions/email",
    auth: "publishable",
    request: "EmailStart",
    response: "OK",
    run: (c, s, b, _id, _n, seed) => startEmail(c, s, b, seed)
  },
  verifyEmail: {
    method: "POST",
    path: "/sessions/email/verify",
    auth: "publishable",
    request: "EmailVerify",
    response: "Session",
    run: (c, s, b, _id, _n, seed) => mint(c, s, b, true, seed),
    status: 201
  },
  revokeSession: {
    method: "DELETE",
    path: "/session",
    auth: "session",
    response: "OK",
    run: async (c, s) => {
      await sql(c.env, "DELETE FROM api_sessions WHERE hash=?", s.hash).run()
      return { ok: true }
    }
  },
  getMe: { method: "GET", path: "/me", auth: "session", response: "EndUser", run: (_c, s) => s.user },
  updateMe: { method: "PATCH", path: "/me", auth: "session", request: "Profile", response: "EndUser", run: patchMe },
  listConversations: {
    method: "GET",
    path: "/conversations",
    auth: "session",
    response: "Conversations",
    query: { cursor: string, status: { enum: ["open", "closed"] } },
    run: (c, s) => conversations(c, s)
  },
  createConversation: {
    method: "POST",
    path: "/conversations",
    auth: "session",
    request: "ConversationInput",
    response: "Conversation",
    run: open,
    status: 201
  },
  getConversation: {
    method: "GET",
    path: conv,
    auth: "session",
    response: "Conversation",
    run: async (c, s, _, id) => (await conversations(c, s, id)).data[0]
  },
  listItems: {
    method: "GET",
    path: conv + "/items",
    auth: "session",
    response: "Items",
    query: { cursor: string, after: string },
    run: (c, s, _, id) => items(c, s, id)
  },
  postMessage: {
    method: "POST",
    path: conv + "/messages",
    auth: "session",
    request: "MessageInput",
    response: "Message",
    status: 201,
    run: (c, s, b, id, n) => postMessage(c, s, id, n, b)
  },
  markRead: {
    method: "POST",
    path: conv + "/read",
    auth: "session",
    request: "Read",
    response: "OK",
    run: (c, s, b, id) => mark(c, s, id, b)
  },
  typing: {
    method: "POST",
    path: conv + "/typing",
    auth: "session",
    response: "OK",
    run: (c, s, _, id) => typing(c, s, id)
  },
  confirmVerification: {
    method: "POST",
    path: conv + "/verifications/:vid/confirm",
    auth: "session",
    request: "Confirm",
    response: "Verification",
    run: (c, s, b, id) => confirm(c, s, id, c.req.param("vid")!, b)
  }
}
const security = {
    public: [],
    key: [{ publishable: [] }, { secret: [] }],
    publishable: [{ publishable: [] }],
    session: [{ session: [] }]
  },
  media = (name: string) => ({ "application/json": { schema: ref(name) } })
function document() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [name, r] of Object.entries(routes)) {
    const path = r.path.replace(/:(\w+)/g, "{$1}")
    const parameters = [...r.path.matchAll(/:(\w+)/g)]
      .map((m) => ({ in: "path", name: m[1]!, required: true, schema: string }))
      .concat(
        Object.entries(r.query ?? {}).map(([k, v]) => ({
          in: "query",
          name: k,
          required: false,
          schema: v as typeof string
        }))
      )
    if (r.method === "POST") parameters.push({ in: "header", name: "Idempotency-Key", required: false, schema: string })
    if (name === "verifyEmail" || name === "startEmail")
      parameters.push({ in: "header", name: "Challenge-Token", required: name === "verifyEmail", schema: string })
    const responses: Record<string, unknown> = {
      [r.status ?? 200]: {
        description: "Success",
        content: media(r.response),
        ...(name === "startEmail"
          ? {
              headers: {
                "Challenge-Token": { description: "Opaque browser challenge; echo on verify.", schema: string }
              }
            }
          : {})
      }
    }
    for (const [code, description] of Object.entries({
      404: "not_found: unknown host, resource not found or not owned",
      429: "rate_limited or code_limit; retry after the indicated delay",
      500: "internal_error",
      ...(r.auth !== "public"
        ? {
            401: "invalid_credential, invalid_identity or contact_required",
            403: "forbidden, helpdesk_only, anonymous_disabled, blocked or locked"
          }
        : {}),
      ...(r.query || r.request || r.method === "POST"
        ? { 400: "invalid_input, invalid_code or invalid_attachment" }
        : {}),
      ...(r.method === "POST"
        ? { 409: "conflict or request_pending", 422: "idempotency_mismatch: key reused with different input" }
        : {}),
      ...(r.request || r.method === "POST"
        ? { 413: "too_large", 415: "expected_json", 503: "misconfigured, mail_unavailable or conversation_upgrading" }
        : {}),
      ...(name === "createConversation" ? { 410: "expired: report metadata is no longer available" } : {}),
      ...(name === "createSession" || name === "startEmail" ? { 428: "human_required", 502: "siteverify_failed" } : {})
    }))
      responses[code] = {
        description,
        content: media("Error"),
        ...(code === "429" ? { headers: { "Retry-After": { schema: string } } } : {})
      }
    ;(paths[path] ??= {})[r.method.toLowerCase()] = {
      operationId: name,
      security: security[r.auth],
      parameters,
      ...(r.request ? { requestBody: { required: true, content: media(r.request) } } : {}),
      responses
    }
  }
  return {
    openapi: "3.1.0",
    info: { title: "Help desk API", version: "1.0.0" },
    servers: [{ url: "https://api.blhp.app/v1" }],
    paths,
    components: {
      securitySchemes: Object.fromEntries(
        ["secret", "publishable", "session"].map((kind, i) => [
          kind,
          {
            type: "http",
            scheme: "bearer",
            bearerFormat: ["bh_sk_…", "bh_pk_…", "bh_us_…"][i],
            description: [
              "Server only; Origin must be absent.",
              "Requires an exactly allowed Origin.",
              "24-hour end-user bearer. Browser origins must be allowed."
            ][i]
          }
        ])
      ),
      schemas
    }
  }
}
export function publicApi() {
  const api = new Hono<Bindings>()
  api.use("*", async (c, next) => {
    checkHost(c)
    c.header("Cache-Control", "no-store")
    c.header("Vary", "Origin")
    await enforce(c, "RL_IP", "v1:ip:" + clientIP(c))
    await next()
  })
  api.use(
    "*",
    bodyLimit({
      maxSize: 512 * 1024,
      onError: (c) => c.json({ error: { code: "too_large", message: "JSON payload too large" } }, 413)
    })
  )
  for (const path of new Set(Object.values(routes).map((r) => r.path))) {
    const methods = Object.values(routes)
      .filter((r) => r.path === path)
      .map((r) => r.method)
    api.options(path, async (c) => {
      const origin = c.req.header("Origin"),
        domain = c.env.APP_DOMAIN,
        h = new URL(c.req.url).hostname,
        slug = domain && h !== `api.${domain}` ? h.slice(0, -domain.length - 1) : null
      if (
        !origin ||
        !methods.some((m) => m === c.req.header("Access-Control-Request-Method")) ||
        !(await sql(
          c.env,
          `SELECT 1 FROM api_origins o JOIN api_keys k ON k.id=o.key_id JOIN apps a ON a.id=k.app_id WHERE origin=? AND mode='helpdesk' AND (? IS NULL OR slug=?) LIMIT 1`,
          origin,
          slug,
          slug
        ).first())
      )
        denied()
      cors(c, origin)
      c.header("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, Challenge-Token")
      c.header("Access-Control-Allow-Methods", methods.join(", "))
      return c.body(null, 204)
    })
  }
  for (const r of Object.values(routes))
    api.on(r.method, r.path, async (c) => {
      if (r.auth === "public") return c.json(document())
      const s = await authorize(c, r.auth),
        id = c.req.param("id") ?? "",
        n = id ? await target(c, s, id) : 0
      const raw = r.method === "POST" || r.method === "PATCH" ? await c.req.text() : ""
      const run = async (seed?: string) => {
        let b: Record<string, unknown> = {}
        if (raw) {
          if (c.req.header("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
            fail(415, "expected_json", "Expected JSON")
          let value: unknown
          try {
            value = JSON.parse(raw)
          } catch {
            bad("Invalid JSON")
          }
          b = input(value)
        } else if (r.request) bad("Expected a JSON object")
        return c.json(await r.run(c, s, b, id, n, seed), r.status ?? 200)
      }
      return r.method === "POST" ? replay(c, s, new URL(c.req.url).pathname, raw, run) : run()
    })
  api.all("*", () => missing())
  return api
}
