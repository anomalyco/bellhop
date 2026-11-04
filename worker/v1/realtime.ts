import type { Activity, Actor } from "../../shared/api"
import type { RealtimeEvent } from "../../shared/v1"
import { fail, secret, sha256, sql, type Ctx } from "../core"
import { apiOrigin, checkHost, liveGuard, ownOrigin, type Scope } from "./access"
import { contactRoom, type Hint } from "./signals"
import { participant, streamSnapshot } from "./conversations"

type Viewer = { app: string; who: string; hash: string; origin: string | null; base: string; slug: string }
const binding = (v: Viewer) => JSON.stringify([v.hash, v.origin])
const roomName = (app: string, who: string) => "enduser:" + app + ":" + who
function credentials(env: Env, app: string, who: string, viewers: Viewer[]) {
  const rows = viewers.map((v) => [v.hash, v.origin, Number(ownOrigin(env, v.slug, v.origin, v.base))])
  return sql(
    env,
    `SELECT DISTINCT s.hash,json_extract(w.value,'$[1]') origin,s.expires FROM json_each(?1) w JOIN api_sessions s ON s.hash=json_extract(w.value,'$[0]') JOIN api_keys k ON k.id=s.key_id JOIN apps a ON a.id=s.app_id WHERE a.id=?2 AND a.mode='helpdesk' AND coalesce(s.contact_id,s.anon_id)=?3 AND s.expires>unixepoch() AND (s.anon_id IS NULL OR a.allow_anonymous) AND
  ((s.origin IS NULL AND k.kind='secret') OR s.origin=json_extract(w.value,'$[1]')) AND (json_extract(w.value,'$[1]') IS NULL OR json_extract(w.value,'$[2]') OR EXISTS(SELECT 1 FROM api_keys p JOIN api_origins o ON o.key_id=p.id WHERE p.app_id=a.id AND o.origin=json_extract(w.value,'$[1]') AND (k.kind='secret' OR p.id=k.id)))`,
    JSON.stringify(rows),
    app,
    who
  )
}
export async function mintTicket(c: Ctx, s: Scope, seed?: string) {
  const ticket = seed ?? secret(),
    exp = Math.floor(Date.now() / 1000) + 60
  await c.env.DB.batch([
    liveGuard(c, s),
    sql(c.env, "INSERT INTO api_socket_tickets VALUES(?,?,?,?)", await sha256(ticket), s.hash, s.origin, exp)
  ])
  const url = new URL("/v1/realtime", apiOrigin(c))
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  url.searchParams.set("ticket", ticket)
  return { url: url.href, expires_at: new Date(exp * 1000).toISOString() }
}
export async function upgrade(c: Ctx) {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket")
    fail(426, "upgrade_required", "WebSocket upgrade required")
  const ticket = c.req.query("ticket"),
    origin = c.req.header("Origin") ?? null
  if (!ticket || !/^[0-9a-f]{64}$/.test(ticket)) fail(401, "invalid_ticket", "Invalid or expired ticket")
  const hash = await sha256(ticket),
    u = new URL(c.req.url),
    hostSlug =
      c.env.APP_DOMAIN && u.hostname !== `api.${c.env.APP_DOMAIN}`
        ? u.hostname.slice(0, -c.env.APP_DOMAIN.length - 1)
        : null
  return exchange(c, hash, origin, hostSlug)
}
async function exchange(c: Ctx, hash: string, origin: string | null, hostSlug: string | null) {
  const [read, spent] = await c.env.DB.batch<{ app: string; slug: string; hash: string; who: string }>([
    sql(
      c.env,
      `SELECT s.app_id app,a.slug,s.hash,coalesce(s.contact_id,s.anon_id) who FROM api_socket_tickets t JOIN api_sessions s ON s.hash=t.session_hash JOIN apps a ON a.id=s.app_id WHERE t.hash=? AND t.origin IS ? AND t.expires>unixepoch() AND s.expires>unixepoch() AND a.mode='helpdesk' AND (? IS NULL OR a.slug=?)`,
      hash,
      origin,
      hostSlug,
      hostSlug
    ),
    sql(
      c.env,
      `DELETE FROM api_socket_tickets WHERE hash=? AND origin IS ? AND expires>unixepoch() AND session_hash IN(SELECT s.hash FROM api_sessions s JOIN apps a ON s.app_id=a.id WHERE a.mode='helpdesk' AND s.expires>unixepoch() AND (? IS NULL OR a.slug=?))`,
      hash,
      origin,
      hostSlug,
      hostSlug
    )
  ])
  const row = read!.results[0]
  if (!row || !spent!.meta.changes) fail(401, "invalid_ticket", "Invalid or expired ticket")
  checkHost(c, row.slug)
  const viewer: Viewer = { ...row, origin, base: apiOrigin(c) }
  return contactRoom(c.env, row.app, row.who).fetch(
    new Request("https://room.invalid/__end_user", {
      headers: { Upgrade: "websocket", "X-Stream-Viewer": JSON.stringify(viewer) }
    })
  )
}
export async function acceptStream(ctx: DurableObjectState, env: Env, req: Request) {
  if (new URL(req.url).pathname !== "/__end_user" || req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
    return new Response(null, { status: 404 })
  const v = JSON.parse(req.headers.get("X-Stream-Viewer") ?? "null") as Viewer | null
  if (!v || ctx.id.name !== roomName(v.app, v.who)) return new Response(null, { status: 403 })
  if (ctx.getWebSockets().length >= 32)
    return Response.json(
      { error: { code: "socket_limit", message: "Too many open sockets" } },
      { status: 429, headers: { "Retry-After": "60" } }
    )
  const [live] = await env.DB.batch<{ expires: number }>([
    credentials(env, v.app, v.who, [v]),
    sql(env, "INSERT OR IGNORE INTO api_watched SELECT hash FROM api_sessions WHERE hash=?", v.hash)
  ])
  const allowed = live!.results[0]
  if (!allowed)
    return Response.json(
      { error: { code: "invalid_credential", message: "Invalid or expired session" } },
      { status: 401 }
    )
  const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
  ctx.acceptWebSocket(server)
  server.serializeAttachment(v)
  const alarm = await ctx.storage.getAlarm()
  if (!alarm || allowed.expires * 1000 < alarm) await ctx.storage.setAlarm(allowed.expires * 1000)
  return new Response(null, { status: 101, webSocket: client })
}
export async function deliverStream(ctx: DurableObjectState, env: Env, hint?: Hint) {
  const sockets = ctx
    .getWebSockets()
    .filter((ws) => ws.readyState === WebSocket.OPEN)
    .map((ws) => ({ ws, v: ws.deserializeAttachment() as Viewer }))
  if (!sockets.length) return
  const { app, who, base: origin } = sockets[0]!.v
  if (ctx.id.name !== roomName(app, who)) throw Error("Wrong stream scope")
  const auth = credentials(
    env,
    app,
    who,
    sockets.map((x) => x.v)
  )
  let access: Record<string, unknown>[],
    frames: RealtimeEvent[] = []
  if (!hint) access = (await auth.all()).results
  else if (hint.presence) {
    const [r, acl] = await env.DB.batch<Record<string, unknown>>([
      sql(
        env,
        `SELECT i.activity FROM issues i JOIN apps a ON a.id=i.app_id WHERE i.id=? AND i.app_id=? AND json_extract(i.author,'$.id')=? AND i.hidden IS NULL AND a.mode='helpdesk'`,
        hint.issue,
        app,
        who
      ),
      auth
    ])
    access = acl!.results
    if (r!.results[0]) {
      const value = r!.results[0].activity as string | null,
        p = value ? (JSON.parse(value) as Activity) : null,
        active = p && Date.parse(p.expires_at) > Date.now() ? p : null,
        actor = active?.actor ?? hint.clear
      if (actor && actor.type !== "guest") {
        const common = { conversation_id: hint.issue, participant: participant(actor) }
        if (actor.type === "agent" && (!active || active.text !== null))
          frames.push({ ...common, type: "activity", text: active?.text ?? null })
        else if (active) frames.push({ ...common, type: "typing" })
      }
    }
  } else {
    const edits = new Set(hint.edited),
      snap = await streamSnapshot({ env, app, who, origin }, hint.issue, [...(hint.created ?? []), ...edits], auth)
    access = snap.access
    if (snap.conversation) {
      for (const item of snap.items) {
        if (edits.has(item.id) && item.kind === "message")
          frames.push({ type: "message.updated", conversation_id: hint.issue, message: item.message })
        else frames.push({ type: "item.created", conversation_id: hint.issue, item })
      }
      frames.push({ type: "conversation.updated", conversation: snap.conversation })
    }
  }
  const valid = new Map(access.map((r) => [JSON.stringify([r.hash, r.origin]), Number(r.expires) * 1000])),
    encoded = frames.map((f) => JSON.stringify(f))
  let earliest = Infinity
  for (const { ws, v } of sockets) {
    const expiry = valid.get(binding(v))
    if (!expiry || expiry <= Date.now()) {
      ws.close(4401, "Session no longer authorized")
      continue
    }
    earliest = Math.min(earliest, expiry)
    try {
      for (const msg of encoded) ws.send(msg)
    } catch {
      ws.close(1011, "Delivery failed")
    }
  }
  if (!hint) {
    if (earliest < Infinity) await ctx.storage.setAlarm(earliest)
    else await ctx.storage.deleteAlarm()
  }
}
export async function revokeStream(c: Ctx, s: Scope) {
  await sql(c.env, "DELETE FROM api_sessions WHERE hash=?", s.hash).run()
  await contactRoom(c.env, s.app, s.user!.id).reviewContact()
  return { ok: true }
}
export async function sweepStreams(env: Env) {
  await sql(env, "DELETE FROM api_socket_tickets WHERE expires<=unixepoch()").run()
  const rs = await sql(
    env,
    "SELECT app_id,actor,max(id) last FROM api_socket_revocations GROUP BY app_id,actor LIMIT 100"
  ).all<{ app_id: string; actor: string; last: number }>()
  for (const r of rs.results) {
    await contactRoom(env, r.app_id, r.actor).reviewContact()
    await sql(
      env,
      "DELETE FROM api_socket_revocations WHERE app_id=? AND actor=? AND id<=?",
      r.app_id,
      r.actor,
      r.last
    ).run()
  }
}
