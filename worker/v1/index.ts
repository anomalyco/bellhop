import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { bad, denied, fail, input, missing, sha256, type Bindings, type Ctx } from "../core"
import * as server from "./server"
import { apiEscalate } from "../handoff-routes"
import { consume, jwks, listApprovals } from "../approvals"
import { enforce, clientIP } from "../rate-limits"
import { authorize, checkHost, cors, preflightAllowed, type Auth, type Scope } from "./access"
import { mintTicket, upgrade, revokeStream } from "./realtime"
import { upload } from "./uploads"
import { startEmail, mint, patchMe, refresh, workspace } from "./sessions"
import { conversations, items, mark, open, postMessage, typing, confirm, target } from "./conversations"
import { replay } from "./replay"
import { schemas, ref, string, type Schema } from "./schemas"
import { feedbackCors, feedbackLimits, submitFeedback } from "../feedback"

type Action = (c: Ctx, s: Scope, b: Record<string, unknown>, id: string, number: number, seed?: string) => unknown
type Route = {
  method: "GET" | "PATCH" | "POST" | "DELETE" | "PUT"
  path: string
  auth: Auth | "ticket" | "report"
  transport?: "multipart" | "socket"
  request?: keyof typeof schemas
  response: keyof typeof schemas
  run: Action
  workspace?: Action
  status?: 200 | 201
  query?: Record<string, Schema>
}
const conv = "/conversations/:id"
// The dispatcher, OPTIONS and OpenAPI all enumerate this same table. No other v1 router is exported.
export const routes: Record<string, Route> = {
  submitFeedback: {
    method: "POST",
    path: "/feedback",
    auth: "report",
    request: "FeedbackInput",
    response: "FeedbackCreated",
    status: 201,
    run: (c) => submitFeedback(c)
  },
  escalateConversation: {
    method: "POST",
    path: conv + "/escalate",
    auth: "shared",
    request: "EscalateInput",
    response: "Conversation",
    run: apiEscalate
  },
  approvalKeys: {
    method: "GET",
    path: "/approvals/jwks.json",
    auth: "public",
    response: "JWKS",
    query: { workspace: string },
    run: (c) => jwks(c.env, c.req.query("workspace"))
  },
  consumeApproval: {
    method: "POST",
    path: "/approvals/:id/consume",
    auth: "server",
    response: "Approval",
    run: (c, s, _b, id) => consume(c, s, id)
  },
  listApprovals: {
    method: "GET",
    path: conv + "/approvals",
    auth: "server",
    response: "Approvals",
    run: (c, s, _b, id) => listApprovals(c, s, id)
  },
  workspace: { method: "GET", path: "/workspace", auth: "widget", response: "Workspace", run: workspace },
  refreshSession: { method: "POST", path: "/session/refresh", auth: "session", response: "Session", run: refresh },
  listContacts: {
    method: "GET",
    path: "/contacts",
    auth: "server",
    query: { q: string, cursor: string },
    response: "Contacts",
    run: server.listContacts
  },
  getContactBySubject: {
    method: "GET",
    path: "/contacts/by-external-id/:external_id",
    auth: "server",
    response: "Contact",
    run: server.getContact
  },
  upsertContact: {
    method: "PUT",
    path: "/contacts/by-external-id/:external_id",
    auth: "server",
    request: "ContactInput",
    response: "Contact",
    run: server.upsert
  },
  getContact: { method: "GET", path: "/contacts/:id", auth: "server", response: "Contact", run: server.getContact },
  eraseContact: { method: "DELETE", path: "/contacts/:id", auth: "server", response: "OK", run: server.erase },
  updateConversation: {
    method: "PATCH",
    path: conv,
    auth: "server",
    request: "ConversationPatch",
    response: "Conversation",
    run: (c, s, b, id, n) => server.patchConversation(c, s, id, n, b)
  },
  requestVerification: {
    method: "POST",
    path: conv + "/verifications",
    auth: "server",
    request: "VerificationInput",
    response: "Verification",
    status: 201,
    run: (c, s, b, _id, n) => server.requestProof(c, s, n, b)
  },
  upload: {
    method: "POST",
    path: "/uploads",
    auth: "session",
    transport: "multipart",
    request: "MultipartFile",
    response: "Upload",
    status: 201,
    run: upload
  },
  realtime: {
    method: "POST",
    path: "/realtime",
    auth: "session",
    response: "RealtimeTicket",
    run: (c, s, _b, _id, _n, seed) => mintTicket(c, s, seed)
  },
  connectRealtime: {
    method: "GET",
    path: "/realtime",
    auth: "ticket",
    transport: "socket",
    response: "RealtimeEvent",
    run: upgrade
  },
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
    auth: "email",
    request: "EmailStart",
    response: "OK",
    run: (c, s, b, _id, _n, seed) => startEmail(c, s, b, seed)
  },
  verifyEmail: {
    method: "POST",
    path: "/sessions/email/verify",
    auth: "email",
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
    run: revokeStream
  },
  getMe: { method: "GET", path: "/me", auth: "session", response: "EndUser", run: (_c, s) => s.user },
  updateMe: { method: "PATCH", path: "/me", auth: "session", request: "Profile", response: "EndUser", run: patchMe },
  listConversations: {
    method: "GET",
    path: "/conversations",
    auth: "shared",
    workspace: (c, s) => server.workspaceConversations(c, s),
    response: "Conversations",
    query: {
      cursor: string,
      status: { enum: ["open", "closed", "in_progress", "waiting"] },
      q: string,
      contact_id: string
    },
    run: (c, s) => conversations(c, s)
  },
  createConversation: {
    method: "POST",
    path: "/conversations",
    auth: "shared",
    workspace: server.openFor,
    request: "ConversationInput",
    response: "Conversation",
    run: open,
    status: 201
  },
  getConversation: {
    method: "GET",
    path: conv,
    auth: "shared",
    workspace: async (c, s, _b, id) => (await server.workspaceConversations(c, s, id)).data[0],
    response: "Conversation",
    run: async (c, s, _, id) => (await conversations(c, s, id)).data[0]
  },
  listItems: {
    method: "GET",
    path: conv + "/items",
    auth: "shared",
    workspace: (c, s, _b, id) => items(c, s, id, true),
    response: "Items",
    query: { cursor: string, after: string, before: string, last: { type: "integer", minimum: 1, maximum: 100 } },
    run: (c, s, _, id) => items(c, s, id)
  },
  postMessage: {
    method: "POST",
    path: conv + "/messages",
    auth: "shared",
    workspace: (c, s, b, id, n) => server.replyAs(c, s, id, n, b),
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
    session: [{ session: [] }],
    ticket: [{ socketTicket: [] }],
    server: [{ secret: [] }],
    shared: [{ secret: [] }, { session: [] }],
    widget: [{ publishable: [] }, { session: [] }],
    email: [{ publishable: [] }, { session: [] }],
    report: [{ reportKey: [] }]
  },
  media = (name: string) => ({ "application/json": { schema: ref(name) } })
