import { Hono } from "hono"
import type {
  Actor,
  AgentToken,
  App,
  AppDetail,
  AppSettings,
  Label,
  Member,
  Template,
  WebhookDelivery
} from "../shared/api"
import {
  bad,
  body,
  denied,
  email,
  fail,
  ids,
  member,
  memberActor,
  missing,
  now,
  owner,
  rows,
  secret,
  sha256,
  sql,
  str,
  uid
} from "./core"
import type { Bindings, Ctx } from "./core"
import { guestActor } from "./auth"
import { enqueueWebhook, webhookUrl } from "./webhooks"

export async function loadApp(c: Ctx) {
  const app = await sql(
    c.env,
    `SELECT a.id,a.slug,a.name,a.description,a.created_at,m.role FROM apps a
    LEFT JOIN members m ON m.app_id=a.id AND m.user_id=? WHERE a.slug=?`,
    c.var.user?.id ?? null,
    c.req.param("slug")
  ).first<App>()
  if (!app) missing()
  c.set("app", app)
  const guest = await guestActor(c.var.guestId, app.id)
  c.set("appGuestId", guest.id)
  c.set("actor", app.role && c.var.user ? memberActor(c.var.user) : guest)
}
export const labelCols = "id,name,color,description"
export function labels(env: Env, appId: string) {
  return rows<Label>(sql(env, `SELECT ${labelCols} FROM labels WHERE app_id=? ORDER BY name`, appId))
}
export async function selectedLabels(env: Env, appId: string, value: unknown) {
  const requested = ids(value, "label_ids"),
    all = await labels(env, appId)
  return requested.map((id) => all.find((l) => l.id === id) ?? bad("Unknown label"))
}
async function templates(env: Env, appId: string): Promise<Template[]> {
  const list = await rows<
    Omit<Template, "label_ids" | "ask_system_info"> & { labels: string; ask_system_info: number }
  >(
    sql(
      env,
      `SELECT t.id,t.name,t.description,t.title,t.body,t.ask_system_info,t.position,
    (SELECT json_group_array(label_id) FROM template_labels WHERE template_id=t.id) AS labels FROM templates t WHERE app_id=? ORDER BY position,t.rowid`,
      appId
    )
  )
  return list.map(({ labels, ask_system_info, ...t }) => ({
    ...t,
    ask_system_info: !!ask_system_info,
    label_ids: JSON.parse(labels)
  }))
}
export async function counts(env: Env, appId: string) {
  return (await sql(
    env,
    `SELECT count(*) FILTER (WHERE status!='closed') AS open,count(*) FILTER (WHERE status='closed') AS closed FROM issues WHERE app_id=?`,
    appId
  ).first<AppDetail["counts"]>())!
}
async function detail(c: Ctx): Promise<AppDetail> {
  const app = c.var.app
  const [ls, ts, totals] = await Promise.all([labels(c.env, app.id), templates(c.env, app.id), counts(c.env, app.id)])
  return { ...app, labels: ls, templates: ts, counts: totals }
}
export async function settings(c: Ctx): Promise<AppSettings> {
  const id = c.var.app.id
  const [hook, deliveries, tokens, members] = await Promise.all([
    sql(c.env, "SELECT url,secret FROM webhook_settings WHERE app_id=?", id).first<{
      url: string | null
      secret: string
    }>(),
    rows<WebhookDelivery>(
      sql(
        c.env,
        "SELECT id,event,status,response_status,attempts,created_at FROM webhook_deliveries WHERE app_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50",
        id
      )
    ),
    rows<AgentToken>(
      sql(
        c.env,
        "SELECT id,name,preview,created_at,last_used_at FROM agent_tokens WHERE app_id=? ORDER BY created_at DESC",
        id
      )
    ),
    rows<Omit<Member, "joined"> & { joined: number }>(
      sql(
        c.env,
        `SELECT coalesce(m.user_id,m.id) id,m.email,u.name,u.avatar_url,m.role,m.user_id IS NOT NULL joined FROM members m
      LEFT JOIN users u ON u.id=m.user_id WHERE m.app_id=? ORDER BY m.role DESC,m.email`,
        id
      )
    )
  ])
  if (!hook) missing()
  return {
    webhook: { ...hook, deliveries },
    tokens,
    members: members.map((m) => ({ ...m, joined: !!m.joined })),
    mcp_url: new URL("/mcp", c.env.PUBLIC_ORIGIN || c.req.url).href
  }
}
export async function assignee(env: Env, appId: string, id: unknown): Promise<Actor | null> {
  if (id === null) return null
  const row = await sql(
    env,
    `SELECT u.id,u.name,u.avatar_url FROM users u JOIN members m ON m.user_id=u.id WHERE m.app_id=? AND u.id=?`,
    appId,
    str(id, "assignee_id")
  ).first<{ id: string; name: string; avatar_url: string | null }>()
  return row ? memberActor(row) : bad("Unknown member")
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
apps.get("/api/apps", async (c) => {
  if (!c.var.user) fail(401, "sign_in", "Sign in to list your apps")
  return c.json(
    await rows<App>(
      sql(
        c.env,
        `SELECT a.id,a.slug,a.name,a.description,a.created_at,m.role FROM apps a JOIN members m ON a.id=m.app_id WHERE m.user_id=? ORDER BY a.name`,
        c.var.user.id
      )
    )
  )
})
apps.post("/api/apps", async (c) => {
  const u = c.var.user
  if (!u) fail(401, "sign_in", "Sign in to create an app")
  const b = await body(c),
    slug = str(b.slug, "slug", 40)
  if (!/^[a-z0-9-]{2,40}$/.test(slug) || ["api", "auth", "media", "mcp", "new", "settings"].includes(slug))
    bad("Invalid or reserved slug")
  const app: App = {
    id: uid(),
    slug,
    name: str(b.name, "name", 120).trim(),
    description: str(b.description ?? "", "description", 4000, true),
    created_at: now(),
    role: "owner"
  }
  const q = [
    sql(
      c.env,
      "INSERT INTO apps(id,slug,name,description,created_at) VALUES(?,?,?,?,?)",
      app.id,
      slug,
      app.name,
      app.description,
      app.created_at
    ),
    sql(
      c.env,
      "INSERT INTO members(id,app_id,user_id,email,role) VALUES(?,?,?,?,?)",
      uid(),
      app.id,
      u.id,
      u.email,
      "owner"
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
  await c.env.DB.batch(q)
  c.set("app", app)
  return c.json(await detail(c), 201)
})
apps.get("/api/apps/:slug", async (c) => c.json(await detail(c)))
apps.patch("/api/apps/:slug", async (c) => {
  owner(c)
  const b = await body(c),
    app = c.var.app
  const name = str(b.name === undefined ? app.name : b.name, "name", 120).trim(),
    description = str(b.description === undefined ? app.description : b.description, "description", 4000, true)
  await sql(c.env, "UPDATE apps SET name=?,description=? WHERE id=?", name, description, app.id).run()
  c.set("app", { ...app, name, description })
  return c.json(await detail(c))
})
apps.get("/api/apps/:slug/settings", async (c) => {
  member(c)
  return c.json(await settings(c))
})
apps.put("/api/apps/:slug/webhook", async (c) => {
  owner(c)
  const url = webhookUrl((await body(c)).url, c.env)
  await sql(c.env, "UPDATE webhook_settings SET url=? WHERE app_id=?", url, c.var.app.id).run()
  return c.json(await settings(c))
})
apps.post("/api/apps/:slug/webhook/rotate", async (c) => {
  owner(c)
  await sql(c.env, "UPDATE webhook_settings SET secret=? WHERE app_id=?", secret(), c.var.app.id).run()
  return c.json(await settings(c))
})
apps.post("/api/apps/:slug/webhook/test", async (c) => {
  owner(c)
  const id = await enqueueWebhook(c.env, c.env.PUBLIC_ORIGIN || c.req.url, {
    type: "ping", app: c.var.app, actor: c.var.actor
  })
  if (!id) bad("Set a webhook URL first")
  return c.json({ delivery_id: id })
})
apps.post("/api/apps/:slug/tokens", async (c) => {
  owner(c)
  const name = str((await body(c)).name, "name", 100).trim(),
    token = `bh_${secret()}`,
    id = uid(),
    preview = token.slice(0, 10) + "…",
    created_at = now()
  await sql(
    c.env,
    "INSERT INTO agent_tokens(id,app_id,name,token_hash,preview,created_at) VALUES(?,?,?,?,?,?)",
    id,
    c.var.app.id,
    name,
    await sha256(token),
    preview,
    created_at
  ).run()
  return c.json({ id, name, preview, created_at, last_used_at: null, token }, 201)
})
apps.delete("/api/apps/:slug/tokens/:id", async (c) => {
  owner(c)
  if (
    !(await sql(c.env, "DELETE FROM agent_tokens WHERE app_id=? AND id=?", c.var.app.id, c.req.param("id")).run()).meta
      .changes
  )
    missing()
  return c.json({ ok: true })
})
apps.post("/api/apps/:slug/members", async (c) => {
  owner(c)
  const address = email((await body(c)).email)
  await sql(
    c.env,
    "INSERT INTO members(id,app_id,email,user_id,role) VALUES(?,?,?,(SELECT id FROM users WHERE email=?),'member')",
    uid(),
    c.var.app.id,
    address,
    address
  ).run()
  return c.json(await settings(c))
})
apps.delete("/api/apps/:slug/members/:id", async (c) => {
  owner(c)
  const id = c.req.param("id")
  if (id === c.var.user?.id) denied()
  if (
    !(
      await sql(
        c.env,
        "DELETE FROM members WHERE app_id=? AND coalesce(user_id,id)=? AND role!='owner'",
        c.var.app.id,
        id
      ).run()
    ).meta.changes
  )
    missing()
  return c.json(await settings(c))
})
async function saveLabel(c: Ctx, id?: string) {
  member(c)
  const appId = c.var.app.id,
    b = await body(c),
    old = id
      ? await sql(c.env, `SELECT ${labelCols} FROM labels WHERE id=? AND app_id=?`, id, appId).first<Label>()
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
      c.env,
      "UPDATE labels SET name=?,color=?,description=? WHERE app_id=? AND id=?",
      label.name,
      label.color,
      label.description,
      appId,
      id
    ).run()
  else
    await sql(
      c.env,
      "INSERT INTO labels VALUES(?,?,?,?,?)",
      label.id,
      appId,
      label.name,
      label.color,
      label.description
    ).run()
  return c.json(label, old ? 200 : 201)
}
apps.post("/api/apps/:slug/labels", (c) => saveLabel(c))
apps.patch("/api/apps/:slug/labels/:id", (c) => saveLabel(c, c.req.param("id")))
async function saveTemplate(c: Ctx, id?: string) {
  member(c)
  const appId = c.var.app.id,
    b = await body(c),
    old = id ? (await templates(c.env, appId)).find((t) => t.id === id) : null
  if (id && !old) missing()
  const ls = b.label_ids !== undefined ? await selectedLabels(c.env, appId, b.label_ids) : null
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
          c.env,
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
          c.env,
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
    q.push(sql(c.env, "DELETE FROM template_labels WHERE template_id=?", t.id))
    for (const l of ls) q.push(sql(c.env, "INSERT INTO template_labels VALUES(?,?)", t.id, l.id))
  }
  await c.env.DB.batch(q)
  return c.json(t, old ? 200 : 201)
}
apps.post("/api/apps/:slug/templates", (c) => saveTemplate(c))
apps.patch("/api/apps/:slug/templates/:id", (c) => saveTemplate(c, c.req.param("id")))
apps.delete("/api/apps/:slug/templates/:id", async (c) => {
  member(c)
  if (
    !(await sql(c.env, "DELETE FROM templates WHERE app_id=? AND id=?", c.var.app.id, c.req.param("id")).run()).meta
      .changes
  )
    missing()
  return c.json({ ok: true })
})
