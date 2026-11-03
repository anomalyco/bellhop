import { DurableObject } from "cloudflare:workers"
import type { LiveEvent } from "../shared/api"
import { sql } from "./core"
import { expireActivity, refreshActivity } from "./events"
import { currentActivity } from "./issues"

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
  async fetch(req: Request) {
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return Response.json(
        { error: { code: "upgrade_required", message: "WebSocket upgrade required" } },
        { status: 426 }
      )
    const issueId = this.issueId
    const activity = issueId
      ? currentActivity(
          await sql(this.env, "SELECT activity FROM issues WHERE id=?", issueId).first<string>("activity")
        )
      : null
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server, [issueId ? "issue" : "app"])
    const viewers = this.sockets().length
    server.send(JSON.stringify({ type: "hello", viewers, activity } satisfies LiveEvent))
    if (issueId) this.publish([{ type: "viewers", count: viewers }])
    return new Response(null, { status: 101, webSocket: client })
  }
  publish(events: LiveEvent[]) {
    const messages = events.map((e) => JSON.stringify(e))
    for (const ws of this.sockets()) {
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
  refreshPresence(appId: string, issueId: string) {
    return this.serialize(() =>
      refreshActivity(
        this.env,
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
        const next = await expireActivity(this.env, scope.appId, scope.issueId, (e) => this.publish([e]))
        if (next) await this.ctx.storage.setAlarm(next)
      }
    })
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong")
    else ws.close(1008, "Only ping supported")
  }
  webSocketClose(ws: WebSocket) {
    if (this.ctx.getTags(ws).includes("issue")) this.publish([{ type: "viewers", count: this.sockets(ws).length }])
  }
  webSocketError(ws: WebSocket) {
    ws.close(1011, "Connection error")
    this.webSocketClose(ws)
  }
}
