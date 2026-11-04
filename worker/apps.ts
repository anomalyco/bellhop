import { Hono } from "hono"
import type { Actor, App, AppDetail, AppSettings, Label, Member, Template, WebhookDelivery } from "../shared/api"
import {
  bad,
  body,
  choice,
  fail,
  ids,
  input,
  memberActor,
  missing,
  now,
  reservedSlugs,
  rows,
  scopedGuestId,
  sha256,
  secret,
  sql,
  str,
  uid
} from "./core"
import type { Bindings, Ctx } from "./core"
import { browserGuest, guestActor, sessionHash } from "./auth"
import { visibleSQL, actorBindings, type Viewer } from "./visibility"
import { can, requireTeam, teamRole } from "./permissions"
import { changeMember, invite, roster } from "./members"
import { configureWebhook, redeliver, rotateWebhook, testWebhook } from "./webhooks"
import { appCols, appIdSQL, appKey, appStatement, bySlug, fromAppRow, readBatch } from "./read-scope"
import type { AppRow, ReadScope } from "./read-scope"
export { appCols } from "./read-scope"
import { mentionables } from "./conversation"
const originScopes = `(SELECT json_group_array(DISTINCT mv.from_app) FROM issue_moves mv WHERE mv.current_app=a.id)`
const aliasesFor = (cookie: string | null, origins: string) =>
  Promise.all((cookie ? (JSON.parse(origins) as string[]) : []).map((id) => scopedGuestId(cookie!, id)))

// One authenticated scope lookup for reporter-aware counts/lists, restricted media and sockets.
export async function viewerApp(c: Ctx, slug: string, ownCookies?: string[]) {
  const hash = await sessionHash(c),
    row = await sql(
      c.env,
      `SELECT ${appCols},m.role,s.user_id,CASE WHEN ${ownCookies?.length ? "1" : "s.user_id IS NULL"} THEN ${originScopes} ELSE '[]' END origins FROM apps a LEFT JOIN sessions s ON s.token_hash=? AND s.expires_at>?
    LEFT JOIN members m ON m.app_id=a.id AND m.user_id=s.user_id WHERE a.slug=?`,
      hash,
      now(),
      slug
    ).first<AppRow & { user_id: string | null; origins: string }>()
  if (!row) missing()
  const { user_id, origins, ...rest } = row,
    app = fromAppRow(rest),
    cookie = browserGuest(c)
  const actorId = user_id ?? (cookie ? await scopedGuestId(cookie, app.id) : null)
  return {
    app,
    viewer: {
      team: can(app.role, "read"),
      actorId,
      aliases: ownCookies?.length
        ? (
            await Promise.all(
              ownCookies.map(async (raw) => [await scopedGuestId(raw, app.id), ...(await aliasesFor(raw, origins))])
            )
          ).flat()
        : await aliasesFor(user_id ? null : cookie, origins),
      voter: user_id ?? (cookie ? "g:" + (await sha256(cookie)) : null)
    },
    user: user_id,
    session: user_id ? hash : null
  }
}

export async function loadApp(c: Ctx) {
  const { origins, ...row } =
    (await sql(
      c.env,
      `SELECT ${appCols},m.role,${c.var.user ? "'[]'" : originScopes} origins FROM apps a LEFT JOIN members m ON m.app_id=a.id AND m.user_id=? WHERE a.slug=?`,
      c.var.user?.id ?? null,
      c.req.param("slug")
    ).first<AppRow & { origins: string }>()) ?? missing()
  const app = fromAppRow(row)
  c.set("app", app)
  if (!c.var.user) c.set("aliases", await aliasesFor(c.var.guestId, origins))
  c.set(
    "actor",
    c.var.user
      ? memberActor(c.var.user, app.role)
      : await guestActor(c, app.id, !["GET", "HEAD"].includes(c.req.method))
  )
}
export const labelCols = "id,name,color,description"
const labelQuery = (env: Env, scope: ReadScope) =>
  sql(env, `SELECT ${labelCols} FROM labels WHERE app_id=${appIdSQL(scope)} ORDER BY name`, appKey(scope))
