import { Hono } from "hono"
import type { RequestType } from "../shared/api"
import { bad, body, denied, fail, sql, str, uid, type Bindings, type Ctx } from "./core"
import { requireTeam } from "./permissions"
import { entry } from "./audit"
import { authenticate } from "./mcp"
import {
  autonomy,
  config,
  fieldDefinitions,
  lookupRoute,
  routeTarget,
  typeGuard,
  types,
  visibleType,
  retireFormReplays
} from "./request-types"

export const requestTypes = new Hono<Bindings>()
const path = "/api/apps/:slug/request-types"
function desk(c: Ctx) {
  if (!c.var.desk) fail(403, "helpdesk_only", "Help desk workspace required")
}
requestTypes.get(path, async (c) => {
  desk(c)
  let team = !!c.var.app.role
  if (c.req.header("Authorization")) {
    const caller = await authenticate(c)
    if (!caller?.apps.some((a) => a.id === c.var.app.id)) denied()
    team = true
  }
  return c.json(await types(c.env, c.var.app.id, team))
})
async function save(c: Ctx, id?: string) {
  desk(c)
  requireTeam(c, "setup")
  const env = c.env,
    app = c.var.app.id,
    b = await body(c),
    old = id ? await config(env, app, id, false, true) : null,
    key = id ?? "rt_" + uid()
  const t: RequestType = {
    id: key,
    name: b.name === undefined && old ? old.name : str(b.name, "name", 120).trim(),
    description: b.description === undefined ? (old?.description ?? "") : str(b.description, "description", 2000, true),
    fields: b.fields === undefined ? (old?.fields ?? []) : fieldDefinitions(b.fields),
    require_verification: old?.require_verification ?? false,
    archived: old?.archived ?? false,
    autonomy: b.autonomy === undefined ? (old?.autonomy ?? null) : b.autonomy === null ? null : autonomy(b.autonomy),
    route: b.route === undefined ? (old?.route ?? null) : routeTarget(b.route),
    position: old?.position ?? 0
  }
  for (const k of ["archived", "require_verification"] as const)
    if (b[k] !== undefined) {
      if (typeof b[k] !== "boolean") bad(`Invalid ${k}`)
      t[k] = b[k]
    }
  if (b.position !== undefined) {
    if (typeof b.position !== "number" || !Number.isSafeInteger(b.position) || b.position < 0 || b.position > 1000000)
      bad("Invalid position")
    t.position = b.position
  }
  const q = [
    typeGuard(
      env,
      `EXISTS(SELECT 1 FROM members m JOIN apps a ON a.id=m.app_id WHERE a.id=? AND a.mode='helpdesk' AND m.user_id=? AND m.role IN ('owner','admin'))`,
      app,
      c.var.user!.id
    )
  ]
  if (t.route && b.route !== undefined) {
    const a = lookupRoute(app, t.route)
    if (!(await sql(env, a.query, ...a.args).first()))
      bad("Route target is not an eligible workspace member or responder agent")
    q.push(typeGuard(env, `EXISTS(${a.query})`, ...a.args))
  }
  const data = [
    t.name,
    t.description,
    JSON.stringify(t.fields),
    Number(t.require_verification),
    t.route ? JSON.stringify(t.route) : null,
    t.autonomy,
    Number(t.archived)
  ]
  if (
    old &&
    b.fields !== undefined &&
    old.fields.some((f) => !f.internal && !t.fields.some((next) => next.key === f.key && !next.internal))
  )
    q.push(retireFormReplays(env, app, "type_id", key))
  if (old) {
    q.push(
      typeGuard(
        env,
        "EXISTS(SELECT 1 FROM request_types WHERE app_id=? AND id=? AND version=?)",
        app,
        key,
        old.version
      ),
      sql(
        env,
        "UPDATE request_types SET name=?,description=?,fields=?,require_verification=?,route=?,autonomy=?,archived=?,position=?,version=version+1 WHERE app_id=? AND id=?",
        ...data,
        t.position,
        app,
        key
      )
    )
  } else
    q.push(
      sql(
        env,
        `INSERT INTO request_types(name,description,fields,require_verification,route,autonomy,archived,position,app_id,id) VALUES(?,?,?,?,?,?,?,coalesce(?,(SELECT coalesce(max(position)+1,0) FROM request_types WHERE app_id=?)),?,?)`,
        ...data,
        b.position ?? null,
        app,
        app,
        key
      )
    )
  q.push(
    entry(
      env,
      app,
      c.var.actor,
      "request_type." +
        (!old ? "created" : t.archived !== old.archived ? (t.archived ? "archived" : "restored") : "updated"),
      { type: "request_type", id: key, name: t.name },
      { fields: Object.keys(b).filter((k) => Object.hasOwn(t, k)) }
    )
  )
  await env.DB.batch(q)
  return c.json(visibleType(await config(env, app, key, false, true), true), old ? 200 : 201)
}
requestTypes.post(path, (c) => save(c))
requestTypes.patch(path + "/:id", (c) => save(c, c.req.param("id")))
