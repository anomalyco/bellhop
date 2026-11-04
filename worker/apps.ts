import { Hono } from "hono"
import type {
  Actor,
  App,
  AppDetail,
  AppSettings,
  Invitation,
  Label,
  Member,
  Template,
  WebhookDelivery
} from "../shared/api"
import { auditActor, entry, recorded } from "./audit"
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
import {
  appCols,
  appIdSQL,
  appKey,
  appStatement,
  bySlug,
  fromAppRow,
  readBatch,
  firstRow,
  type Read
} from "./read-scope"
import type { AppRow, ReadScope } from "./read-scope"
export { appCols } from "./read-scope"
import { mentionables } from "./conversation"
import { activeContact, contactActor, hostWorkspace } from "./contact-session"
const originScopes = `(SELECT json_group_array(DISTINCT mv.from_app) FROM issue_moves mv WHERE mv.current_app=a.id)`
const aliasesFor = (cookie: string | null, origins: string) =>
  Promise.all((cookie ? (JSON.parse(origins) as string[]) : []).map((id) => scopedGuestId(cookie!, id)))

// One authenticated scope lookup for reporter-aware counts/lists, restricted media and sockets.
export async function viewerApp(
  c: Ctx,
  slug: string,
  ownCookies?: string[],
  page?: { hash: string | null; cookie: string; read: Read }
) {
  const host = c.env.APP_DOMAIN && hostWorkspace(c)
  if (
    host &&
    host !== slug &&
    (await sql(c.env, "SELECT 1 FROM apps WHERE slug IN (?,?) AND mode='helpdesk' LIMIT 1", host, slug).first())
  )
    missing()
  const hash = page ? page.hash : await sessionHash(c),
    row = await firstRow<
      AppRow & { mode: string; require_verified_email: number; user_id: string | null; origins: string }
    >(
      sql(
        c.env,
        `SELECT ${appCols},a.mode,a.require_verified_email,m.role,s.user_id,CASE WHEN a.mode='tracker' AND (${ownCookies?.length ? "1" : "s.user_id IS NULL"}) THEN ${originScopes} ELSE '[]' END origins FROM apps a LEFT JOIN sessions s ON s.token_hash=? AND s.expires_at>?
    LEFT JOIN members m ON m.app_id=a.id AND m.user_id=s.user_id WHERE a.slug=?`,
        hash,
        now(),
        slug
      ),
      page?.read
    )
  if (!row) missing()
  const { user_id: account, origins, mode, require_verified_email, ...rest } = row,
    app = fromAppRow(rest),
    desk = mode === "helpdesk",
    user_id = desk && !app.role ? null : account,
    identity = desk ? await activeContact(c, slug) : null,
    cookie = page?.cookie ?? browserGuest(c) ?? c.var.guestId
  const actorId = user_id ?? identity?.contact.id ?? (cookie ? await scopedGuestId(cookie, app.id) : null)
  const baseViewer = {
    team: can(app.role, "read"),
    actorId,
    aliases: await aliasesFor(user_id ? null : cookie, origins),
    voter: user_id ?? identity?.contact.id ?? (desk ? actorId : cookie ? "g:" + (await sha256(cookie)) : null)
  }
  return {
    app,
    desk,
    requireContact: !!require_verified_email,
    contact: identity?.contact ?? null,
    baseViewer,
    viewer: {
      ...baseViewer,
      aliases:
        !desk && ownCookies?.length
          ? (
              await Promise.all(
                ownCookies.map(async (raw) => [await scopedGuestId(raw, app.id), ...(await aliasesFor(raw, origins))])
              )
            ).flat()
          : baseViewer.aliases
    },
    user: user_id,
    session: user_id ? hash : (identity?.hash ?? null)
  }
}

