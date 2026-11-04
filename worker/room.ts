import { DurableObject } from "cloudflare:workers"
import type { LiveEvent } from "../shared/api"
import { expireActivity, refreshActivity } from "./events"
import { publicFeedIssue, readPresence } from "./issues"

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
    const activity = issueId ? ((await readPresence(this.env, issueId))?.activity ?? null) : null
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server, [issueId ? "issue" : "app"])
    server.serializeAttachment({ at: Date.now() })
    const viewers = this.viewers()
    server.send(JSON.stringify({ type: "hello", viewers, activity } satisfies LiveEvent))
    if (issueId) this.broadcast([{ type: "viewers", count: viewers }], server)
    return new Response(null, { status: 101, webSocket: client })
  }
  publish(events: LiveEvent[]) {
    this.broadcast(events)
  }
  private broadcast(events: LiveEvent[], except?: WebSocket) {
    const messages = events.map((e) => JSON.stringify(e))
    for (const ws of this.sockets(except)) {
      try {
        for (const message of messages) ws.send(message)
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
        if (issue) this.publish([{ type, issue }])
      } else {
        const presence = await readPresence(this.env, issueId, undefined, true)
        if (presence) this.publish([{ type, issue_id: issueId, activity: presence.activity }])
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
    if (this.ctx.getTags(ws).includes("issue")) this.publish([{ type: "viewers", count: this.viewers(ws) }])
  }
  webSocketError(ws: WebSocket) {
    ws.close(1011, "Connection error")
    this.webSocketClose(ws)
  }
}
