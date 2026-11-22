import { Hono } from "hono"
import type { Actor, App, Member, Org, OrgDetail, Role } from "../shared/api"
import { auditActor } from "./audit"
import { createApp, detail, validSlug } from "./apps"
import { body, choice, denied, email, fail, memberActor, missing, now, rows, sql, str, uid } from "./core"
import type { Bindings, Ctx } from "./core"
import { appCols, fromAppRow, orgCols, type AppRow } from "./read-scope"
import { can, requireTeam, teamRole } from "./permissions"
import { inbox } from "./issues"
import { readIcon } from "./icons"

type OrgRow = Org
const admin = (role: Role | null) => can(role, "setup")
const adminSQL = (owner = false) =>
  `EXISTS(SELECT 1 FROM org_members p WHERE p.org_id=? AND p.user_id=? AND p.role IN (${owner ? "'owner'" : "'admin','owner'"}))`

function signedIn(c: Ctx) {
  return c.var.user ?? fail(401, "sign_in", "Sign in to continue")
}
/**
 * The viewer's place in an org: their org role, and the org's apps they're on with their effective role there.
 * Org members are on every app of the org; someone on only some of its apps (no org role) sees just those.
 */
export async function orgAccess(env: Env, user: string, slug: string) {
  const [org, apps] = await env.DB.batch<unknown>([
    sql(env, `SELECT ${orgCols},m.role FROM orgs o LEFT JOIN org_members m ON m.org_id=o.id AND m.user_id=? WHERE o.slug=?`, user, slug),
    sql(
      env,
      `SELECT ${appCols},t.role FROM orgs o JOIN apps a ON a.org_id=o.id JOIN team t ON t.app_id=a.id AND t.user_id=? WHERE o.slug=? ORDER BY a.name,a.slug`,
      user,
      slug
    )
  ])
  const o = org!.results[0] as OrgRow | undefined,
    visible = (apps!.results as AppRow[]).map((r) => fromAppRow(r))
  if (!o || (!o.role && !visible.length)) missing()
  return { org: o, apps: visible }
}
async function access(c: Ctx) {
  return orgAccess(c.env, signedIn(c).id, c.req.param("org")!)
}
async function orgDetail(env: Env, org: OrgRow, apps: App[]): Promise<OrgDetail> {
  const [counts, members] = await env.DB.batch<unknown>([
    sql(
      env,
      `SELECT j.value id,(SELECT count(*) FROM issues WHERE app_id=j.value AND status!='closed') open,
      (SELECT count(*) FROM issues WHERE app_id=j.value AND status='closed') closed FROM json_each(?) j`,
      JSON.stringify(apps.map((a) => a.id))
    ),
    admin(org.role)
      ? sql(
          env,
          `SELECT m.user_id id,m.email,u.name,u.avatar_url,m.role,1 joined FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=?1
          UNION ALL SELECT id,email,NULL,NULL,role,0 FROM org_invitations WHERE org_id=?1 ORDER BY role DESC,email`,
          org.id
        )
      : sql(env, "SELECT 1 WHERE 0")
  ])
  const byApp = new Map((counts!.results as { id: string; open: number; closed: number }[]).map((r) => [r.id, r]))
  return {
    ...org,
    apps: apps.map((a) => ({ ...a, counts: { open: byApp.get(a.id)?.open ?? 0, closed: byApp.get(a.id)?.closed ?? 0 } })),
    // Help desk availability is per workspace; it doesn't apply to an org seat.
    members: (members!.results as (Omit<Member, "joined" | "available"> & { joined: number })[]).map((m) => ({
      ...m,
      joined: !!m.joined,
      available: false
    }))
  }
}
async function current(c: Ctx) {
  const { org, apps } = await access(c)
  return c.json(await orgDetail(c.env, org, apps))
}
// Org history, and (for changes to who is on the team) each of its apps' audit log, which is where app admins look.
function audit(env: Env, org: string, actor: Actor, action: string, target: Record<string, unknown>, data: Record<string, unknown> = {}, apps = false) {
  const values = [auditActor(actor), action, JSON.stringify(target), JSON.stringify(data)]
  return [
    sql(env, "INSERT INTO org_audit_log(org_id,actor,action,target,data) SELECT ?,?,?,?,? WHERE changes()>0", org, ...values),
    ...(apps
      ? [sql(env, "INSERT INTO audit_log(app_id,actor,action,target,data) SELECT id,?,?,?,? FROM apps WHERE org_id=? AND changes()>0", ...values, org)]
      : [])
  ]
}
const actorOf = (c: Ctx, role: Role | null = null) => memberActor(c.var.user!, role)

