import { Hono } from "hono"
import type { ApiKey, NewApiKey } from "../../shared/v1"
import { auditActor, entry } from "../audit"
import {
  bad,
  body,
  choice,
  denied,
  missing,
  now,
  secret,
  sha256,
  sql,
  str,
  uid,
  type Bindings,
  type Ctx
} from "../core"
import { requireTeam } from "../permissions"

export function normalizeOrigin(x: unknown) {
  if (typeof x !== "string" || x.length > 2048 || !/^https?:\/\/[^\s/?#@\\*]+\/?$/i.test(x))
    bad("Expected an exact HTTP(S) origin")
  const u = URL.parse(x)
  if (!u || u.origin === "null") bad("Invalid origin")
  return u.origin
}
function origins(kind: ApiKey["kind"], x: unknown) {
  if (!Array.isArray(x) || x.length > 50 || (kind === "secret" ? x.length !== 0 : x.length === 0))
    bad("Invalid allowed_origins for key kind")
  return [...new Set(x.map(normalizeOrigin))]
}
const fields = `k.id,k.kind,k.name,k.preview,k.created_at,k.last_used_at,(SELECT json_group_array(origin ORDER BY origin) FROM api_origins WHERE key_id=k.id) allowed_origins`
type Row = Omit<ApiKey, "allowed_origins"> & { allowed_origins: string }
const projection = (r: Row): ApiKey => ({ ...r, allowed_origins: JSON.parse(r.allowed_origins) })
const grant = `SELECT app_id FROM members WHERE app_id=? AND user_id=? AND role IN ('admin','owner')`
function access(c: Ctx) {
  requireTeam(c, "setup")
  return [c.var.app.id, c.var.user!.id] as const
}
const base = "/api/apps/:slug/api-keys"
export const apiKeys = new Hono<Bindings>()
apiKeys.get(base, async (c) =>
  c.json(
    (
      await sql(
        c.env,
        `SELECT ${fields} FROM api_keys k WHERE k.app_id=(${grant}) ORDER BY k.created_at,k.id`,
        ...access(c)
      ).all<Row>()
    ).results.map(projection)
  )
)
async function save(c: Ctx, id: string, create: boolean) {
  const args = access(c),
    b = await body(c),
    current = create
      ? null
      : ((await sql(c.env, `SELECT kind,preview FROM api_keys WHERE id=? AND app_id=(${grant})`, id, ...args).first<
          Pick<ApiKey, "kind" | "preview">
        >()) ?? missing())
  if (!create && b.kind !== undefined) bad("Key kind cannot change")
  const kind = current?.kind ?? choice(b.kind, ["publishable", "secret"] as const, "kind"),
    raw = create ? (kind === "publishable" ? "bh_pk_" : "bh_sk_") + secret() : null,
    preview = current?.preview ?? raw!.slice(0, 6) + "…" + raw!.slice(-4),
    name = b.name === undefined && !create ? null : str(b.name, "name", 120).trim(),
    allow = !create && b.allowed_origins === undefined ? null : origins(kind, b.allowed_origins ?? []),
    env = c.env
  const q = [
    create
      ? sql(
          env,
          `INSERT INTO api_keys(id,kind,name,hash,preview,created_at,app_id) SELECT ?,?,?,?,?,?,app_id FROM (${grant})`,
          id,
          kind,
          name,
          await sha256(raw!),
          preview,
          now(),
          ...args
        )
      : sql(env, `UPDATE api_keys SET name=coalesce(?,name) WHERE id=? AND app_id=(${grant})`, name, id, ...args),
    entry(env, args[0], c.var.actor, create ? "api_key.created" : "api_key.updated", { preview })
  ]
  if (allow) {
    q.push(
      sql(
        env,
        `DELETE FROM api_origins WHERE key_id IN(SELECT id FROM api_keys WHERE id=? AND app_id=(${grant}))`,
        id,
        ...args
      ),
      sql(
        env,
        `INSERT INTO api_origins SELECT k.id,j.value FROM api_keys k,json_each(?) j WHERE k.id=? AND k.app_id=(${grant})`,
        JSON.stringify(allow),
        id,
        ...args
      )
    )
  }
  q.push(sql(env, `SELECT ${fields} FROM api_keys k WHERE k.id=? AND k.app_id=(${grant})`, id, ...args))
  const result = await env.DB.batch<Row>(q),
    key = projection(result.at(-1)!.results[0] ?? denied())
  return raw ? c.json({ ...key, key: raw } satisfies NewApiKey, 201) : c.json(key)
}
apiKeys.post(base, (c) => save(c, uid(), true))
apiKeys.patch(base + "/:id", (c) => save(c, c.req.param("id")!, false))
apiKeys.delete(base + "/:id", async (c) => {
  const args = access(c),
    id = c.req.param("id"),
    [, r] = await c.env.DB.batch([
      sql(
        c.env,
        `INSERT INTO audit_log(app_id,actor,action,target) SELECT app_id,?,'api_key.revoked',json_object('preview',preview) FROM api_keys WHERE id=? AND app_id=(${grant})`,
        auditActor(c.var.actor),
        id,
        ...args
      ),
      sql(c.env, `DELETE FROM api_keys WHERE id=? AND app_id=(${grant})`, id, ...args)
    ])
  if (!r!.meta.changes) missing()
  return c.json({ ok: true })
})
