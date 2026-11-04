import type { Context } from "hono"
import type { Actor, App, Locale, Me } from "../shared/api"

export type User = NonNullable<Me["user"]>
export type Bindings = {
  Bindings: Env
  Variables: {
    guestId: string
    existingGuest: boolean
    guestHash: string
    aliases: string[]
    user: User | null
    accountLocale: Locale | null
    app: App
    actor: Actor
  }
}
export type Ctx = Context<Bindings>
export const now = () => new Date().toISOString()
export const uid = () => crypto.randomUUID()
export const hex = (value: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("")
export const secret = () => hex(crypto.getRandomValues(new Uint8Array(32)))
export const sha256 = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
export const scopedGuestId = async (id: string, scope: string) => (await sha256(`${id}:${scope}`)).slice(0, 32)
export const sql = (env: Env, statement: string, ...values: unknown[]) => env.DB.prepare(statement).bind(...values)
/** With APP_DOMAIN (production) each app lives on its own subdomain; without it (dev) under /<slug>. */
export function appUrl(env: Env, origin: string, slug: string, path = "/") {
  return env.APP_DOMAIN
    ? `https://${slug}.${env.APP_DOMAIN}${path}`
    : new URL(`/${slug}${path === "/" ? "" : path}`, origin).href
}
/** Slugs double as subdomains, so names with other meanings stay unavailable. */
export const reservedSlugs = new Set(
  "admin agents api app assets auth blog cdn dev device docs help icon mail mcp media new oauth oembed reports settings signin static status support workspaces www".split(
    " "
  )
)
export const rows = async <T>(stmt: D1PreparedStatement) => (await stmt.all<T>()).results

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 416 | 426 | 428 | 429 | 500 | 501 | 502 | 503
export class ApiFailure extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: string,
    message: string,
    readonly moved_to?: { slug: string; number: number; url: string }
  ) {
    super(message)
  }
}
export function fail(status: ErrorStatus, code: string, message: string): never {
  throw new ApiFailure(status, code, message)
}
export function bad(message: string): never {
  return fail(400, "invalid_input", message)
}
export function missing(): never {
  return fail(404, "not_found", "Not found")
}
export function denied(): never {
  return fail(403, "forbidden", "Not allowed")
}
export function input(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) bad("Expected an object")
  return value as Record<string, unknown>
}
export async function body(c: Ctx) {
  let value: unknown
  try {
    value = await c.req.json()
  } catch {
    bad("Invalid JSON")
  }
  return input(value)
}
export function str(value: unknown, key: string, max = 256, empty = false): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes("\0"))
    bad(`Invalid ${key}`)
  return value
}
export function email(value: unknown) {
  const e = str(value, "email", 254).trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) bad("Invalid email")
  return e
}
export function ids(value: unknown, key: string) {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 50) bad(`Invalid ${key}`)
  return [...new Set(value.map((v) => str(v, key, 64)))]
}
export function choice<T extends string>(v: unknown, choices: readonly T[], key: string): T {
  if (!choices.includes(v as T)) bad(`Invalid ${key}`)
  return v as T
}
export function memberActor(user: Pick<User, "id" | "name" | "avatar_url">, role: App["role"]): Actor {
  return { type: "member", id: user.id, name: user.name, avatar_url: user.avatar_url, role }
}
export function dbError(e: Error): ApiFailure | null {
  const message = `${e.message} ${e.cause ?? ""}`
  if (message.includes("confirmation_daily_limit"))
    return new ApiFailure(429, "confirmation_daily_limit", "Daily confirmation email limit reached")
  if (message.includes("report_daily_limit"))
    return new ApiFailure(429, "report_daily_limit", "Daily report key upload or byte limit reached")
  if (message.includes("invitation acceptance required"))
    return new ApiFailure(409, "invitation_required", "Accept the workspace invitation before joining")
  if (message.includes("expired report metadata")) return new ApiFailure(410, "expired", "Report metadata expired")
  if (message.includes("unknown report metadata")) return new ApiFailure(404, "not_found", "Report metadata not found")
  if (message.includes("report metadata already attached"))
    return new ApiFailure(409, "already_attached", "Report already attached")
  if (message.includes("tier requires human reply"))
    return new ApiFailure(403, "humans_only", "A human must reply on this issue; agents can leave internal notes")
  if (message.includes("invalid tier label") || message.includes("invalid tier assignee"))
    return new ApiFailure(400, "invalid_input", "Tier rules must use this workspace’s labels and joined team members")
  if (message.includes("outdated comment writer") || message.includes("internal notes not enabled"))
    return new ApiFailure(
      503,
      "conversation_upgrading",
      "Conversation permissions are being upgraded; try again shortly"
    )
  if (message.includes("internal notes require team"))
    return new ApiFailure(403, "forbidden", "Team membership required for internal notes")
  if (message.includes("NOT NULL constraint failed: apps.issue_seq"))
    return new ApiFailure(403, "forbidden", "Transfer requires triage access in both workspaces")
  if (message.includes("workspace pin limit"))
    return new ApiFailure(409, "pin_limit", "A workspace can pin at most three issues")
  if (message.includes("issue is locked"))
    return new ApiFailure(403, "locked", "Only the team can comment on this locked issue")
  if (message.includes("actor blocked") || message.includes("NOT NULL constraint failed: blocks.actor_id"))
    return new ApiFailure(403, "blocked", "You are blocked from writing in this workspace")
  if (message.includes("NOT NULL constraint failed: comments.issue_id"))
    return new ApiFailure(404, "not_found", "Not found")
  if (message.includes("NOT NULL constraint failed: comments.revision"))
    return new ApiFailure(409, "conflict", "Comment changed; try again")
  if (message.includes("last workspace owner"))
    return new ApiFailure(409, "last_owner", "The workspace must keep a signed-in owner")
  if (message.includes("NOT NULL constraint failed: agent_apps.app_id"))
    return new ApiFailure(400, "invalid_input", "Workspace or agent role exceeds your access")
  if (message.includes("NOT NULL constraint failed: agent_apps.agent_id"))
    return new ApiFailure(403, "forbidden", "Agent cannot create workspaces")
  if (message.includes("rate limited")) return new ApiFailure(429, "rate_limited", "Hourly limit reached")
  if (/invalid attachment|UNIQUE constraint failed: attachment_links/.test(message))
    return new ApiFailure(400, "invalid_attachment", "Attachment unavailable")
  if (message.includes("UNIQUE constraint failed")) return new ApiFailure(409, "conflict", "Already exists")
  if (message.includes("NOT NULL constraint failed: issues.revision"))
    return new ApiFailure(409, "conflict", "Issue changed; refresh and try again")
  if (message.includes("NOT NULL constraint failed: guest_names.name"))
    return new ApiFailure(409, "conflict", "Guest profile changed; try again")
  return null
}