export const orgs = new Hono<Bindings>()
orgs.get("/api/orgs", async (c) => {
  const u = signedIn(c)
  return c.json(
    await rows<Org>(
      sql(
        c.env,
        `SELECT ${orgCols},m.role FROM orgs o LEFT JOIN org_members m ON m.org_id=o.id AND m.user_id=?1
        WHERE o.id IN (SELECT org_id FROM org_members WHERE user_id=?1 UNION SELECT a.org_id FROM team t JOIN apps a ON a.id=t.app_id WHERE t.user_id=?1 AND a.org_id IS NOT NULL)
        ORDER BY o.name,o.slug`,
        u.id
      )
    )
  )
})
orgs.post("/api/orgs", async (c) => {
  const u = signedIn(c),
    b = await body(c),
    slug = validSlug(b.slug),
    name = str(b.name, "name", 120).trim(),
    id = uid()
  await c.env.DB.batch([
    sql(c.env, "INSERT INTO orgs(id,slug,name,created_at) VALUES(?,?,?,?)", id, slug, name, now()),
    sql(c.env, "INSERT INTO org_members(id,org_id,user_id,email,role) SELECT ?,?,id,email,'owner' FROM users WHERE id=?", uid(), id, u.id),
    ...audit(c.env, id, actorOf(c), "org.created", { type: "org", id, slug, name })
  ])
  const { org, apps } = await orgAccess(c.env, u.id, slug)
  return c.json(await orgDetail(c.env, org, apps), 201)
})
orgs.get("/api/orgs/:org", current)
orgs.patch("/api/orgs/:org", async (c) => {
  const { org } = await access(c)
  if (!admin(org.role)) denied()
  const b = await body(c),
    name = b.name === undefined ? null : str(b.name, "name", 120).trim(),
    u = c.var.user!.id
  const [r] = await c.env.DB.batch([
    sql(c.env, `UPDATE orgs SET name=coalesce(?,name) WHERE id=? AND ${adminSQL()}`, name, org.id, org.id, u),
    ...audit(c.env, org.id, actorOf(c, org.role), "org.updated", { type: "org", id: org.id }, { fields: name === null ? [] : ["name"] })
  ])
  if (!r!.meta.changes) denied()
  return current(c)
})
const iconKey = (org: string, version: string) => `orgs/${org}/icons/${version}`
orgs.put("/api/orgs/:org/icon", async (c) => {
  const { org } = await access(c)
  if (!admin(org.role)) denied()
  const image = await readIcon(c),
    version = uid()
  await c.env.MEDIA.put(iconKey(org.id, version), image.bytes, { httpMetadata: { contentType: image.mime } })
  let previous: string | null
  try {
    const [old, changed] = await c.env.DB.batch<{ icon_version: string | null }>([
      sql(c.env, "SELECT icon_version FROM orgs WHERE id=?", org.id),
      sql(c.env, `UPDATE orgs SET icon_version=?,icon_mime=? WHERE id=? AND ${adminSQL()}`, version, image.mime, org.id, org.id, c.var.user!.id),
      ...audit(c.env, org.id, actorOf(c, org.role), "org.updated", { type: "org", id: org.id }, { fields: ["icon"] })
    ])
    if (!changed!.meta.changes) denied()
    previous = old!.results[0]!.icon_version
  } catch (error) {
    await c.env.MEDIA.delete(iconKey(org.id, version))
    throw error
  }
  if (previous) await c.env.MEDIA.delete(iconKey(org.id, previous))
  return current(c)
})
orgs.get("/icon/o/:slug/:version", async (c) => {
  const { slug, version } = c.req.param()
  const org = await sql(c.env, "SELECT id,icon_mime FROM orgs WHERE slug=? AND icon_version=?", slug, version).first<{
    id: string
    icon_mime: string
  }>()
  if (!org) missing()
  const icon = await c.env.MEDIA.get(iconKey(org.id, version))
  if (!icon) missing()
  return c.body(icon.body, 200, {
    "Content-Type": org.icon_mime,
    "Content-Length": String(icon.size),
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cache-Control": "public, max-age=31536000, immutable"
  })
})
// Owner rules as for apps: admins manage members and viewers; only owners grant, change or remove admin and owner.
orgs.post("/api/orgs/:org/members", async (c) => {
  const { org } = await access(c)
  if (!admin(org.role)) denied()
  const b = await body(c),
    address = email(b.email),
    role = teamRole(b.role === undefined ? "member" : b.role),
    id = uid(),
    u = c.var.user!.id
  const [r] = await c.env.DB.batch([
    sql(
      c.env,
      `INSERT INTO org_invitations(id,org_id,email,role,invited_by) SELECT ?,?,?,?,(SELECT json_object('name',name,'avatar_url',avatar_url) FROM users WHERE id=?)
      WHERE NOT EXISTS(SELECT 1 FROM org_members WHERE org_id=? AND email=?) AND ${adminSQL(admin(role))}`,
      id,
      org.id,
      address,
      role,
      u,
      org.id,
      address,
      org.id,
      u
    ),
    ...audit(c.env, org.id, actorOf(c, org.role), "member.invited", { type: "invitation", id, email: address }, { role })
  ])
  if (!r!.meta.changes) denied()
  return current(c)
})
async function changeOrgMember(c: Ctx, role: Role | null) {
  const { org } = await access(c),
    target = c.req.param("id")!,
    u = c.var.user!.id
  if (!admin(org.role)) denied()
  const row = await sql(
    c.env,
    `SELECT id,role,user_id,email,0 pending FROM org_members WHERE org_id=?1 AND user_id=?2
    UNION ALL SELECT id,role,NULL,email,1 FROM org_invitations WHERE org_id=?1 AND id=?2`,
    org.id,
    target
  ).first<{ id: string; role: Role; user_id: string | null; email: string; pending: number }>()
  if (!row) missing()
  const table = row.pending ? "org_invitations" : "org_members"
  const [r] = await c.env.DB.batch([
    sql(
      c.env,
      `${role === null ? `DELETE FROM ${table}` : `UPDATE ${table} SET role=?`} WHERE org_id=? AND id=? AND role=? AND ${adminSQL(admin(row.role) || admin(role))}`,
      ...(role === null ? [] : [role]),
      org.id,
      row.id,
      row.role,
      org.id,
      u
    ),
    ...audit(
      c.env,
      org.id,
      actorOf(c, org.role),
      role ? "member.role_changed" : "member.removed",
      { type: row.pending ? "invitation" : "member", id: row.user_id ?? row.id, email: row.email, org: org.slug },
      { from: row.role, to: role },
      !row.pending
    )
  ])
  if (!r!.meta.changes) denied()
  // An admin who removed their own seat may no longer see the org.
  if (role === null && row.user_id === u) return c.json({ ok: true })
  return current(c)
}
orgs.delete("/api/orgs/:org/members/me", async (c) => {
  const { org } = await access(c),
    u = c.var.user!
  if (!org.role) missing()
  const [r] = await c.env.DB.batch([
    sql(c.env, "DELETE FROM org_members WHERE org_id=? AND user_id=?", org.id, u.id),
    ...audit(c.env, org.id, actorOf(c, org.role), "member.left", { type: "member", id: u.id, email: u.email, org: org.slug }, {}, true)
  ])
  if (!r!.meta.changes) missing()
  return c.json({ ok: true })
})
orgs.patch("/api/orgs/:org/members/:id", async (c) => changeOrgMember(c, teamRole((await body(c)).role)))
orgs.delete("/api/orgs/:org/members/:id", (c) => changeOrgMember(c, null))
orgs.post("/api/orgs/:org/apps", async (c) => {
  const { org } = await access(c),
    u = signedIn(c)
  if (!admin(org.role)) denied()
  const { kind, ...b } = await body(c)
  const created = await createApp(c, u, b, undefined, {
    id: org.id,
    slug: org.slug,
    name: org.name,
    kind: kind === undefined ? "feedback" : choice(kind, ["feedback", "tracker"] as const, "kind"),
    user: u.id
  })
  await sql(
    c.env,
    "INSERT INTO org_audit_log(org_id,actor,action,target) SELECT ?,?,'org.app_added',? WHERE EXISTS(SELECT 1 FROM apps WHERE id=? AND org_id=?)",
    org.id,
    auditActor(actorOf(c, org.role)),
    JSON.stringify({ type: "app", id: created.id, slug: created.slug }),
    created.id,
    org.id
  ).run()
  return c.json(created, 201)
})
orgs.get("/api/orgs/:org/inbox", async (c) => {
  const { apps } = await access(c),
    { state, q, cursor } = c.req.query()
  return c.json(await inbox(c.env, apps, { state, q, cursor }, c.var.user!.id))
})
// Moving an app needs its owner, and an admin of the org it joins and of the org it leaves: each org's people
// gain or lose a role in it.
orgs.put("/api/apps/:slug/org", async (c) => {
  requireTeam(c, "ownership")
  const value = (await body(c)).org,
    slug = value === null ? null : str(value, "org", 40),
    u = c.var.user!.id,
    app = c.var.app
  const [target, from] = await c.env.DB.batch<{ id: string; slug: string; name: string; role: Role | null }>([
    sql(c.env, "SELECT o.id,o.slug,o.name,m.role FROM orgs o LEFT JOIN org_members m ON m.org_id=o.id AND m.user_id=? WHERE o.slug=?", u, slug),
    sql(c.env, "SELECT o.id,o.slug,o.name,m.role FROM apps a JOIN orgs o ON o.id=a.org_id LEFT JOIN org_members m ON m.org_id=o.id AND m.user_id=? WHERE a.id=?", u, app.id)
  ])
  const to = target!.results[0] ?? null,
    old = from!.results[0] ?? null
  if (slug !== null && !to?.role) missing()
  if ((to && !admin(to.role)) || (old && !admin(old.role))) denied()
  if ((to?.id ?? null) !== (old?.id ?? null)) {
    const actor = c.var.actor,
      ref = { type: "app", id: app.id, slug: app.slug }
    const [r] = await c.env.DB.batch([
      sql(
        c.env,
        `UPDATE apps SET org_id=? WHERE id=? AND org_id IS ? AND EXISTS(SELECT 1 FROM team WHERE app_id=apps.id AND user_id=? AND role='owner')
        AND (? IS NULL OR ${adminSQL()}) AND (? IS NULL OR ${adminSQL()})`,
        to?.id ?? null,
        app.id,
        old?.id ?? null,
        u,
        to?.id ?? null,
        to?.id ?? null,
        u,
        old?.id ?? null,
        old?.id ?? null,
        u
      ),
      sql(
        c.env,
        "INSERT INTO audit_log(app_id,actor,action,target,data) SELECT ?,?,'app.org_changed',?,? WHERE changes()>0",
        app.id,
        auditActor(actor),
        JSON.stringify(ref),
        JSON.stringify({ from: old?.slug ?? null, to: to?.slug ?? null })
      ),
      ...(old ? audit(c.env, old.id, actor, "org.app_removed", ref) : []),
      ...(to ? audit(c.env, to.id, actor, "org.app_added", ref) : [])
    ])
    if (!r!.meta.changes) denied()
  }
  const role = await sql(c.env, "SELECT role FROM team WHERE app_id=? AND user_id=?", app.id, u).first<Role>("role")
  c.set("app", { ...app, role, org: to && role ? { slug: to.slug, name: to.name } : null })
  return c.json(await detail(c))
})
