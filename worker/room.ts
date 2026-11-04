import { DurableObject } from "cloudflare:workers"
import type { Actor, Comment, LiveEvent, Role, TimelineItem } from "../shared/api"
import { expireActivity, refreshActivity } from "./events"
import { publicFeedIssue, readPresence } from "./issues"
import { sql, now } from "./core"
import { agentAccessSQL } from "./permissions"
import { commentView, gateOf, outsider, sees, type Gate, type Viewer } from "./visibility"

type Attachment = Viewer & { app: string; session: string | null; bearer: string | null; at: number }
type Delivery = { deleted?: Gate; actorIssues?: string[] }
type PolicyRow = { id: string; private: number; hidden: number; reporter: string }
type CommentRow = {
  id: string
  body: string
  author: string
  hidden: string | null
  updated_at: string
  edited_at: string | null
  role: Role | null
  reporter: string
}
const eventId = (e: LiveEvent) => ("issue_id" in e ? e.issue_id : "issue" in e ? e.issue.id : null)
function relationId(item: TimelineItem) {
  return item.kind === "event" && (item.event.type === "related" || item.event.type === "unrelated")
    ? (item.event.data.relation as { issue?: { id: string } })?.issue?.id
    : null
}

export class Room extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))
  }
  private get issueId() {
    const name = this.ctx.id.name
    return name?.startsWith("issue:") ? name.slice(6) : null
  }
  private sockets(except?: WebSocket) {
    return this.ctx.getWebSockets().filter((s) => s !== except && s.readyState === WebSocket.OPEN)
  }
  /** Clients ping every 25 s; a socket silent for 70 s belongs to a tab that went away without closing. */
  private viewers(except?: WebSocket) {
    const cutoff = Date.now() - 70_000
    return this.sockets(except).filter((s) => {
      const seen = this.ctx.getWebSocketAutoResponseTimestamp(s)?.getTime() ?? s.deserializeAttachment()?.at ?? 0
      if (seen >= cutoff) return true
      s.close(1001, "Idle")
      return false
    }).length
  }
  async fetch(req: Request) {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return Response.json(
        { error: { code: "upgrade_required", message: "WebSocket upgrade required" } },
        { status: 426 }
      )
    const issueId = this.issueId
    const attached: Attachment =
      this.ctx.id.name === "feed"
        ? { ...outsider, app: "", session: null, bearer: null, at: Date.now() }
        : { ...JSON.parse(req.headers.get("X-Bellhop-Viewer") ?? "{}"), at: Date.now() }
    const presence = issueId ? await readPresence(this.env, issueId) : null
    if (issueId && (!presence || !sees(attached, presence.gate))) return new Response(null, { status: 404 })
    const activity = presence?.activity ?? null
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server, [issueId ? "issue" : "app"])
    server.serializeAttachment(attached)
    const viewers = this.viewers()
    server.send(JSON.stringify({ type: "hello", viewers, activity } satisfies LiveEvent))
    if (issueId) await this.deliver([{ type: "viewers", count: viewers }], {}, server)
    return new Response(null, { status: 101, webSocket: client })
  }
  publish(events: LiveEvent[], options: Delivery = {}) {
    return this.deliver(events, options)
  }
  private async deliver(events: LiveEvent[], options: Delivery, except?: WebSocket) {
    const sockets = this.sockets(except)
    if (!sockets.length) return
    if (this.ctx.id.name === "feed") {
      for (const ws of sockets)
        try {
          for (const e of events) ws.send(JSON.stringify(e))
        } catch {
          ws.close(1011, "Send failed")
        }
      return
    }
    const ids = new Set<string>(options.actorIssues ?? []),
      commentIds = new Set<string>()
    if (this.issueId) ids.add(this.issueId)
    for (const e of events) {
      const id = eventId(e)
      if (id) ids.add(id)
      if (e.type === "comment.updated") commentIds.add(e.comment.id)
      if (e.type === "timeline.added") {
        if (e.item.kind === "comment") commentIds.add(e.item.comment.id)
        const target = relationId(e.item)
        if (target) ids.add(target)
      }
    }
    const listeners = sockets.map((ws) => ({ ws, a: ws.deserializeAttachment() as Attachment | null })),
      sessions = listeners.flatMap((x) => (x.a?.session ? [x.a.session] : [])),
      bearers = listeners.flatMap((x) => (x.a?.bearer ? [x.a.bearer] : []))
    const app = listeners.find((x) => x.a?.app)?.a?.app ?? ""
    // Evaluate every socket's credentials, issue gates, and latest comment bodies in one DB
    // snapshot. A queued event must not pair yesterday's public ACL with today's private body.
    const q = [
      sql(
        this.env,
        "SELECT id,private,hidden IS NOT NULL hidden,json_extract(author,'$.id') reporter FROM issues WHERE id IN(SELECT value FROM json_each(?))",
        JSON.stringify([...ids])
      )
    ]
    const ci = commentIds.size
      ? q.push(
          sql(
            this.env,
            `SELECT c.id,c.author,c.body,c.hidden,c.updated_at,c.edited_at,m.role,json_extract(i.author,'$.id') reporter
      FROM comments c JOIN issues i ON i.id=c.issue_id LEFT JOIN members m ON m.app_id=i.app_id AND m.user_id=json_extract(c.author,'$.id') WHERE c.id IN (SELECT value FROM json_each(?))`,
            JSON.stringify([...commentIds])
          )
        ) - 1
      : -1
    const si = sessions.length
      ? q.push(
          sql(
            this.env,
            `SELECT s.token_hash hash,s.user_id id,m.role IS NOT NULL team FROM sessions s LEFT JOIN members m ON m.user_id=s.user_id AND m.app_id=? WHERE s.expires_at>? AND s.token_hash IN(SELECT value FROM json_each(?))`,
            app,
            now(),
            JSON.stringify([...new Set(sessions)])
          )
        ) - 1
      : -1
    const ai = bearers.length
      ? q.push(
          sql(
            this.env,
            `WITH credentials AS (SELECT id,token_hash hash FROM agents WHERE token_hash IN (SELECT value FROM json_each(?1))
       UNION ALL SELECT grant_id,hash FROM oauth_tokens WHERE hash IN (SELECT value FROM json_each(?1)) AND kind='access' AND expires_at>unixepoch())
       SELECT x.hash,x.id FROM credentials x JOIN (${agentAccessSQL}) acl ON acl.agent_id=x.id WHERE acl.app_id=?2 AND acl.role IS NOT NULL`,
            JSON.stringify([...new Set(bearers)]),
            app
          )
        ) - 1
      : -1
    const result = await this.env.DB.batch<unknown>(q),
      resultRows = <T>(i: number) => (result[i]?.results ?? []) as T[]
    const gates = new Map(
        resultRows<PolicyRow>(0).map((r) => [r.id, { private: !!r.private, hidden: !!r.hidden, reporter: r.reporter }])
      ),
      comments = resultRows<CommentRow>(ci),
      accounts = resultRows<{ hash: string; id: string; team: number }>(si),
      agents = resultRows<{ hash: string; id: string }>(ai)
    const current = new Map(comments.map((c) => [c.id, c])),
      auth = new Map(accounts.map((s) => [s.hash, { team: !!s.team, actorId: s.id }]))
    for (const a of agents) auth.set(a.hash, { team: true, actorId: a.id })
    for (const { ws, a } of listeners) {
      const key = a?.session || a?.bearer,
        v = key ? (auth.get(key) ?? outsider) : { team: false, actorId: a?.actorId ?? null }
      const allowed = (id: string) => {
        const g = gates.get(id)
        return !!g && sees(v, g)
      }
      const shape = (c: Comment) => {
        const row = current.get(c.id)
        if (!row) return null
        const author: Actor = JSON.parse(row.author)
        if (author.type === "member") author.role = row.role
        if (author.type === "guest") author.name ??= null
        return commentView(
          {
            ...c,
            body: row.body,
            hidden: row.hidden ? JSON.parse(row.hidden) : null,
            author,
            by_issue_author: row.reporter === author.id,
            edited_at: row.edited_at,
            updated_at: row.updated_at
          },
          v
        )
      }
      try {
        for (let e of events) {
          const id = eventId(e) ?? this.issueId
          if (e.type === "issue.deleted") {
            if (!options.deleted || !sees(v, options.deleted)) continue
          } else if (id && !allowed(id)) {
            // If the row vanished, a queued update may have raced its deletion notification.
            // Drop the stale payload without closing the socket ahead of issue.deleted.
            if (this.issueId && gates.has(id)) ws.close(1008, "Issue unavailable")
            continue
          }
          if (e.type === "actor.updated" && !this.issueId && !v.team && !options.actorIssues?.some(allowed)) continue
          if ((e.type === "issue.updated" || e.type === "issue.created") && !sees(v, gateOf(e.issue))) continue
          if (e.type === "timeline.added") {
            if (e.item.kind === "comment") {
              const c = shape(e.item.comment)
              if (!c) continue
              e = { ...e, item: { kind: "comment", comment: c } }
            } else {
              if (!v.team && ["hidden", "unhidden"].includes(e.item.event.type)) continue
              const other = relationId(e.item)
              if (other && !allowed(other)) continue
            }
          } else if (e.type === "comment.updated") {
            const c = shape(e.comment)
            if (!c) continue
            e = { ...e, comment: c }
          }
          ws.send(JSON.stringify(e))
        }
      } catch {
        ws.close(1011, "Send failed")
      }
    }
  }
  private pending = Promise.resolve()
  private serialize(work: () => Promise<void>) {
    const next = this.pending.then(work)
    this.pending = next.catch(() => {})
    return next
  }
  // A queued write can arrive after an admin unlists its workspace. Never trust that write's
  // payload in the global room: re-read the public projection immediately before broadcasting.
  refreshFeed(issueId: string, type: "feed.issue" | "activity") {
    return this.serialize(async () => {
      if (this.ctx.id.name !== "feed" || !this.ctx.getWebSockets().length) return
      if (type === "feed.issue") {
        const issue = await publicFeedIssue(this.env, issueId)
        if (issue) await this.publish([{ type, issue }])
      } else {
        const presence = await readPresence(this.env, issueId, undefined, true)
        if (presence) await this.publish([{ type, issue_id: issueId, activity: presence.activity }])
      }
    })
  }
  refreshPresence(appId: string, issueId: string) {
    return this.serialize(() =>
      refreshActivity(
        this.env,
        this.ctx,
        appId,
        issueId,
        (e) => this.publish([e]),
        async (at) => {
          if (at !== null) {
            await this.ctx.storage.put("scope", { appId, issueId })
            await this.ctx.storage.setAlarm(at)
          } else await this.ctx.storage.deleteAlarm()
        }
      )
    )
  }
  alarm() {
    return this.serialize(async () => {
      const scope = await this.ctx.storage.get<{ appId: string; issueId: string }>("scope")
      if (scope) {
        const next = await expireActivity(this.env, this.ctx, scope.appId, scope.issueId, (e) => this.publish([e]))
        if (next) await this.ctx.storage.setAlarm(next)
      }
    })
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong")
    else ws.close(1008, "Only ping supported")
  }
  webSocketClose(ws: WebSocket) {
    if (this.ctx.getTags(ws).includes("issue"))
      this.ctx.waitUntil(this.publish([{ type: "viewers", count: this.viewers(ws) }]))
  }
  webSocketError(ws: WebSocket) {
    ws.close(1011, "Connection error")
    this.webSocketClose(ws)
  }
}
