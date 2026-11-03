import type { Context } from "hono"
import type { Actor, App, Me } from "../shared/api"

export type User = NonNullable<Me["user"]>
export type Bindings = {
  Bindings: Env
  Variables: { guestId: string; appGuestId: string; user: User | null; app: App; actor: Actor }
}
export type Ctx = Context<Bindings>
export const now = () => new Date().toISOString()
export const uid = () => crypto.randomUUID()
export const hex = (value: ArrayBuffer | Uint8Array) =>
  Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("")
export const secret = () => hex(crypto.getRandomValues(new Uint8Array(32)))
export const sha256 = async (value: string) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))
export const sql = (env: Env, statement: string, ...values: unknown[]) => env.DB.prepare(statement).bind(...values)
export const rows = async <T>(stmt: D1PreparedStatement) => (await stmt.all<T>()).results

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 416 | 426 | 428 | 429 | 500 | 501 | 502 | 503
export class ApiFailure extends Error {
  constructor(
    readonly status: ErrorStatus,
    readonly code: string,
    message: string
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
export function member(c: Ctx) {
  if (!c.var.user) fail(401, "sign_in", "Sign in to continue")
  if (!c.var.app.role) denied()
}
export function owner(c: Ctx) {
  member(c)
  if (c.var.app.role !== "owner") denied()
}
export function memberActor(user: Pick<User, "id" | "name" | "avatar_url">): Actor {
  return { type: "member", id: user.id, name: user.name, avatar_url: user.avatar_url }
}
export function dbError(e: Error): ApiFailure | null {
  const message = `${e.message} ${e.cause ?? ""}`
  if (message.includes("rate limited")) return new ApiFailure(429, "rate_limited", "Hourly limit reached")
  if (/invalid attachment|UNIQUE constraint failed: attachment_links/.test(message))
    return new ApiFailure(400, "invalid_attachment", "Attachment unavailable")
  if (message.includes("UNIQUE constraint failed")) return new ApiFailure(409, "conflict", "Already exists")
  if (message.includes("NOT NULL constraint failed: issues.revision"))
    return new ApiFailure(409, "conflict", "Issue changed; refresh and try again")
  return null
}
