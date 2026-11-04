import type { App } from "../shared/api"
import { missing, sql } from "./core"
import type { Ctx } from "./core"

export const appCols = `a.id,a.slug,a.name,a.description,a.created_at,'/icon/'||a.slug||'/'||a.icon_version AS icon_url`
// HTTP reads know a slug; MCP and mutations already have a validated app ID. In the former
// case, resolve the app and viewer role in the same D1 batch as the child queries.
export const bySlug = (c: Ctx) => ({ slug: c.req.param("slug")!, user: c.var.user?.id ?? null, guest: c.var.guestId })
export type ReadScope = string | ReturnType<typeof bySlug>
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
  statements: { [K in keyof T]: D1PreparedStatement }
) {
  const result = await env.DB.batch(typeof scope === "string" ? statements : [appStatement(env, scope), ...statements])
  const app = typeof scope === "string" ? null : ((result.shift()!.results[0] as App | undefined) ?? missing())
  // Each caller describes the row type of its statements in order; D1 types all batch results alike.
  return { app, data: result.map((r) => r.results) as { [K in keyof T]: T[K][] } }
}