export function document() {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const [name, r] of Object.entries(routes)) {
    const path = r.path.replace(/:(\w+)/g, "{$1}")
    const parameters = [...r.path.matchAll(/:(\w+)/g)]
      .map((m) => ({ in: "path", name: m[1]!, required: true, schema: string }))
      .concat(
        Object.entries(r.query ?? {}).map(([k, v]) => ({
          in: "query",
          name: k,
          required: name==='approvalKeys' && k==='workspace',
          schema: v as typeof string
        }))
      )
    const idempotent =
      name !== "consumeApproval" &&
      ((r.method === "POST" && !["/realtime", "/session/refresh"].includes(r.path)) ||
        (r.auth === "server" && r.method !== "GET"))
    if (idempotent) parameters.push({ in: "header", name: "Idempotency-Key", required: false, schema: string })
    if (name === "verifyEmail" || name === "startEmail")
      parameters.push({ in: "header", name: "Challenge-Token", required: name === "verifyEmail", schema: string })
    const responses: Record<string, unknown> = {
      [r.transport === "socket" ? 101 : (r.status ?? 200)]: {
        description: "Success",
        ...(r.transport === "socket" ? { "x-websocket-frame": ref(r.response) } : { content: media(r.response) }),
        ...(name === "startEmail"
          ? {
              headers: {
                "Challenge-Token": { description: "Opaque browser challenge; echo on verify.", schema: string }
              }
            }
          : {})
      }
    }
    for (const [code, description] of Object.entries(name === "submitFeedback" ? feedbackErrors : {
      ...(name === "consumeApproval" ? { 409: "Already used", 410: "Pending, rejected, or expired" } : {}),
      404: "not_found: unknown host, resource not found or not owned",
      429: "rate_limited, idempotency_limit or code_limit; retry after the indicated delay",
      500: "internal_error",
      ...(r.transport === "socket" ? { 426: "upgrade_required" } : {}),
      ...(r.auth !== "public"
        ? {
            401: "invalid_credential, invalid_identity or contact_required",
            403: "forbidden, helpdesk_only, anonymous_disabled, blocked or locked"
          }
        : {}),
      ...(r.query || r.request || r.method === "POST"
        ? { 400: "invalid_input, invalid_code or invalid_attachment" }
        : {}),
      ...(idempotent
        ? { 409: "conflict or request_pending", 422: "idempotency_mismatch: key reused with different input" }
        : {}),
      ...(r.transport === "multipart"
        ? {
            413: "too_large or upload_byte_quota",
            415: "expected_multipart or unsupported_video",
            503: "misconfigured"
          }
        : r.request || r.method === "POST"
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
      ...(r.auth === "email"
        ? {
            description:
              "Publishable key, or an anonymous session on its allowed origin. Verifying with the anonymous bearer claims only that session’s history and revokes it."
          }
        : {}),
      ...(name === "submitFeedback" ? { description: feedbackDescription } : {}),
      ...(name === "refreshSession"
        ? {
            description:
              "Verified sessions only. Issues a new bearer, invalidates the old bearer, and preserves the absolute 30-day lifetime. Not replayable."
          }
        : {}),
      ...(r.auth === "shared"
        ? {
            description:
              "A session receives only its own public conversation view. A secret key without Origin receives the workspace view, including marked staff-only items. For server creation supply contact; for replies supply as.member."
          }
        : {}),
      security: security[r.auth],
      parameters,
      ...(r.request
        ? {
            requestBody: {
              required: true,
              content:
                name === "submitFeedback"
                  ? {
                      ...media(r.request),
                      "multipart/form-data": {
                        schema: ref("FeedbackMultipart"),
                        encoding: {
                          payload: { contentType: "application/json" },
                          screenshot: { contentType: "image/png, image/jpeg, image/webp" }
                        }
                      }
                    }
                  : r.transport === "multipart"
                    ? { "multipart/form-data": { schema: ref(r.request) } }
                    : media(r.request)
            }
          }
        : {}),
      responses
    }
  }
  return {
    openapi: "3.1.0",
    info: { title: "Help desk API", version: "1.0.0" },
    servers: [{ url: "https://api.blhp.app/v1" }],
    paths,
    components: {
      securitySchemes: {
        reportKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "bh_pub_…",
          description:
            "A workspace report key (Settings → Report keys): publishable, safe to ship in apps, names its workspace. Only uploads report metadata and sends feedback."
        },
        socketTicket: {
          type: "apiKey",
          in: "query",
          name: "ticket",
          description: "Single-use WebSocket ticket, valid 60 seconds."
        },
        ...Object.fromEntries(
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
        )
      },
      schemas
    }
  }
}
const L = feedbackLimits,
  MB = (n: number) => n / 1024 / 1024 + " MB"
const feedbackDescription = `Send in-app feedback as a private issue in the report key's workspace (on a workspace host, the key must be that workspace's; also POST /api/apps/{slug}/feedback). The submitter has no web view: with an email (and not anonymous) Bellhop sends one confirmation email, and once it's confirmed public replies are emailed and email replies post back. Anonymous sends keep no email, user, install id or logs. JSON with base64 screenshots, or multipart/form-data with a payload part (FeedbackInput as JSON, without screenshots) and up to ${L.screenshots} screenshot file parts. Screenshots are PNG, JPEG or WebP (checked by content), each <= ${MB(L.screenshot)}, <= ${MB(L.screenshotTotal)} in total; the whole request <= ${MB(L.request)}. Limits: ${L.perIpMinute} per minute per IP, ${L.perKeyMinute} per minute per key, ${L.perInstallHour} per hour per install_id, ${L.perKeyDay} per day and ${MB(L.bytesPerKeyDay)} per day per key. CORS is open to any origin. Retries: send an Idempotency-Key and retry with the same key and the same feedback (for multipart, the same payload part and screenshot files); the first answer comes back for 24 hours, with no second issue or confirmation email. The key is per report key; the same key with different feedback is a 422, and a retry while the first is still running a 409 with Retry-After. Client errors replay for 5 minutes.`
const feedbackErrors = {
  400: "invalid_input: a field is missing, too long or of the wrong type (at most 5 screenshots)",
  401: "invalid_report_key: missing, unknown or revoked report key (or another workspace's, on a workspace host)",
  403: "feedback_unavailable: help desk workspaces don't take feedback; blocked: this install is blocked",
  404: "not_found: unknown host",
  413: "too_large (a screenshot, the screenshots or the request) or feedback_byte_quota (the key's daily bytes)",
  415: "unsupported_media_type: not JSON or multipart, or a screenshot that isn't a PNG, JPEG or WebP image",
  409: "request_pending: a request with this Idempotency-Key is still running; retry after the indicated delay",
  422: "idempotency_mismatch: the Idempotency-Key was used for different feedback",
  429: "rate_limited (per IP), key_rate_limited (per key per minute), install_rate_limited (per install per hour), feedback_daily_limit (per key per day) or idempotency_limit (1000 active keys per report key and IP); retry after the indicated delay",
  500: "internal_error",
  503: "misconfigured"
}
export function publicApi() {
  const api = new Hono<Bindings>()
  api.use("*", async (c, next) => {
    checkHost(c)
    c.header("Cache-Control", "no-store")
    c.header("Vary", "Origin")
    if (c.req.method !== "OPTIONS") {
      const entry =
        c.req.path.startsWith("/v1/sessions") ||
        (c.req.path === "/v1/realtime" && c.req.method === "GET") ||
        !/^Bearer bh_(pk|sk|us)_[0-9a-f]{64}$/i.test(c.req.header("Authorization") ?? "")
      await enforce(c, entry ? "RL_AGENT" : "RL_V1_IP", (entry ? "v1:entry:" : "v1:ip:") + clientIP(c))
    }
    await next()
  })
  api.use("*", (c, next) =>
    (c.req.path === "/v1/uploads" || c.req.path === "/v1/feedback") && c.req.method === "POST"
      ? next()
      : bodyLimit({
          maxSize: 512 * 1024,
          onError: (c) => c.json({ error: { code: "too_large", message: "JSON payload too large" } }, 413)
        })(c, next)
  )
  for (const path of new Set(Object.values(routes).map((r) => r.path))) {
    const methods = Object.values(routes)
      .filter((r) => r.path === path && r.auth !== "server")
      .map((r) => r.method)
    api.options(path, async (c) => {
      // Report keys are meant for apps: feedback is open to any origin.
      if (path === "/feedback") {
        feedbackCors(c)
        return c.body(null, 204)
      }
      const origin = c.req.header("Origin")
      if (
        !origin ||
        !methods.some((m) => m === c.req.header("Access-Control-Request-Method")) ||
        !(await preflightAllowed(c, origin))
      )
        denied()
      cors(c, origin)
      c.header("Access-Control-Max-Age", "86400")
      c.header("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers")
      c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, Challenge-Token")
      c.header("Access-Control-Allow-Methods", methods.join(", "))
      return c.body(null, 204)
    })
  }
  for (const r of Object.values(routes))
    api.on(r.method, r.path, async (c) => {
      if (r.auth === "public") {
        if (r.response === "JWKS") {
          const keys=await jwks(c.env,c.req.query('workspace'))
          c.header("Cache-Control", "public, max-age=300")
          return c.json(keys)
        }
        return c.json(document())
      }
      if (r.auth === "ticket") return upgrade(c)
      if (r.auth === "report") return submitFeedback(c)
      // Malformed mint attempts pay only the ingress IP check: no D1 or key budget.
      if (r.method === "POST" && r.path.startsWith("/sessions")) {
        const prefix = /^Bearer bh_(pk|sk)_[a-f0-9]{64}$/i.exec(c.req.header("Authorization") ?? "")?.[1]
        if ((prefix === "sk" && c.req.raw.headers.has("Origin")) || (prefix === "pk" && !c.req.header("Origin")))
          denied()
        if (prefix) {
          let value: unknown
          try {
            value = JSON.parse(await c.req.text())
          } catch {
            bad("Invalid JSON")
          }
          const b = input(value)
          if (r.path === "/sessions") {
            if (prefix === "sk") {
              if (typeof input(b.user).id !== "string") bad("user.id must be a string")
            } else if (!b.identity_token && b.anonymous !== true) bad("Expected identity_token or anonymous: true")
          } else if (typeof b.email !== "string") bad("Expected email")
        }
      }
      const s = await authorize(c, r.auth),
        id = c.req.param("id") ?? "",
        workspace = !s.user && s.kind === "secret",
        n =
          id && r.path.startsWith(conv)
            ? workspace
              ? await server.workspaceTarget(c, s, id)
              : await target(c, s, id)
            : 0
      if (
        !workspace &&
        r.auth === "shared" &&
        (c.req.query("contact_id") !== undefined || c.req.query("q") !== undefined)
      )
        denied()
      if (r.transport === "multipart") return upload(c, s)
      const raw = r.method !== "GET" ? await c.req.text() : ""
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
        if (
          r.auth === "shared" &&
          !workspace &&
          (b.as !== undefined || b.contact !== undefined || (b.internal !== undefined && b.internal !== false))
        )
          denied()
        if (
          r.path === "/conversations" &&
          r.method === "POST" &&
          b.message &&
          typeof b.message === "object" &&
          ("as" in b.message || ("internal" in b.message && b.message.internal !== false))
        )
          bad("The opening message is authored by the requester and cannot be internal")
        return c.json(await (workspace && r.workspace ? r.workspace : r.run)(c, s, b, id, n, seed), r.status ?? 200)
      }
      const pathname = new URL(c.req.url).pathname,
        route =
          r.method === "POST"
            ? pathname
            : r.method +
              " " +
              (c.req.param("external_id") !== undefined
                ? "/v1/contacts/by-external-id/" + (await sha256(c.req.param("external_id")!))
                : pathname)
      if (r.path === "/approvals/:id/consume") return run() // A replay must never authorize a second action.
      return (r.method === "POST" && !["/realtime", "/session/refresh"].includes(r.path)) ||
        (workspace && r.method !== "GET")
        ? replay(c, s, route, raw, run)
        : run()
    })
  api.all("*", () => missing())
  return api
}
