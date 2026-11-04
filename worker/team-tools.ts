import { Hono } from "hono"
import type { SavedReply } from "../shared/api"
import { bad, body, denied, missing, now, sql, str, uid, type Bindings, type Ctx } from "./core"
import { auditActor, auditPage, recorded } from "./audit"
import { requireTeam, can, type Action } from "./permissions"
import { authenticate } from "./mcp"
import { analytics } from "./analytics"

const cols = "id,name,body,created_by,updated_at"
type Row = Omit<SavedReply, "created_by"> & { created_by: string }
const decode = (r: Row): SavedReply => ({ ...r, created_by: JSON.parse(r.created_by) })
export async function savedReplies(env: Env, app: string) {
  return (
    await sql(env, `SELECT ${cols} FROM saved_replies WHERE app_id=? ORDER BY name,id`, app).all<Row>()
  ).results.map(decode)
}
async function access(c: Ctx, action: Action) {
  if (!c.req.header("Authorization")) return requireTeam(c, action)
  const caller = await authenticate(c)
  if (!can(caller?.apps.find((a) => a.id === c.var.app.id)?.role ?? null, action)) denied()
}
export const teamTools = new Hono<Bindings>(),
  base = "/api/apps/:slug/saved-replies"
teamTools.get(base, async (c) => {
  await access(c, "read")
  return c.json(await savedReplies(c.env, c.var.app.id))
})
async function save(c: Ctx, id?: string) {
  requireTeam(c, "triage")
  const b = await body(c),
    app = c.var.app.id,
    actor = c.var.actor,
    key = id ?? uid(),
    at = now()
  const name = !id || b.name !== undefined ? str(b.name, "name", 120).trim() : null,
    text = !id || b.body !== undefined ? str(b.body, "body", 65536) : null
  if (name === null && text === null) bad("Supply a name or body")
  const q = id
    ? sql(
        c.env,
        `UPDATE saved_replies SET name=coalesce(?,name),body=coalesce(?,body),updated_at=? WHERE app_id=? AND id=? RETURNING ${cols}`,
        name,
        text,
        at,
        app,
        id
      )
    : sql(
        c.env,
        `INSERT INTO saved_replies(id,app_id,name,body,created_by,updated_at) VALUES(?,?,?,?,?,?) RETURNING ${cols}`,
        key,
        app,
        name,
        text,
        auditActor(actor),
        at
      )
  const r = await recorded<Row>(c.env, q, app, actor, id ? "saved_reply.updated" : "saved_reply.created", {
    type: "saved_reply",
    id: key
  })
  return c.json(decode(r.results[0] ?? missing()), id ? 200 : 201)
}
teamTools.post(base, (c) => save(c))
teamTools.patch(base + "/:id", (c) => save(c, c.req.param("id")))
teamTools.delete(base + "/:id", async (c) => {
  requireTeam(c, "triage")
  const app = c.var.app.id,
    id = c.req.param("id")
  if (
    !(
      await recorded(
        c.env,
        sql(c.env, "DELETE FROM saved_replies WHERE app_id=? AND id=?", app, id),
        app,
        c.var.actor,
        "saved_reply.deleted",
        { type: "saved_reply", id }
      )
    ).meta.changes
  )
    missing()
  return c.json({ ok: true })
})
teamTools.get("/api/apps/:slug/audit", async (c) => {
  await access(c, "setup")
  return c.json(await auditPage(c.env, c.var.app.id, c.req.query()))
})
teamTools.get("/api/apps/:slug/analytics", async (c) => {
  await access(c, "triage")
  const days = c.req.query("days") ?? "30"
  if (!["7", "30", "90"].includes(days)) bad("days must be 7, 30 or 90")
  return c.json(await analytics(c, c.var.app.id, Number(days)))
})
