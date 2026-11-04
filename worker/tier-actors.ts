import type { Actor, ActorTier } from "../shared/api"
import { sql } from "./core"

type Human = Exclude<Actor, { type: "agent" }>
export type TierMap = Record<string, ActorTier>
const badgeSQL = `json_object('id',rt.id,'name',rt.name,'color',rt.color,'agents_reply',json(CASE rt.agents_reply WHEN 1 THEN 'true' ELSE 'false' END))`
// Correlated, indexed lookups for the displayed actors only, inside the existing D1 read batch.
export function tierBag(app: string, actors: string[], mentions?: string) {
  const ids = actors.map((a) => `SELECT json_extract(${a},'$.id')`)
  if (mentions) ids.push(`SELECT json_extract(j.value,'$.actor.id') FROM json_each(${mentions}) j`)
  return `(SELECT json_group_object(rt.actor_id,${badgeSQL}) FROM reporter_tiers rt WHERE rt.app_id=${app} AND rt.actor_id IN (${ids.join(" UNION ALL ")}))`
}
function human(v: unknown): v is Human {
  if (!v || typeof v !== "object" || !("id" in v) || typeof v.id !== "string" || !("type" in v)) return false
  return (
    (v.type === "guest" && "handle" in v && "name" in v) || (v.type === "member" && "avatar_url" in v && "name" in v)
  )
}
function mapActors<T>(value: T, fn: (a: Human) => Human): T {
  if (human(value)) return fn(value) as T
  if (value && typeof value === "object") {
    let copy: Record<string, unknown> | undefined
    for (const [k, v] of Object.entries(value)) {
      if (k === "system_info" || k === "fields") continue
      const next = mapActors(v, fn)
      if (next !== v) {
        copy ??= Object.assign(Array.isArray(value) ? [] : {}, value) as Record<string, unknown>
        copy[k] = next
      }
    }
    if (copy) return copy as T
  }
  return value
}
export function projectActor(a: Actor, tiers?: TierMap): Actor {
  if (a.type === "agent") return a
  if (!tiers && !Object.hasOwn(a, "tier")) return a
  const { tier: _, ...clean } = a
  return tiers ? { ...clean, tier: tiers[a.id] ?? null } : clean
}
export function projectTiers<T>(value: T, tiers?: TierMap): T {
  return mapActors(value, (a) => projectActor(a, tiers) as Human)
}
export const tierReplacer = (tiers?: TierMap) => (_key: string, value: unknown) =>
  human(value) ? projectActor(value, tiers) : value
export function actorIdsIn(value: unknown) {
  const ids = new Set<string>()
  mapActors(value, (a) => {
    ids.add(a.id)
    return a
  })
  return [...ids]
}
export function tierQuery(env: Env, app: string, ids: string[]) {
  return sql(
    env,
    `SELECT json_group_object(rt.actor_id,${badgeSQL}) bag FROM reporter_tiers rt WHERE rt.app_id=? AND rt.actor_id IN(SELECT value FROM json_each(?))`,
    app,
    JSON.stringify(ids)
  )
}
export async function teamProjection<T>(env: Env, app: string, value: T): Promise<T> {
  const ids = actorIdsIn(value)
  return ids.length
    ? projectTiers(value, JSON.parse((await tierQuery(env, app, ids).first<string>("bag")) ?? "{}"))
    : value
}
