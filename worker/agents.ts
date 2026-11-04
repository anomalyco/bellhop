import { Hono } from "hono"
import type { AgentRole, AppAgent, ConnectedAgent, NewAgentToken } from "../shared/api"
import { bad, body, fail, input, missing, rows, secret, sha256, sql, str, uid } from "./core"
import type { Bindings, Ctx } from "./core"
import { agentAccessSQL, agentRole, requireTeam, withinCapSQL } from "./permissions"

const iso = (time: number) => new Date(time * 1000).toISOString()
const account = (c: Ctx) => c.var.user ?? fail(401, "sign_in", "Sign in to continue")
export function createFlag(value: unknown) {
  if (value !== undefined && typeof value !== "boolean") bad("Invalid create_workspaces flag")
  return value === true
}
function name(value: unknown) {
  return str(value, "agent name", 100).trim()
}
export const defaultRole = (v: unknown) => (v === undefined || v === null ? null : agentRole(v))
export function selection(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) bad("Choose up to 100 workspaces")
  const seen = new Set<string>()
  return value.map((v) => {
    const o = input(v),
      key = str(o.id, "app id", 64),
      role = o.role === null ? null : agentRole(o.role)
    if (seen.has(key)) bad("Duplicate workspace")
    seen.add(key)
    return { key, role }
  })
}
// A NULL app_id fails the transaction if even one selection does not match the owner's
// current membership and cap. No partially replaced ACL or orphan agent is committed.
export function attachScopes(env: Env, agent: string, user: string, items: ReturnType<typeof selection>) {
  const role = "json_extract(j.value,'$.role')"
  return sql(
    env,
    `INSERT INTO agent_apps(agent_id,app_id,role,delegated_admin) SELECT g.id,
    (SELECT a.id FROM apps a JOIN members m ON m.app_id=a.id AND m.user_id=g.user_id
     WHERE a.id=json_extract(j.value,'$.key') AND (${role} IS NULL OR ${withinCapSQL(role, "m.role")})),${role},coalesce(${role}='admin',0)
    FROM agents g,json_each(?) j WHERE g.id=? AND g.user_id=? AND g.revoked_at IS NULL`,
    JSON.stringify(items),
    agent,
    user
  )
}
type ScopeRow = { id: string; slug: string; name: string; role: AgentRole | null; override: number }
type AccountRow = {
  id: string
  kind: ConnectedAgent["kind"]
  client_name: string
  preview: string | null
  all_workspaces: AgentRole | null
  create_workspaces: number
  created_at: number
  last_used_at: number | null
  apps: string
}
async function connected(env: Env, user: string, id?: string): Promise<ConnectedAgent[]> {
  const items = await rows<AccountRow>(
    sql(
      env,
      `SELECT g.id,g.kind,g.name client_name,g.preview,g.all_workspaces,g.create_workspaces,g.created_at,g.last_used_at,
    (SELECT json_group_array(json_object('id',a.id,'slug',a.slug,'name',a.name,'role',acl.role,'override',acl.override)) FROM (${agentAccessSQL}) acl JOIN apps a ON a.id=acl.app_id
     WHERE acl.agent_id=g.id) apps FROM agents g
    WHERE g.user_id=? AND g.revoked_at IS NULL ${id ? "AND g.id=?" : ""} ORDER BY g.created_at DESC`,
      user,
      ...(id ? [id] : [])
    )
  )
  return items.map((r) => {
    const scopes = JSON.parse(r.apps) as ScopeRow[]
    return {
      ...r,
      create_workspaces: !!r.create_workspaces,
      created_at: iso(r.created_at),
      last_used_at: r.last_used_at === null ? null : iso(r.last_used_at),
      apps: scopes.flatMap((s) => (s.role ? [{ ...s, role: s.role, override: !!s.override }] : [])),
      excluded: scopes.flatMap(({ id, slug, name, role }) => (role === null ? [{ id, slug, name }] : []))
    }
  })
}
const one = async (env: Env, user: string, id: string) => (await connected(env, user, id))[0] ?? missing()
async function credential() {
  const token = `bh_${secret()}`
  return { token, hash: await sha256(token), preview: token.slice(0, 10) + "…" }
}
export const agents = new Hono<Bindings>()
agents.get("/api/me/agents", async (c) => c.json(await connected(c.env, account(c).id)))
agents.post("/api/me/agents", async (c) => {
  const user = account(c).id,
    b = await body(c),
    items = selection(b.apps === undefined ? [] : b.apps),
    create = createFlag(b.create_workspaces),
    all = defaultRole(b.all_workspaces)
  if (!items.some((s) => s.role) && !create && !all) bad("Choose a workspace or allow creating workspaces")
  const id = uid(),
    key = await credential()
  await c.env.DB.batch([
    sql(
      c.env,
      `INSERT INTO agents(id,user_id,kind,name,token_hash,preview,created_at,create_workspaces,all_workspaces)
    VALUES(?,?,'token',?,?,?,unixepoch(),?,?)`,
      id,
      user,
      name(b.name),
      key.hash,
      key.preview,
      Number(create),
      all
    ),
    attachScopes(c.env, id, user, items)
  ])
  return c.json({ ...(await one(c.env, user, id)), token: key.token } satisfies NewAgentToken, 201)
})
agents.patch("/api/me/agents/:id", async (c) => {
  const user = account(c).id,
    id = c.req.param("id"),
    b = await body(c)
  if (
    !Object.keys(b).length ||
    Object.keys(b).some((k) => !["name", "apps", "all_workspaces", "create_workspaces"].includes(k))
  )
    bad("Invalid agent update")
  const q = [
    sql(
      c.env,
      `UPDATE agents SET name=coalesce(?,name),create_workspaces=coalesce(?,create_workspaces),all_workspaces=CASE WHEN ? THEN ? ELSE all_workspaces END
    WHERE id=? AND user_id=? AND revoked_at IS NULL`,
      b.name === undefined ? null : name(b.name),
      b.create_workspaces === undefined ? null : Number(createFlag(b.create_workspaces)),
      Number(b.all_workspaces !== undefined),
      defaultRole(b.all_workspaces),
      id,
      user
    )
  ]
  if (b.apps !== undefined)
    q.push(
      sql(
        c.env,
        `DELETE FROM agent_apps WHERE agent_id IN (SELECT id FROM agents WHERE id=? AND user_id=? AND revoked_at IS NULL)`,
        id,
        user
      ),
      attachScopes(c.env, id, user, selection(b.apps))
    )
  const [r] = await c.env.DB.batch(q)
  if (!r?.meta.changes) missing()
  return c.json(await one(c.env, user, id))
})
agents.post("/api/me/agents/:id/rotate", async (c) => {
  const user = account(c).id,
    id = c.req.param("id"),
    key = await credential()
  const r = await sql(
    c.env,
    "UPDATE agents SET token_hash=?,preview=? WHERE id=? AND user_id=? AND kind='token' AND revoked_at IS NULL",
    key.hash,
    key.preview,
    id,
    user
  ).run()
  if (!r.meta.changes) missing()
  return c.json({ ...(await one(c.env, user, id)), token: key.token } satisfies NewAgentToken)
})
agents.delete("/api/me/agents/:id", async (c) => {
  const r = await sql(
    c.env,
    "UPDATE agents SET revoked_at=unixepoch() WHERE id=? AND user_id=? AND revoked_at IS NULL",
    c.req.param("id"),
    account(c).id
  ).run()
  if (!r.meta.changes) missing()
  return c.json({ ok: true })
})
async function appAgents(env: Env, app: string, id?: string): Promise<AppAgent[]> {
  const data = await rows<{
    id: string
    kind: AppAgent["kind"]
    client_name: string
    name: string
    avatar_url: string | null
    role: AgentRole
    max_role: AgentRole
    created_at: number
    last_used_at: number | null
  }>(
    sql(
      env,
      `SELECT g.id,g.kind,g.name client_name,u.name,u.avatar_url,acl.role,acl.max_role,g.created_at,g.last_used_at FROM (${agentAccessSQL}) acl
     JOIN agents g ON g.id=acl.agent_id JOIN users u ON u.id=g.user_id
     WHERE acl.app_id=? AND acl.role IS NOT NULL ${id ? "AND g.id=?" : ""} ORDER BY g.name`,
      app,
      ...(id ? [id] : [])
    )
  )
  return data.map(({ name, avatar_url, created_at, last_used_at, ...a }) => ({
    ...a,
    approved_by: { name, avatar_url },
    created_at: iso(created_at),
    last_used_at: last_used_at === null ? null : iso(last_used_at)
  }))
}
agents.get("/api/apps/:slug/agents", async (c) => {
  requireTeam(c, "setup")
  return c.json(await appAgents(c.env, c.var.app.id))
})
agents.patch("/api/apps/:slug/agents/:id", async (c) => {
  requireTeam(c, "setup")
  const role = agentRole((await body(c)).role),
    app = c.var.app.id,
    id = c.req.param("id")
  const r = await sql(
    c.env,
    `INSERT INTO agent_apps(agent_id,app_id,role,delegated_admin) SELECT agent_id,app_id,?1,
    ?1='admin' AND (delegated_admin=1 OR EXISTS(SELECT 1 FROM members WHERE app_id=?2 AND user_id=?4 AND role='owner')) FROM (${agentAccessSQL}) acl
    WHERE acl.app_id=?2 AND acl.agent_id=?3 AND acl.role IS NOT NULL AND ${withinCapSQL("?1", "acl.team")}
    ON CONFLICT(agent_id,app_id) DO UPDATE SET role=excluded.role,delegated_admin=excluded.delegated_admin`,
    role,
    app,
    id,
    c.var.user!.id
  ).run()
  const agent = (await appAgents(c.env, app, id))[0] ?? missing()
  if (!r.meta.changes) bad("Agent role exceeds its owner's access")
  return c.json(agent)
})
agents.delete("/api/apps/:slug/agents/:id", async (c) => {
  requireTeam(c, "setup")
  const app = c.var.app.id,
    id = c.req.param("id")
  const result = await c.env.DB.batch([
    sql(
      c.env,
      `INSERT INTO agent_apps(agent_id,app_id,role) SELECT acl.agent_id,acl.app_id,NULL FROM (${agentAccessSQL}) acl
    JOIN agents g ON g.id=acl.agent_id WHERE acl.app_id=? AND acl.agent_id=? AND acl.role IS NOT NULL AND g.all_workspaces IS NOT NULL
    ON CONFLICT(agent_id,app_id) DO UPDATE SET role=NULL,delegated_admin=0`,
      app,
      id
    ),
    sql(
      c.env,
      `DELETE FROM agent_apps WHERE app_id=? AND agent_id=? AND EXISTS(SELECT 1 FROM agents WHERE id=? AND all_workspaces IS NULL)`,
      app,
      id,
      id
    )
  ])
  if (!result.some((r) => r.meta.changes)) missing()
  return c.json({ ok: true })
})
