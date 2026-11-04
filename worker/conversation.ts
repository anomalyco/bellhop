import type { Actor, Mention, Mentionable, Role } from "../shared/api"
import { rows, sql } from "./core"
import { agentAccessSQL } from "./permissions"

type Target = Mentionable & { role: Role | null }
async function targets(env: Env, app: string): Promise<Target[]> {
  const query = `WITH candidates AS (SELECT 'member' type,u.id,u.name,u.avatar_url,m.role,NULL agent_kind,NULL owner_name FROM members m JOIN users u ON u.id=m.user_id WHERE m.app_id=?1
    UNION ALL SELECT 'agent',g.id,g.name,NULL,NULL,g.kind,u.name FROM (${agentAccessSQL}) acl JOIN agents g ON g.id=acl.agent_id JOIN users u ON u.id=g.user_id WHERE acl.app_id=?1 AND acl.role IS NOT NULL)
    SELECT c.*,h.handle FROM candidates c LEFT JOIN mention_handles h ON h.app_id=?1 AND h.actor_id=c.id ORDER BY c.name,c.id`
  type Row = Omit<Target, "handle"> & { handle: string | null }
  const load = () => rows<Row>(sql(env, query, app)),
    found = await load(),
    pending = found.filter((r) => !r.handle)
  if (pending.length) {
    // Allocation is serialized by D1. Leaving/rejoining, renaming or adding a namesake never
    // reassigns a previously issued handle. Only currently authorized targets are returned.
    for (let i = 0; i < pending.length; i += 50)
      await env.DB.batch(
        pending.slice(i, i + 50).map((r) => {
          const base =
            r.name
              .normalize("NFKD")
              .toLowerCase()
              .replace(/\p{M}/gu, "")
              .replace(/[^a-z0-9]+/g, "-")
              .slice(0, 54)
              .replace(/^-+|-+$/g, "") || r.type
          return sql(
            env,
            `WITH RECURSIVE names(n,h) AS (SELECT 1,?3 UNION ALL SELECT n+1,?3||'-'||(n+1) FROM names WHERE EXISTS(SELECT 1 FROM mention_handles WHERE app_id=?1 AND handle=h))
        INSERT OR IGNORE INTO mention_handles SELECT ?1,?2,h FROM names WHERE NOT EXISTS(SELECT 1 FROM mention_handles WHERE app_id=?1 AND handle=h) LIMIT 1`,
            app,
            r.id,
            base
          )
        })
      )
    return (await load()).filter((r): r is Target => r.handle !== null)
  }
  return found as Target[]
}
export async function mentionables(env: Env, app: string): Promise<Mentionable[]> {
  return (await targets(env, app)).map(({ role, agent_kind, owner_name, ...t }) =>
    t.type === "agent" ? { ...t, agent_kind, owner_name } : t
  )
}
export async function mentionsIn(env: Env, app: string, body: string, team: boolean): Promise<Mention[]> {
  if (!team || !body.includes("@")) return []
  const names = new Set(
    Array.from(body.matchAll(/(?<![\p{L}\p{N}_@-])@([a-z0-9][a-z0-9-]*)(?![\p{L}\p{N}_-])/giu), (m) =>
      m[1]!.toLowerCase()
    )
  )
  return (await targets(env, app))
    .filter((t) => names.has(t.handle))
    .map((t) => ({
      handle: t.handle,
      actor:
        t.type === "agent"
          ? { type: "agent", id: t.id, name: t.name }
          : { type: "member", id: t.id, name: t.name, avatar_url: t.avatar_url, role: t.role }
    }))
}
export const addedMentions = (next: Mention[], prev: Mention[], by: Actor) =>
  next.filter((m) => m.actor.id !== by.id && !prev.some((p) => p.actor.id === m.actor.id)).map((m) => m.actor)

// Count real voters, not a sum of counters. A private/hidden duplicate cannot reveal its
// activity to an outsider. `viewer_voted` elsewhere is the removable vote on this issue itself.
export const voteCount = (
  team: string,
  own: string
) => `(SELECT count(DISTINCT v.voter) FROM issue_votes v WHERE v.issue_id IN
  (SELECT i.id UNION ALL SELECT r.source_id FROM relations r JOIN issues d ON d.id=r.source_id
    WHERE r.type='duplicate_of' AND r.target_id=i.id AND d.app_id=i.app_id AND (${team} OR (d.hidden IS NULL AND (d.private=0 OR json_extract(d.author,'$.id') IN(SELECT value FROM json_each(${own})))))))`
