import { Hono } from "hono"
import type { Actor, Person, Tier } from "../shared/api"
import { bad, body, denied, email, ids, input, missing, rows, sql, str, uid } from "./core"
import type { Bindings } from "./core"
import { entry, recorded } from "./audit"
import { can, requireTeam } from "./permissions"

type TierRow = Omit<Tier, "rules"> & {
  label_ids: string
  assignee_id: string | null
  force_private: number
  agents_reply: number
}
async function readTiers(env: Env, app: string, id?: string): Promise<Tier[]> {
  const data = await rows<TierRow>(
    sql(
      env,
      `SELECT t.id,t.name,t.color,t.description,t.position,t.assignee_id,t.force_private,t.agents_reply,
    (SELECT json_group_array(label_id) FROM tier_labels WHERE tier_id=t.id) label_ids,
    (SELECT count(*) FROM tier_assignments WHERE tier_id=t.id) count FROM tiers t WHERE t.app_id=? ${id ? "AND t.id=?" : ""} ORDER BY t.position,t.name`,
      app,
      ...(id ? [id] : [])
    )
  )
  return data.map(({ label_ids, assignee_id, force_private, agents_reply, ...t }) => ({
    ...t,
    rules: { label_ids: JSON.parse(label_ids), assignee_id, private: !!force_private, agents_reply: !!agents_reply }
  }))
}
export const listTiers = (env: Env, app: string) => readTiers(env, app)
const one = async (env: Env, app: string, id: string) => (await readTiers(env, app, id))[0] ?? missing()
function flag(v: unknown, key: string) {
  if (typeof v !== "boolean") bad(`Invalid ${key}`)
  return v
}
async function save(env: Env, app: string, actor: Actor, b: Record<string, unknown>, id?: string) {
  const rules = b.rules === undefined ? {} : input(b.rules),
    key = id ?? uid(),
    fields: Record<string, string | number | null> = {}
  if (!id || b.name !== undefined) fields.name = str(b.name, "tier name", 100).trim()
  if (!id || b.color !== undefined) {
    const color = str(b.color === undefined ? "ededed" : b.color, "color", 6).toLowerCase()
    if (!/^[0-9a-f]{6}$/.test(color)) bad("Invalid tier color")
    fields.color = color
  }
  if (!id || b.description !== undefined)
    fields.description = str(b.description === undefined ? "" : b.description, "description", 1000, true)
  if (!id || b.position !== undefined) {
    const position = b.position === undefined ? 0 : b.position
    if (typeof position !== "number" || !Number.isSafeInteger(position)) bad("Invalid position")
    fields.position = position
  }
  if (Object.keys(rules).some((k) => !["label_ids", "assignee_id", "private", "agents_reply"].includes(k)))
    bad("Unknown tier rule")
  if (!id || rules.assignee_id !== undefined)
    fields.assignee_id = rules.assignee_id == null ? null : str(rules.assignee_id, "assignee_id", 64)
  if (!id || rules.private !== undefined)
    fields.force_private = Number(rules.private === undefined ? false : flag(rules.private, "private"))
  if (!id || rules.agents_reply !== undefined)
    fields.agents_reply = Number(rules.agents_reply === undefined ? true : flag(rules.agents_reply, "agents_reply"))
  const columns = Object.keys(fields),
    q: D1PreparedStatement[] = []
  if (!id)
    q.push(
      sql(
        env,
        `INSERT INTO tiers(id,app_id,${columns}) VALUES(?,?,${columns.map(() => "?")})`,
        key,
        app,
        ...Object.values(fields)
      )
    )
  else if (columns.length)
    q.push(
      sql(
        env,
        `UPDATE tiers SET ${columns.map((k) => `${k}=?`)} WHERE id=? AND app_id=?`,
        ...Object.values(fields),
        key,
        app
      )
    )
  if (rules.label_ids !== undefined) {
    const labels = ids(rules.label_ids, "label_ids")
    q.push(
      sql(env, "DELETE FROM tier_labels WHERE tier_id IN(SELECT id FROM tiers WHERE id=? AND app_id=?)", key, app),
      sql(
        env,
        "INSERT INTO tier_labels SELECT t.id,j.value FROM tiers t,json_each(?) j WHERE t.id=? AND t.app_id=?",
        JSON.stringify(labels),
        key,
        app
      )
    )
  }
  if (q.length)
    await env.DB.batch([
      ...q,
      entry(
        env,
        app,
        actor,
        id ? "tier.updated" : "tier.created",
        { type: "tier", id: key },
        { fields: [...columns, ...(rules.label_ids !== undefined ? ["label_ids"] : [])] },
        "EXISTS(SELECT 1 FROM tiers WHERE app_id=? AND id=?)",
        [app, key]
      )
    ])
  return one(env, app, key)
}
type Identity = { actor_id: string | null; address: string | null }
type PersonRow = {
  actor_id: string | null
  address: string | null
  actor: string | null
  issue_count: number
  last_seen_at: string | null
  tier_id: string | null
  tier_name: string | null
  color: string | null
  agents_reply: number | null
}
async function people(
  env: Env,
  app: string,
  showEmail: boolean,
  opts: { tier?: string; q?: string; one?: Identity } = {}
): Promise<Person[]> {
  const term = opts.q === undefined ? "" : str(opts.q, "query", 256, true).trim().toLowerCase(),
    person = opts.one
  // An edit is activity by its author; a reply by somebody else is not. The MAX row supplies
  // the last guest display name, while registered accounts always use their current profile.
  const match = (alias: string) => (person ? `AND json_extract(${alias}.author,'$.id')=?4` : "")
  // Non-admins never receive or search addresses (including guest and pending addresses).
  // An admin can see an account email only with activity here, or a pending address as entered.
  const data = await rows<PersonRow>(
    sql(
      env,
      `WITH posts AS (
    SELECT json_extract(i.author,'$.id') aid,i.author,coalesce(i.edited_at,i.created_at) seen,1 opened FROM issues i WHERE i.app_id=?1 AND json_extract(i.author,'$.type')!='agent' ${match("i")}
    UNION ALL SELECT json_extract(c.author,'$.id'),c.author,c.updated_at,0 FROM issues i JOIN comments c ON c.issue_id=i.id WHERE i.app_id=?1 AND json_extract(c.author,'$.type')!='agent' ${match("c")}),
    activity AS (SELECT aid,author,sum(opened) issue_count,max(seen) last_seen_at FROM posts GROUP BY aid),
    persons(aid,pending) AS (${person ? "SELECT ?4,NULL" : "SELECT aid,NULL FROM activity UNION SELECT actor_id,pending_email FROM tier_assignments WHERE app_id=?1"}),
    directory AS (SELECT p.aid actor_id,${showEmail ? "coalesce(CASE WHEN s.aid IS NOT NULL THEN u.email END,p.pending)" : "NULL"} address,CASE WHEN u.id IS NOT NULL THEN json_object('type','member','id',u.id,'name',u.name,'avatar_url',u.avatar_url,'role',NULL)
      WHEN p.aid IS NOT NULL THEN coalesce(s.author,json_object('type','guest','id',p.aid,'name',NULL,'handle','guest-'||substr(p.aid,1,4))) END actor,
      coalesce(s.issue_count,0) issue_count,s.last_seen_at,t.id tier_id,t.name tier_name,t.color,t.agents_reply,h.handle old_handle
      FROM persons p LEFT JOIN users u ON u.id=p.aid LEFT JOIN activity s ON s.aid=p.aid
      LEFT JOIN tier_assignments x ON x.app_id=?1 AND (x.actor_id=p.aid OR x.pending_email=p.pending) LEFT JOIN tiers t ON t.id=x.tier_id
      LEFT JOIN mention_handles h ON h.app_id=?1 AND h.actor_id=p.aid WHERE NOT EXISTS(SELECT 1 FROM members m WHERE m.app_id=?1 AND (m.user_id=p.aid OR m.email=coalesce(u.email,p.pending))))
    SELECT * FROM directory WHERE (?2 IS NULL OR tier_id=?2) AND (?3='' OR instr(lower(coalesce(json_extract(actor,'$.name'),'')),?3) OR instr(lower(coalesce(json_extract(actor,'$.handle'),old_handle,'')),?3) OR instr(lower(coalesce(address,'')),?3))
    ORDER BY last_seen_at DESC,coalesce(address,actor_id)`,
      app,
      opts.tier ?? null,
      term,
      ...(person ? [person.actor_id] : [])
    )
  )
  return data.map((r) => {
    const tier = r.tier_id ? { id: r.tier_id, name: r.tier_name!, color: r.color! } : null,
      actor: Actor | null = r.actor ? JSON.parse(r.actor) : null
    if (actor && actor.type !== "agent") {
      actor.tier = tier ? { ...tier, agents_reply: !!r.agents_reply } : null
      if (actor.type === "guest") actor.name ??= null
    }
    return { actor, email: r.address, tier, issue_count: r.issue_count, last_seen_at: r.last_seen_at }
  })
}
export async function setTier(
  env: Env,
  app: string,
  actor: Actor,
  b: Record<string, unknown>,
  showEmail: boolean
): Promise<Person> {
  if ((b.actor_id === undefined) === (b.email === undefined)) bad("Provide either email or actor_id")
  const identity: Identity = {
      actor_id: b.actor_id === undefined ? null : str(b.actor_id, "actor_id", 64),
      address: b.email === undefined ? null : email(b.email)
    },
    tier = b.tier_id === null ? null : str(b.tier_id, "tier_id", 64)
  const badge = tier
    ? ((await sql(env, "SELECT id,name,color FROM tiers WHERE app_id=? AND id=?", app, tier).first<
        NonNullable<Person["tier"]>
      >()) ?? bad("Unknown workspace tier"))
    : null
  const { actor_id: id, address } = identity
  // Email writes never resolve an account. Only a later authenticated sign-in binds them.
  const who = `WITH person AS (SELECT ?2 aid,?3 address),
    target AS (SELECT aid,address pending FROM person WHERE NOT EXISTS(SELECT 1 FROM agents WHERE id=aid)
      AND NOT EXISTS(SELECT 1 FROM members m WHERE m.app_id=?1 AND (m.user_id=aid OR m.email=address))
      AND (address IS NOT NULL OR EXISTS(SELECT 1 FROM issues i WHERE i.app_id=?1 AND json_extract(i.author,'$.id')=aid AND json_extract(i.author,'$.type')!='agent')
        OR EXISTS(SELECT 1 FROM comments c JOIN issues i ON i.id=c.issue_id WHERE i.app_id=?1 AND json_extract(c.author,'$.id')=aid AND json_extract(c.author,'$.type')!='agent')
        OR EXISTS(SELECT 1 FROM tier_assignments WHERE app_id=?1 AND actor_id=aid)))`
  const [allowed] = await env.DB.batch([
    sql(env, `${who} SELECT 1 FROM target`, app, id, address),
    ...(tier
      ? [
          sql(
            env,
            `${who} INSERT INTO tier_assignments(app_id,tier_id,actor_id,pending_email) SELECT ?1,?4,aid,pending FROM target WHERE 1
      ON CONFLICT DO UPDATE SET tier_id=excluded.tier_id`,
            app,
            id,
            address,
            tier
          )
        ]
      : [
          sql(
            env,
            `${who} DELETE FROM tier_assignments WHERE app_id=?1 AND (actor_id IN(SELECT aid FROM target) OR pending_email IN(SELECT pending FROM target))`,
            app,
            id,
            address
          )
        ]),
    entry(
      env,
      app,
      actor,
      "tier.assigned",
      id
        ? { type: "person", id }
        : { type: "person", email: address![0] + "***" + address!.slice(address!.lastIndexOf("@")) },
      { tier_id: tier }
    )
  ])
  if (!allowed!.results.length) denied()
  if (address)
    return { actor: null, email: showEmail ? address : null, tier: badge, issue_count: 0, last_seen_at: null }
  return (await people(env, app, showEmail, { one: identity }))[0] ?? missing()
}
export const tierRoutes = new Hono<Bindings>()
const base = "/api/apps/:slug/tiers"
tierRoutes.get(base, async (c) => {
  requireTeam(c, "triage")
  return c.json(await listTiers(c.env, c.var.app.id))
})
tierRoutes.post(base, async (c) => {
  requireTeam(c, "setup")
  return c.json(await save(c.env, c.var.app.id, c.var.actor, await body(c)), 201)
})
tierRoutes.patch(`${base}/:id`, async (c) => {
  requireTeam(c, "setup")
  return c.json(await save(c.env, c.var.app.id, c.var.actor, await body(c), c.req.param("id")))
})
tierRoutes.delete(`${base}/:id`, async (c) => {
  requireTeam(c, "setup")
  if (
    !(
      await recorded(
        c.env,
        sql(c.env, "DELETE FROM tiers WHERE app_id=? AND id=?", c.var.app.id, c.req.param("id")),
        c.var.app.id,
        c.var.actor,
        "tier.deleted",
        { type: "tier", id: c.req.param("id") }
      )
    ).meta.changes
  )
    missing()
  return c.json({ ok: true })
})
tierRoutes.get("/api/apps/:slug/people", async (c) => {
  requireTeam(c, "triage")
  return c.json(
    await people(c.env, c.var.app.id, can(c.var.app.role, "setup"), { q: c.req.query("q"), tier: c.req.query("tier") })
  )
})
tierRoutes.put("/api/apps/:slug/people/tier", async (c) => {
  requireTeam(c, "triage")
  return c.json(await setTier(c.env, c.var.app.id, c.var.actor, await body(c), can(c.var.app.role, "setup")))
})