export async function loadApp(c: Ctx) {
  const { app, viewer, desk, requireContact, contact } = await viewerApp(c, c.req.param("slug")!)
  c.set("app", app)
  c.set("desk", desk)
  c.set("requireContact", requireContact)
  c.set("contact", contact)
  c.set("aliases", viewer.aliases)
  if (desk && !app.role) c.set("user", null)
  c.set(
    "actor",
    c.var.user
      ? memberActor(c.var.user, app.role)
      : contact
        ? contactActor(contact)
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
  viewer: Viewer = { team: can(target.role, "read"), actorId: c.var.actor?.id ?? null },
  read?: Read
): Promise<AppDetail> {
  const scope = target.id
  const {
    data: [ls, ts, totals, settings]
  } = await readBatch<
    [
      Label,
      StoredTemplate,
      AppDetail["counts"],
      {
        default_private: number
        reporter_can_choose: number
        nudge_days: number | null
        mode: AppDetail["mode"]
        require_verified_email: number
        allow_anonymous: number
        trusted: number
      }
    ]
  >(
    c.env,
    scope,
    [
      labelQuery(c.env, scope),
      templateQuery(c.env, scope),
      sql(
        c.env,
        `SELECT count(*) FILTER (WHERE status!='closed') AS open,
       count(*) FILTER (WHERE status='closed') AS closed FROM issues i WHERE i.app_id=? AND ${visibleSQL(viewer)}`,
        scope,
        ...actorBindings(viewer)
      ),
      sql(
        c.env,
        "SELECT default_private,reporter_can_choose,nudge_days,mode,require_verified_email,allow_anonymous,trusted FROM apps WHERE id=?",
        scope
      )
    ],
    read
  )
  const v = settings[0] ?? missing()
  return {
    ...target,
    labels: ls,
    templates: ts.map(template),
    counts: totals[0]!,
    nudge_days: v.nudge_days,
    mode: v.mode,
    ...(can(target.role, "setup") && { trusted: !!v.trusted }),
    helpdesk: { require_verified_email: !!v.require_verified_email, allow_anonymous: !!v.allow_anonymous },
    visibility: {
      default: v.default_private || v.mode === "helpdesk" ? "private" : "public",
      reporter_can_choose: v.mode === "tracker" && !!v.reporter_can_choose
    }
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
export async function settings(c: Ctx,revealSecret=false): Promise<AppSettings> {
  const id = c.var.app.id
  // Members need the roster to assign issues, but not the signing key or token configuration.
  // Re-read after a member mutation: the caller may just have removed or demoted themselves.
  const current = await sql(c.env, "SELECT role FROM members WHERE app_id=? AND user_id=?", id, c.var.user!.id).first<
    Member["role"]
  >("role")
  const mcp_url = new URL("/mcp", c.env.PUBLIC_ORIGIN || c.req.url).href
  if (!revealSecret || !can(current, "setup"))
    return {
      webhook: { url: null, secret: "", events: [], deliveries: [] },
      members: can(current, "triage") ? await roster(c.env, id) : [],
      mcp_url
    }
  const [hook, deliveries, members] = await Promise.all([
    sql(c.env, `SELECT url,secret,events FROM webhook_settings WHERE app_id=? AND EXISTS(SELECT 1 FROM members WHERE app_id=? AND user_id=? AND role IN ('owner','admin'))`, id,id,c.var.user!.id).first<{
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
export async function createApp(
  c: Ctx,
  u: { id: string },
  b: Record<string, unknown>,
  agent?: Extract<Actor, { type: "agent" }>
) {
  const grant = agent?.id
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
  q.push(
    entry(
      c.env,
      app.id,
      agent ?? memberActor(c.var.user!, null),
      "app.created",
      { type: "app", id: app.id },
      { public: app.public },
      "1"
    )
  )
  await c.env.DB.batch(q)
  return detail(c, grant ? { ...app, role: "admin" } : app)
}
function publicFlag(v: unknown) {
  if (typeof v !== "boolean") bad("public must be a boolean")
  return v
}
export async function updateApp(env: Env, app: App, actor: Actor, b: Record<string, unknown>): Promise<App> {
  if (b.trusted !== undefined) bad("trusted is read-only")
  const mode = b.mode === undefined ? null : choice(b.mode, ["tracker", "helpdesk"] as const, "mode"),
    desk = b.helpdesk === undefined ? null : input(b.helpdesk)
  if (desk)
    for (const k of ["require_verified_email", "allow_anonymous"])
      if (desk[k] !== undefined && typeof desk[k] !== "boolean") bad(`Invalid ${k}`)
  const v = b.visibility === undefined ? null : input(b.visibility)
  const def = v ? choice(v.default, ["public", "private"] as const, "default visibility") : null
  if (v && typeof v.reporter_can_choose !== "boolean") bad("Invalid reporter_can_choose")
  const days = b.nudge_days
  if (
    days !== undefined &&
    days !== null &&
    (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 30)
  )
    bad("nudge_days must be 1–30 or null")
  // An unrelated edit must not undo a concurrent decision to unlist the workspace.
  const change = sql(
    env,
    `UPDATE apps SET mode=coalesce(?,mode),require_verified_email=coalesce(?,require_verified_email),allow_anonymous=coalesce(?,allow_anonymous),nudge_days=CASE WHEN ? THEN ? ELSE nudge_days END,default_private=coalesce(?,default_private),reporter_can_choose=coalesce(?,reporter_can_choose),name=coalesce(?,name),description=coalesce(?,description),public=CASE WHEN coalesce(?,mode)='helpdesk' THEN 0 ELSE coalesce(?,public) END
    WHERE id=? RETURNING name,description,public`,
    mode,
    desk?.require_verified_email !== undefined ? Number(desk.require_verified_email) : null,
    desk?.allow_anonymous !== undefined ? Number(desk.allow_anonymous) : null,
    Number(days !== undefined),
    days ?? null,
    def === null ? null : Number(def === "private"),
    v ? Number(v.reporter_can_choose) : null,
    b.name === undefined ? null : str(b.name, "name", 120).trim(),
    b.description === undefined ? null : str(b.description, "description", 4000, true),
    mode,
    b.public === undefined ? null : Number(publicFlag(b.public)),
    app.id
  )
  const changed = (
    await recorded<{ name: string; description: string; public: number }>(
      env,
      change,
      app.id,
      actor,
      "app.updated",
      { type: "app", id: app.id },
      {
        fields: ["name", "description", "public", "visibility", "nudge_days", "mode", "helpdesk"].filter(
          (k) => b[k] !== undefined
        )
      }
    )
  ).results[0]
  return { ...app, ...fromAppRow(changed ?? missing()) }
}
apps.patch("/api/apps/:slug", async (c) => {
  requireTeam(c, "setup")
  c.set("app", await updateApp(c.env, c.var.app, c.var.actor, await body(c)))
  return c.json(await detail(c))
})
apps.get("/api/apps/:slug/settings", async (c) => {
  requireTeam(c, "triage")
  return c.json(await settings(c,true))
})
apps.put("/api/apps/:slug/webhook", async (c) => {
  requireTeam(c, "setup")
  const b = await body(c)
  await configureWebhook(c.env, c.var.app.id, c.var.actor, b.url, b.events)
  return c.json(await settings(c))
})
apps.post("/api/apps/:slug/webhook/rotate", async (c) => {
  requireTeam(c, "setup")
  await rotateWebhook(c.env, c.var.app.id, c.var.actor)
  return c.json(await settings(c))
})
apps.post("/api/apps/:slug/webhook/test", async (c) => {
  requireTeam(c, "setup")
  return c.json(await testWebhook(c.env, c.env.PUBLIC_ORIGIN || c.req.url, c.var.app, c.var.actor))
})
apps.post("/api/apps/:slug/webhook/deliveries/:id/redeliver", async (c) => {
  requireTeam(c, "setup")
  return c.json(await redeliver(c.env, c.var.app.id, c.var.actor, c.req.param("id")))
})
apps.post("/api/apps/:slug/members", async (c) => {
  requireTeam(c, "setup")
  const b = await body(c)
  await invite(
    c.env,
    c.var.app.id,
    { user: c.var.user!.id, actor: c.var.actor },
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
    { user: c.var.user!.id, actor: c.var.actor },
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
    { user: c.var.user!.id, actor: c.var.actor },
    { id: str((await body(c)).member_id, "member_id", 64) },
    "owner",
    true
  )
  return c.json(await settings(c))
})
apps.get("/api/me/invitations", async (c) => {
  const u = c.var.user ?? fail(401, "sign_in", "Sign in to see invitations")
  const data = await rows<Omit<Invitation, "app" | "invited_by"> & { app: string; invited_by: string }>(
    sql(
      c.env,
      `SELECT v.id,v.role,v.created_at,v.invited_by,json_object('slug',a.slug,'name',a.name,'icon_url','/icon/'||a.slug||'/'||a.icon_version) app FROM workspace_invitations v JOIN apps a ON a.id=v.app_id WHERE v.email=? ORDER BY v.created_at DESC,v.id`,
      u.email
    )
  )
  return c.json(data.map((v) => ({ ...v, app: JSON.parse(v.app), invited_by: JSON.parse(v.invited_by) })))
})
apps.post("/api/me/invitations/:id/accept", async (c) => {
  const u = c.var.user ?? fail(401, "sign_in", "Sign in to accept an invitation"),
    id = c.req.param("id")
  const [seat, app] = await c.env.DB.batch<AppRow>([
    sql(
      c.env,
      `INSERT INTO members(id,app_id,user_id,email,role) SELECT id,app_id,?,email,role FROM workspace_invitations WHERE id=? AND email=?`,
      u.id,
      id,
      u.email
    ),
    sql(
      c.env,
      `SELECT ${appCols},m.role FROM apps a JOIN members m ON m.app_id=a.id WHERE m.id=? AND m.user_id=?`,
      id,
      u.id
    ),
    sql(
      c.env,
      `INSERT INTO audit_log(app_id,actor,action,target,data) SELECT app_id,?,'member.accepted',json_object('type','invitation','id',id,'email',email),json_object('role',role) FROM workspace_invitations WHERE id=? AND email=?`,
      auditActor(memberActor(u, null)),
      id,
      u.email
    ),
    sql(c.env, "DELETE FROM workspace_invitations WHERE id=? AND email=?", id, u.email)
  ])
  if (!seat!.meta.changes) missing()
  return c.json(fromAppRow(app!.results[0]!))
})
apps.post("/api/me/invitations/:id/decline", async (c) => {
  const u = c.var.user ?? fail(401, "sign_in", "Sign in to decline an invitation")
  const id = c.req.param("id")
  const [, removed] = await c.env.DB.batch([
    sql(
      c.env,
      `INSERT INTO audit_log(app_id,actor,action,target) SELECT app_id,?,'member.declined',json_object('type','invitation','id',id,'email',email) FROM workspace_invitations WHERE id=? AND email=?`,
      auditActor(memberActor(u, null)),
      id,
      u.email
    ),
    sql(c.env, "DELETE FROM workspace_invitations WHERE id=? AND email=?", id, u.email)
  ])
  if (!removed!.meta.changes) missing()
  return c.json({ ok: true })
})
apps.delete("/api/apps/:slug/members/me", async (c) => {
  requireTeam(c, "read")
  if (
    !(
      await recorded(
        c.env,
        sql(c.env, "DELETE FROM members WHERE app_id=? AND user_id=?", c.var.app.id, c.var.user!.id),
        c.var.app.id,
        c.var.actor,
        "member.left",
        { type: "member", id: c.var.user!.id, email: c.var.user!.email }
      )
    ).meta.changes
  )
    missing()
  return c.json({ ok: true })
})
apps.delete("/api/apps/:slug/members/:id", async (c) => {
  requireTeam(c, "setup")
  await changeMember(c.env, c.var.app.id, { user: c.var.user!.id, actor: c.var.actor }, { id: c.req.param("id") }, null)
  return c.json(await settings(c))
})
export async function writeLabel(env: Env, appId: string, actor: Actor, b: Record<string, unknown>, id?: string) {
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
  const write = old
    ? sql(
        env,
        "UPDATE labels SET name=?,color=?,description=? WHERE app_id=? AND id=?",
        label.name,
        label.color,
        label.description,
        appId,
        id
      )
    : sql(env, "INSERT INTO labels VALUES(?,?,?,?,?)", label.id, appId, label.name, label.color, label.description)
  if (
    !(
      await recorded(env, write, appId, actor, old ? "label.updated" : "label.created", {
        type: "label",
        id: label.id,
        name: label.name,
        color: label.color
      })
    ).meta.changes
  )
    missing()
  return label
}
async function saveLabel(c: Ctx, id?: string) {
  requireTeam(c, "setup")
  return c.json(await writeLabel(c.env, c.var.app.id, c.var.actor, await body(c), id), id ? 200 : 201)
}
apps.post("/api/apps/:slug/labels", (c) => saveLabel(c))
apps.patch("/api/apps/:slug/labels/:id", (c) => saveLabel(c, c.req.param("id")))
export async function writeTemplate(env: Env, appId: string, actor: Actor, b: Record<string, unknown>, id?: string) {
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
  q.splice(
    1,
    0,
    entry(env, appId, actor, old ? "template.updated" : "template.created", { type: "template", id: t.id })
  )
  await env.DB.batch(q)
  return t
}
async function saveTemplate(c: Ctx, id?: string) {
  requireTeam(c, "setup")
  return c.json(await writeTemplate(c.env, c.var.app.id, c.var.actor, await body(c), id), id ? 200 : 201)
}
apps.post("/api/apps/:slug/templates", (c) => saveTemplate(c))
apps.patch("/api/apps/:slug/templates/:id", (c) => saveTemplate(c, c.req.param("id")))
export async function deleteTemplate(env: Env, appId: string, actor: Actor, id: string) {
  if (
    !(
      await recorded(
        env,
        sql(env, "DELETE FROM templates WHERE app_id=? AND id=?", appId, id),
        appId,
        actor,
        "template.deleted",
        { type: "template", id }
      )
    ).meta.changes
  )
    missing()
  return { ok: true }
}
apps.delete("/api/apps/:slug/templates/:id", async (c) => {
  requireTeam(c, "setup")
  return c.json(await deleteTemplate(c.env, c.var.app.id, c.var.actor, c.req.param("id")))
})
