import type { App } from "../shared/api"
import { missing, sql } from "./core"
import type { Ctx } from "./core"

export const appCols = `a.id,a.slug,a.name,a.description,a.created_at,'/icon/'||a.slug||'/'||a.icon_version AS icon_url,a.public`
export type AppRow<T extends { public: boolean } = App> = Omit<T, "public"> & { public: number }
export function fromAppRow<T extends { public: number }>({ public: listed, ...rest }: T) {
  return { ...rest, public: !!listed }
}
// HTTP reads know a slug; MCP and mutations already have a validated app ID. In the former
// case, resolve the app and viewer role in the same D1 batch as the child queries.
export const bySlug = (c: Ctx) => ({ slug: c.req.param("slug")!, user: c.var.user?.id ?? null, guest: c.var.guestId })
export type ReadScope = string | ReturnType<typeof bySlug>
export type Read = (queries: D1PreparedStatement[]) => Promise<D1Result<unknown>[]>
export async function firstRow<T>(query: D1PreparedStatement, read?: Read) {
  return read ? (((await read([query]))[0]!.results[0] as T | undefined) ?? null) : query.first<T>()
}

// Compose the existing readers, not their SQL. Independent reads submitted together
// share one D1 batch/snapshot. Only this request's explicitly opted-in SELECTs enter it.
export function pageReads(env: Env): Read {
  let pending: {
    queries: D1PreparedStatement[]
    resolve: (value: D1Result<unknown>[]) => void
    reject: (e: unknown) => void
  }[] = []
  return (queries) =>
    new Promise((resolve, reject) => {
      pending.push({ queries, resolve, reject })
      if (pending.length !== 1) return
      queueMicrotask(async () => {
        const group = pending
        pending = []
        try {
          const results = await env.DB.batch(group.flatMap((r) => r.queries))
          let at = 0
          for (const r of group) {
            r.resolve(results.slice(at, at + r.queries.length))
            at += r.queries.length
          }
        } catch (e) {
          for (const r of group) r.reject(e)
        }
      })
    })
}
export const appIdSQL = (scope: ReadScope) => (typeof scope === "string" ? "?" : "(SELECT id FROM apps WHERE slug=?)")
export const appKey = (scope: ReadScope) => (typeof scope === "string" ? scope : scope.slug)
export const appStatement = (env: Env, scope: ReturnType<typeof bySlug>) =>
  sql(
    env,
    `SELECT ${appCols},m.role FROM apps a LEFT JOIN members m ON m.app_id=a.id AND m.user_id=? WHERE a.slug=?`,
    scope.user,
    scope.slug
  )

export async function readBatch<T extends unknown[]>(
  env: Env,
  scope: ReadScope,
  statements: { [K in keyof T]: D1PreparedStatement },
  read?: Read
) {
  const queries = typeof scope === "string" ? statements : [appStatement(env, scope), ...statements]
  const result = await (read ? read(queries) : env.DB.batch(queries))
  const app =
    typeof scope === "string" ? null : fromAppRow((result.shift()!.results[0] as AppRow | undefined) ?? missing())
  // Each caller describes the row type of its statements in order; D1 types all batch results alike.
  return { app, data: result.map((r) => r.results) as { [K in keyof T]: T[K][] } }
}