export const labels = (env: Env, appId: string) => rows<Label>(labelQuery(env, appId))
export async function selectedLabels(env: Env, appId: string, value: unknown) {
  const requested = ids(value, "label_ids"),
    all = await labels(env, appId)
  return requested.map((id) => all.find((l) => l.id === id) ?? bad("Unknown label"))
}
type StoredTemplate = Omit<Template, "label_ids" | "ask_system_info"> & { labels: string; ask_system_info: number }
const templateQuery = (env: Env, scope: ReadScope) =>
  sql(
    env,
    `SELECT t.id,t.name,t.description,t.title,t.body,t.ask_system_info,t.position,
  (SELECT json_group_array(label_id) FROM template_labels WHERE template_id=t.id) AS labels FROM templates t WHERE app_id=${appIdSQL(scope)} ORDER BY position,t.rowid`,
    appKey(scope)
  )
const template = ({ labels, ask_system_info, ...t }: StoredTemplate): Template => ({
  ...t,
  ask_system_info: !!ask_system_info,
  label_ids: JSON.parse(labels)
})
export async function templates(env: Env, appId: string) {
  return (await rows<StoredTemplate>(templateQuery(env, appId))).map(template)
}
export async function detail(
  c: Ctx,
  target: App = c.var.app,
  viewer: Viewer = { team: can(target.role, "read"), actorId: c.var.actor?.id ?? null }
): Promise<AppDetail> {
  const scope = target.id
  const {
    data: [ls, ts, totals, settings]
  } = await readBatch<
    [Label, StoredTemplate, AppDetail["counts"], { default_private: number; reporter_can_choose: number }]
  >(c.env, scope, [
    labelQuery(c.env, scope),
    templateQuery(c.env, scope),
    sql(
      c.env,
      `SELECT count(*) FILTER (WHERE status!='closed') AS open,
       count(*) FILTER (WHERE status='closed') AS closed FROM issues i WHERE i.app_id=? AND ${visibleSQL(viewer)}`,
      scope,
      ...actorBindings(viewer)
    ),
    sql(c.env, "SELECT default_private,reporter_can_choose FROM apps WHERE id=?", scope)
  ])
  const v = settings[0] ?? missing()
  return {
    ...target,
    labels: ls,
    templates: ts.map(template),
    counts: totals[0]!,
    visibility: { default: v.default_private ? "private" : "public", reporter_can_choose: !!v.reporter_can_choose }
  }
}
export function webhookDeliveries(env: Env, id: string) {
  return rows<WebhookDelivery>(
    sql(
      env,
      "SELECT id,event,status,response_status,attempts,created_at FROM webhook_deliveries WHERE app_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50",
      id
    )
  )
}
export async function settings(c: Ctx): Promise<AppSettings> {
  const id = c.var.app.id
  // Members need the roster to assign issues, but not the signing key or token configuration.
  // Re-read after a member mutation: the caller may just have removed or demoted themselves.
  const current = await sql(c.env, "SELECT role FROM members WHERE app_id=? AND user_id=?", id, c.var.user!.id).first<
    Member["role"]
  >("role")
  const mcp_url = new URL("/mcp", c.env.PUBLIC_ORIGIN || c.req.url).href
  if (!can(current, "setup"))
    return {
      webhook: { url: null, secret: "", events: [], deliveries: [] },
      members: can(current, "triage") ? await roster(c.env, id) : [],
      mcp_url
    }
  const [hook, deliveries, members] = await Promise.all([
    sql(c.env, "SELECT url,secret,events FROM webhook_settings WHERE app_id=?", id).first<{
      events: string
      url: string | null
      secret: string
    }>(),
    webhookDeliveries(c.env, id),
    roster(c.env, id)
  ])
  if (!hook) missing()
  return {
    webhook: { ...hook, events: JSON.parse(hook.events), deliveries },
    members,
    mcp_url
  }
}
export async function assignee(env: Env, appId: string, id: unknown): Promise<Actor | null> {
  if (id === null) return null
  const row = await sql(
    env,
    `SELECT u.id,u.name,u.avatar_url,m.role FROM users u JOIN members m ON m.user_id=u.id WHERE m.app_id=? AND u.id=?`,
    appId,
    str(id, "assignee_id")
  ).first<{ id: string; name: string; avatar_url: string | null; role: Member["role"] }>()
  return row ? memberActor(row, row.role) : bad("Unknown member")
}
const seedLabels = [
  ["bug", "d73a4a", "Something isn’t working"],
  ["question", "d876e3", "A question about the app"],
  ["enhancement", "a2eeef", "An improvement or new feature"],
  ["duplicate", "cfd3d7", "Reported elsewhere"],
  ["needs info", "fbca04", "More detail is needed"]
] as const
const seedTemplates = [
  [
    "Bug report",
    "Report something that isn’t working",
    "## What happened\n\n\n## Steps to reproduce\n\n\n## What you expected\n\n"
  ],
  ["Question", "Ask the team a question", "## Question\n\n"],
  ["Feature request", "Suggest an improvement", "## What would you like to see?\n\n"]
] as const
export const apps = new Hono<Bindings>()
apps.get("/api/apps/:slug/mentionables", async (c) => {
  requireTeam(c, "read")
  return c.json(await mentionables(c.env, c.var.app.id))
})
apps.get("/api/apps", async (c) => {
  if (!c.var.user) fail(401, "sign_in", "Sign in to list your apps")
  return c.json(
    (
      await rows<AppRow>(
        sql(
          c.env,
          `SELECT ${appCols},m.role FROM apps a JOIN members m ON a.id=m.app_id WHERE m.user_id=? ORDER BY a.name`,
          c.var.user.id
        )
      )
    ).map(fromAppRow)
  )
})
apps.post("/api/apps", async (c) => {
  const u = c.var.user
  if (!u) fail(401, "sign_in", "Sign in to create an app")
  return c.json(await createApp(c, u, await body(c)), 201)
})
export async function createApp(c: Ctx, u: { id: string }, b: Record<string, unknown>, grant?: string) {
  const slug = str(b.slug, "slug", 40)
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug) || slug.length < 2 || reservedSlugs.has(slug))
    bad("Invalid or reserved slug")
  const app: App = {
    id: uid(),
    slug,
    name: str(b.name, "name", 120).trim(),
    description: str(b.description ?? "", "description", 4000, true),
    created_at: now(),
    icon_url: null,
    role: "owner",
    public: b.public === undefined ? false : publicFlag(b.public)
  }
  const q = [
    sql(
      c.env,
      "INSERT INTO apps(id,slug,name,description,created_at,public) VALUES(?,?,?,?,?,?)",
      app.id,
      slug,
      app.name,
      app.description,
      app.created_at,
      Number(app.public)
    ),
    sql(
      c.env,
      "INSERT INTO members(id,app_id,user_id,email,role) SELECT ?,?,id,email,'owner' FROM users WHERE id=?",
      uid(),
      app.id,
      u.id
    ),
    sql(c.env, "INSERT INTO webhook_settings(app_id,secret) VALUES(?,?)", app.id, secret())
  ]
  const labelIds = seedLabels.map(([n, col, d]) => {
    const id = uid()
    q.push(sql(c.env, "INSERT INTO labels VALUES(?,?,?,?,?)", id, app.id, n, col, d))
    return id
  })
  seedTemplates.forEach(([n, d, b], i) => {
    const id = uid()
    q.push(sql(c.env, "INSERT INTO templates VALUES(?,?,?,?,?,?,?,?)", id, app.id, n, d, "", b, Number(i === 0), i))
    q.push(sql(c.env, "INSERT INTO template_labels VALUES(?,?)", id, labelIds[i]))
  })
  if (grant)
    q.push(
      sql(
        c.env,
        `INSERT INTO agent_apps(agent_id,app_id,role,delegated_admin) VALUES
    ((SELECT id FROM agents WHERE id=? AND user_id=? AND revoked_at IS NULL AND create_workspaces=1),?,'admin',1)`,
        grant,
        u.id,
        app.id
      )
    )
  await c.env.DB.batch(q)
  return detail(c, grant ? { ...app, role: "admin" } : app)
}
function publicFlag(v: unknown) {
  if (typeof v !== "boolean") bad("public must be a boolean")
  return v
}
export async function updateApp(env: Env, app: App, b: Record<string, unknown>): Promise<App> {
  const v = b.visibility === undefined ? null : input(b.visibility)
  const def = v ? choice(v.default, ["public", "private"] as const, "default visibility") : null
  if (v && typeof v.reporter_can_choose !== "boolean") bad("Invalid reporter_can_choose")
  // An unrelated edit must not undo a concurrent decision to unlist the workspace.
  const changed = await sql(
    env,
    `UPDATE apps SET default_private=coalesce(?,default_private),reporter_can_choose=coalesce(?,reporter_can_choose),name=coalesce(?,name),description=coalesce(?,description),public=coalesce(?,public)
    WHERE id=? RETURNING name,description,public`,
    def === null ? null : Number(def === "private"),
    v ? Number(v.reporter_can_choose) : null,
    b.name === undefined ? null : str(b.name, "name", 120).trim(),
    b.description === undefined ? null : str(b.description, "description", 4000, true),
    b.public === undefined ? null : Number(publicFlag(b.public)),
    app.id
  ).first<{ name: string; description: string; public: number }>()
  return { ...app, ...fromAppRow(changed ?? missing()) }
}
apps.patch("/api/apps/:slug", async (c) => {
  requireTeam(c, "setup")
  c.set("app", await updateApp(c.env, c.var.app, await body(c)))
  return c.json(await detail(c))
})
apps.get("/api/apps/:slug/settings", async (c) => {
  requireTeam(c, "triage")
  return c.json(await settings(c))
})
apps.put("/api/apps/:slug/webhook", async (c) => {
  requireTeam(c, "setup")
  const b = await body(c)
  await configureWebhook(c.env, c.var.app.id, b.url, b.events)
  return c.json(await settings(c))
})
apps.post("/api/apps/:slug/webhook/rotate", async (c) => {
  requireTeam(c, "setup")
  await rotateWebhook(c.env, c.var.app.id)
  return c.json(await settings(c))
})
apps.post("/api/apps/:slug/webhook/test", async (c) => {
  requireTeam(c, "setup")
  return c.json(await testWebhook(c.env, c.env.PUBLIC_ORIGIN || c.req.url, c.var.app, c.var.actor))
})
apps.post("/api/apps/:slug/webhook/deliveries/:id/redeliver", async (c) => {
  requireTeam(c, "setup")
  return c.json(await redeliver(c.env, c.var.app.id, c.req.param("id")))
})
apps.post("/api/apps/:slug/members", async (c) => {
  requireTeam(c, "setup")
  const b = await body(c)
  await invite(
    c.env,
    c.var.app.id,
    { user: c.var.user!.id },
    b.email,
    teamRole(b.role === undefined ? "member" : b.role)
  )
  return c.json(await settings(c))
})
apps.patch("/api/apps/:slug/members/:id", async (c) => {
  requireTeam(c, "setup")
  await changeMember(
    c.env,
    c.var.app.id,
    { user: c.var.user!.id },
    { id: c.req.param("id") },
    teamRole((await body(c)).role)
  )
  return c.json(await settings(c))
})
apps.post("/api/apps/:slug/transfer", async (c) => {
  requireTeam(c, "ownership")
  await changeMember(
    c.env,
    c.var.app.id,
    { user: c.var.user!.id },
    { id: str((await body(c)).member_id, "member_id", 64) },
    "owner",
    true
  )
  return c.json(await settings(c))
})
apps.delete("/api/apps/:slug/members/:id", async (c) => {
  requireTeam(c, "setup")
  await changeMember(c.env, c.var.app.id, { user: c.var.user!.id }, { id: c.req.param("id") }, null)
  return c.json(await settings(c))
})
export async function writeLabel(env: Env, appId: string, b: Record<string, unknown>, id?: string) {
  const old = id
    ? await sql(env, `SELECT ${labelCols} FROM labels WHERE id=? AND app_id=?`, id, appId).first<Label>()
    : null
  if (id && !old) missing()
  const label: Label = {
    id: id ?? uid(),
    name: str(b.name ?? old?.name, "name", 60).trim(),
    color: str(b.color ?? old?.color ?? "ededed", "color", 6).toLowerCase(),
    description: str(b.description ?? old?.description ?? "", "description", 500, true)
  }
  if (!/^[0-9a-f]{6}$/.test(label.color)) bad("Invalid label color")
  if (old)
    await sql(
      env,
      "UPDATE labels SET name=?,color=?,description=? WHERE app_id=? AND id=?",
      label.name,
      label.color,
      label.description,
      appId,
      id
    ).run()
  else
    await sql(
      env,
      "INSERT INTO labels VALUES(?,?,?,?,?)",
      label.id,
      appId,
      label.name,
      label.color,
      label.description
    ).run()
  return label
}
async function saveLabel(c: Ctx, id?: string) {
  requireTeam(c, "setup")
  return c.json(await writeLabel(c.env, c.var.app.id, await body(c), id), id ? 200 : 201)
}
apps.post("/api/apps/:slug/labels", (c) => saveLabel(c))
apps.patch("/api/apps/:slug/labels/:id", (c) => saveLabel(c, c.req.param("id")))
export async function writeTemplate(env: Env, appId: string, b: Record<string, unknown>, id?: string) {
  const old = id ? (await templates(env, appId)).find((t) => t.id === id) : null
  if (id && !old) missing()
  const ls = b.label_ids !== undefined ? await selectedLabels(env, appId, b.label_ids) : null
  const ask = b.ask_system_info ?? old?.ask_system_info ?? false,
    pos = b.position ?? old?.position ?? 0
  if (typeof ask !== "boolean" || typeof pos !== "number" || !Number.isSafeInteger(pos))
    bad("Invalid template settings")
  const t: Template = {
    id: id ?? uid(),
    name: str(b.name ?? old?.name, "name", 120).trim(),
    description: str(b.description ?? old?.description ?? "", "description", 1000, true),
    title: str(b.title ?? old?.title ?? "", "title", 256, true),
    body: str(b.body ?? old?.body ?? "", "body", 65536, true),
    ask_system_info: ask,
    position: pos,
    label_ids: ls?.map((l) => l.id) ?? old?.label_ids ?? []
  }
  const q = [
    old
      ? sql(
          env,
          "UPDATE templates SET name=?,description=?,title=?,body=?,ask_system_info=?,position=? WHERE id=? AND app_id=?",
          t.name,
          t.description,
          t.title,
          t.body,
          Number(ask),
          pos,
          id,
          appId
        )
      : sql(
          env,
          "INSERT INTO templates VALUES(?,?,?,?,?,?,?,?)",
          t.id,
          appId,
          t.name,
          t.description,
          t.title,
          t.body,
          Number(ask),
          pos
        )
  ]
  if (ls) {
    q.push(sql(env, "DELETE FROM template_labels WHERE template_id=?", t.id))
    for (const l of ls) q.push(sql(env, "INSERT INTO template_labels VALUES(?,?)", t.id, l.id))
  }
  await env.DB.batch(q)
  return t
}
async function saveTemplate(c: Ctx, id?: string) {
  requireTeam(c, "setup")
  return c.json(await writeTemplate(c.env, c.var.app.id, await body(c), id), id ? 200 : 201)
}
apps.post("/api/apps/:slug/templates", (c) => saveTemplate(c))
apps.patch("/api/apps/:slug/templates/:id", (c) => saveTemplate(c, c.req.param("id")))
export async function deleteTemplate(env: Env, appId: string, id: string) {
  if (!(await sql(env, "DELETE FROM templates WHERE app_id=? AND id=?", appId, id).run()).meta.changes) missing()
  return { ok: true }
}
apps.delete("/api/apps/:slug/templates/:id", async (c) => {
  requireTeam(c, "setup")
  return c.json(await deleteTemplate(c.env, c.var.app.id, c.req.param("id")))
})
