import { DurableObject } from "cloudflare:workers"
import { requesterActor } from "./helpdesk-data"
import { acceptStream, deliverStream } from "./v1/realtime"
import type { Hint } from "./v1/signals"
import type { Actor, Comment, IssueSummary, LiveEvent, Role, TimelineItem } from "../shared/api"
import { expireActivity, refreshActivity } from "./events"
import { publicFeedIssue, readPresence } from "./issues"
import { sql, now } from "./core"
import { agentAccessSQL } from "./permissions"
import { actorIds, commentView, gateOf, includesComment, outsider, sees, type Gate, type Viewer } from "./visibility"
import { voteCount } from "./conversation"
import { logAttachment } from "./report-data"
import { actorIdsIn, tierBag, tierQuery, tierReplacer, type TierMap } from "./tier-actors"

type Attachment = Viewer & {
  format: "conversation-v1"
  app: string
  session: string | null
  bearer: string | null
  at: number
}
// Use an allowlist on the wire. TypeScript's structural typing also accepts a full Issue where
// IssueSummary is expected; never serialize accidental timeline/body/notes on a summary frame.
function summaryFrame(i: IssueSummary): IssueSummary {
  const {
    id,
    number,
    title,
    status,
    close_reason,
    labels,
    author,
    assignee,
    comment_count,
    created_at,
    updated_at,
    activity,
    private: priv,
    hidden,
    votes,
    viewer_voted,
    locked,
    pinned
  } = i
  return {
    id,
    number,
    title,
    status,
    close_reason,
    labels,
    author,
    assignee,
    comment_count,
    created_at,
    updated_at,
    activity,
    private: priv,
    hidden,
    votes,
    viewer_voted,
    locked,
    pinned
  }
}
function validAttachment(a: Attachment | null | undefined) {
  return (
    a?.format === "conversation-v1" &&
    typeof a.app === "string" &&
    typeof a.team === "boolean" &&
    Number.isFinite(a.at) &&
    (a.voter === null || typeof a.voter === "string") &&
    (a.aliases === undefined || (Array.isArray(a.aliases) && a.aliases.every((id) => typeof id === "string"))) &&
    (a.actorId === null || typeof a.actorId === "string") &&
    (a.session === null || (typeof a.session === "string" && /^[a-f0-9]{64}$/.test(a.session))) &&
    (a.bearer === null || (typeof a.bearer === "string" && /^[a-f0-9]{64}$/.test(a.bearer))) &&
    (!a.team || !!(a.bearer || a.session))
  )
}
type Delivery = {
  app?: string
  internalOnly?: boolean
  moved?: { gate: Gate; target: string; number: number }
  deleted?: Gate
  actorIssues?: string[]
}
type PolicyRow = {
  id: string
  app_id: string
  private: number
  hidden: number
  reporter: string
  public_count: number
  team_count: number
  team_votes: number
  locked: number
  pinned: number
}
type CommentRow = {
  held_at: string | null
  sent_by: string | null
  report_logs: string
  via: Comment["via"]
  tier_bag: string | null
  id: string
  body: string
  author: string
  hidden: string | null
  updated_at: string
  edited_at: string | null
  role: Role | null
  reporter: string
  internal: number
  mentions: string
  helpful: number
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
    return this.ctx.getWebSockets().filter((s) => {
      if (s === except || s.readyState !== WebSocket.OPEN) return false
      try {
        if (validAttachment(s.deserializeAttachment())) return true
      } catch {}
      s.close(1012, "Reconnect to refresh conversation permissions")
      return false
    })
  }
  /** Clients ping every 25 s; a socket silent for 70 s belongs to a tab that went away without closing. */
  private viewers(except?: WebSocket, app?: string) {
    const cutoff = Date.now() - 70_000
    return this.sockets(except).filter((s) => {
      if (app && s.deserializeAttachment()?.app !== app) return false
      const seen = this.ctx.getWebSocketAutoResponseTimestamp(s)?.getTime() ?? s.deserializeAttachment()?.at ?? 0
      if (seen >= cutoff) return true
      s.close(1001, "Idle")
      return false
    }).length
  }
  async fetch(req: Request) {
    if (this.ctx.id.name?.startsWith("enduser:")) return this.serialize(() => acceptStream(this.ctx, this.env, req))
    if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      return Response.json(
        { error: { code: "upgrade_required", message: "WebSocket upgrade required" } },
        { status: 426 }
      )
    const issueId = this.issueId
    if (new URL(req.url).pathname !== "/__bellhop_conversation_socket") return new Response(null, { status: 426 })
    const attached: Attachment = {
      ...JSON.parse(req.headers.get("X-Bellhop-Viewer") ?? "{}"),
      format: "conversation-v1",
      at: Date.now()
    }
    if (!validAttachment(attached)) return new Response(null, { status: 403 })
    const presence = issueId ? await readPresence(this.env, issueId, attached.app) : null
    if (issueId && (!presence || !sees(attached, presence.gate))) return new Response(null, { status: 404 })
    const activity = presence?.activity ?? null
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket]
    this.ctx.acceptWebSocket(server, [issueId ? "issue" : "app"])
    server.serializeAttachment(attached)
    const viewers = this.viewers(undefined, attached.app)
    server.send(JSON.stringify({ type: "hello", viewers, activity } satisfies LiveEvent))
    if (issueId) await this.deliver([{ type: "viewers", count: viewers }], { app: attached.app }, server)
    return new Response(null, { status: 101, webSocket: client })
  }
  publishConversation(events: LiveEvent[], options: Delivery) {
    if (this.ctx.id.name === "feed") throw new Error("Feed accepts only a fresh public projection")
    return this.deliver(events, options)
  }
  private async deliver(events: LiveEvent[], options: Delivery, except?: WebSocket) {
    const sockets = this.sockets(except)
    if (!sockets.length) return
    if (this.ctx.id.name === "feed") {
      const listeners = sockets.map((ws) => ({ ws, a: ws.deserializeAttachment() as Attachment | null })),
        ids = events.flatMap((e) => (e.type === "feed.issue" ? [e.issue.id] : []))
      const votes = ids.length
        ? (
            await sql(
              this.env,
              `SELECT v.issue_id,p.key listener FROM json_each(?) p LEFT JOIN sessions s ON s.token_hash=json_extract(p.value,'$.session') AND s.expires_at>?
        JOIN issue_votes v ON v.voter=CASE WHEN json_extract(p.value,'$.session') IS NULL THEN json_extract(p.value,'$.voter') ELSE s.user_id END WHERE v.issue_id IN (SELECT value FROM json_each(?))`,
              JSON.stringify(listeners.map((l) => ({ session: l.a?.session, voter: l.a?.voter }))),
              now(),
              JSON.stringify(ids)
            ).all<{ issue_id: string; listener: number }>()
          ).results
        : []
      for (const [index, { ws }] of listeners.entries())
        try {
          for (const e of events)
            ws.send(
              JSON.stringify(
                e.type === "feed.issue"
                  ? {
                      ...e,
                      issue: {
                        ...summaryFrame(e.issue),
                        app: e.issue.app,
                        viewer_voted: votes.some((r) => r.issue_id === e.issue.id && r.listener === index)
                      }
                    }
                  : e,
                tierReplacer()
              )
            )
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
    const app =
      options.app ??
      (this.ctx.id.name?.startsWith("app:")
        ? this.ctx.id.name.slice(4)
        : (listeners.find((x) => x.a?.app)?.a?.app ?? ""))
    const people = JSON.stringify([
      ...new Map(
        [outsider, ...listeners.flatMap((x) => (x.a ? [x.a] : []))].map((v) => [
          v.voter ?? v.actorId ?? "",
          { voter: v.voter ?? v.actorId ?? "", ids: actorIds(v) }
        ])
      ).values()
    ])
    // Evaluate every socket's credentials, issue gates, and latest comment bodies in one DB
    // snapshot. A queued event must not pair yesterday's public ACL with today's private body.
    const q = [
      sql(
        this.env,
        `SELECT id,app_id,private,hidden IS NOT NULL hidden,json_extract(author,'$.id') reporter,locked,pinned,
         (SELECT count(*) FROM comments WHERE issue_id=i.id AND internal=0) public_count,(SELECT count(*) FROM comments WHERE issue_id=i.id) team_count,
         ${voteCount("1", "'[]'")} team_votes FROM issues i WHERE id IN(SELECT value FROM json_each(?))`,
        JSON.stringify([...ids])
      )
    ]
    const ci = commentIds.size
      ? q.push(
          sql(
            this.env,
            `SELECT c.id,c.author,c.body,c.hidden,c.updated_at,c.edited_at,c.internal,c.mentions,c.via,${sessions.length || bearers.length ? tierBag("i.app_id", ["c.author", "json_extract(c.hidden,'$.by')"], "c.mentions") : "NULL"} tier_bag,(SELECT count(*) FROM comment_helpful WHERE comment_id=c.id) helpful,m.role,json_extract(i.author,'$.id') reporter
      ,(SELECT json_group_array(json_object('id',l.id,'name',l.name,'size',l.size,'metadata_id',md.id)) FROM report_metadata md JOIN report_logs l ON l.metadata_id=md.id WHERE md.app_id=i.app_id AND md.comment_id=c.id AND md.issue_id=i.id) report_logs
      ,c.held_at,c.sent_by FROM team_comments c JOIN issues i ON i.id=c.issue_id LEFT JOIN members m ON m.app_id=i.app_id AND m.user_id=json_extract(c.author,'$.id') WHERE c.id IN (SELECT value FROM json_each(?))`,
            JSON.stringify([...commentIds])
          )
        ) - 1
      : -1
    const si = sessions.length
      ? q.push(
          sql(
            this.env,
            `SELECT s.token_hash hash,s.user_id id,m.role IS NOT NULL team FROM sessions s JOIN apps a ON a.id=?1 LEFT JOIN members m ON m.user_id=s.user_id AND m.app_id=a.id WHERE (a.mode!='helpdesk' OR m.role IS NOT NULL) AND s.expires_at>?2 AND s.token_hash IN(SELECT value FROM json_each(?3))
             UNION ALL SELECT s.hash,s.contact_id,0 FROM contact_sessions s JOIN apps a ON a.id=s.app_id WHERE a.id=?1 AND a.mode='helpdesk' AND s.expires>unixepoch() AND s.hash IN(SELECT value FROM json_each(?3))`,
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
    const vi = events.some((e) => e.type === "issue.created" || e.type === "issue.updated")
      ? q.push(
          sql(
            this.env,
            `SELECT i.id,json_extract(p.value,'$.voter') voter,
      EXISTS(SELECT 1 FROM issue_votes WHERE issue_id=i.id AND voter=json_extract(p.value,'$.voter')) voted,${voteCount("0", "json_extract(p.value,'$.ids')")} votes FROM issues i,json_each(?) p WHERE i.id IN(SELECT value FROM json_each(?))`,
            people,
            JSON.stringify([...ids])
          )
        ) - 1
      : -1
    const hi = commentIds.size
      ? q.push(
          sql(
            this.env,
            `SELECT comment_id,voter FROM comment_helpful WHERE comment_id IN(SELECT value FROM json_each(?)) AND voter IN(SELECT json_extract(value,'$.voter') FROM json_each(?))`,
            JSON.stringify([...commentIds]),
            people
          )
        ) - 1
      : -1
    const targetMembers = options.moved
      ? q.push(
          sql(
            this.env,
            `SELECT user_id id FROM members WHERE app_id=?1 AND user_id IN (SELECT json_extract(value,'$.voter') FROM json_each(?2))
      UNION ALL SELECT agent_id FROM (${agentAccessSQL}) WHERE app_id=?1 AND role IS NOT NULL AND agent_id IN(SELECT json_extract(value,'$.voter') FROM json_each(?2))`,
            options.moved.target,
            people
          )
        ) - 1
      : -1
    const tierActors = sessions.length || bearers.length ? actorIdsIn(events) : []
    const tierIndex = tierActors.length ? q.push(tierQuery(this.env, app, tierActors)) - 1 : -1
    const result = await this.env.DB.batch<unknown>(q),
      resultRows = <T>(i: number) => (result[i]?.results ?? []) as T[]
    const gates = new Map(
        resultRows<PolicyRow>(0).map((r) => [r.id, { ...r, private: !!r.private, hidden: !!r.hidden }])
      ),
      comments = resultRows<CommentRow>(ci),
      accounts = resultRows<{ hash: string; id: string; team: number }>(si),
      agents = resultRows<{ hash: string; id: string }>(ai)
    const current = new Map(comments.map((c) => [c.id, c])),
      auth = new Map(accounts.map((s) => [s.hash, { team: !!s.team, actorId: s.id }]))
    for (const a of agents) auth.set(a.hash, { team: true, actorId: a.id })
    const votes = new Map(
        resultRows<{ id: string; voter: string; votes: number; voted: number }>(vi).map((r) => [
          r.id + ":" + r.voter,
          r
        ])
      ),
      helpful = new Set(resultRows<{ comment_id: string; voter: string }>(hi).map((r) => r.comment_id + ":" + r.voter)),
      targets = new Set(resultRows<{ id: string }>(targetMembers).map((r) => r.id))
    const tiers: TierMap = JSON.parse(resultRows<{ bag: string }>(tierIndex)[0]?.bag ?? "{}")
    // A guest claim or mention edit can change a comment's actors after it was enqueued.
    for (const row of comments) if (row.tier_bag) Object.assign(tiers, JSON.parse(row.tier_bag))
    for (const { ws, a } of listeners) {
      if (a?.app && a.app !== app) continue
      const key = a?.session || a?.bearer,
        v: Viewer = key
          ? (auth.get(key) ?? outsider)
          : { team: false, actorId: a?.actorId ?? null, aliases: a?.aliases, voter: a?.voter }
      const conversationPayload = events.some((e) =>
        ["timeline.added", "comment.updated", "comment.deleted", "issue.created", "issue.updated"].includes(e.type)
      )
      if (!v.team && (options.internalOnly === true || (conversationPayload && options.internalOnly !== false)))
        continue
      const voter = v.voter ?? v.actorId ?? ""
      const allowed = (id: string) => {
        const g = gates.get(id)
        return !!g && (!app || g.app_id === app) && sees(v, g)
      }
      const shape = (c: Comment) => {
        const row = current.get(c.id)
        if (!row || !!row.held_at !== !!c.held || !includesComment(v, !!row.internal || !!row.held_at)) return null
        const author: Actor = JSON.parse(row.author)
        if (author.type === "member") author.role = row.role
        if (author.type === "guest") author.name ??= null
        return commentView(
          {
            ...c,
            held: row.held_at ? { at: row.held_at } : null,
            sent_by: row.sent_by ? JSON.parse(row.sent_by) : null,
            attachments: [
              ...c.attachments.filter((l) => !l.id.startsWith("ml_")),
              ...(v.team || actorIds(v).includes(author.id)
                ? (
                    JSON.parse(row.report_logs) as { id: string; name: string; size: number; metadata_id: string }[]
                  ).map((l) => logAttachment(l, l.metadata_id))
                : [])
            ],
            body: row.body,
            via: row.via,
            hidden: row.hidden ? JSON.parse(row.hidden) : null,
            author,
            by_issue_author: row.reporter === author.id,
            internal: !!row.internal,
            mentions: JSON.parse(row.mentions),
            helpful: row.helpful,
            viewer_helpful: helpful.has(c.id + ":" + voter),
            edited_at: row.edited_at,
            updated_at: row.updated_at
          },
          v
        )
      }
      try {
        for (let e of events) {
          const id = eventId(e) ?? this.issueId
          if (e.type === "issue.moved") {
            const g = gates.get(e.issue_id)
            if (
              options.moved &&
              g &&
              g.app_id === options.moved.target &&
              !v.actorId?.startsWith("ct_") &&
              sees(v, options.moved.gate) &&
              sees({ ...v, team: targets.has(v.actorId ?? "") }, g)
            )
              ws.send(JSON.stringify(e))
            else if (options.moved && sees(v, options.moved.gate))
              ws.send(
                JSON.stringify({
                  type: "issue.deleted",
                  issue_id: e.issue_id,
                  number: options.moved.number
                } satisfies LiveEvent)
              )
            if (this.issueId) ws.close(1000, "Issue moved")
            continue
          } else if (e.type === "issue.deleted") {
            if (!options.deleted || !sees(v, options.deleted)) continue
          } else if (id && !allowed(id)) {
            // If the row vanished, a queued update may have raced its deletion notification.
            // Drop the stale payload without closing the socket ahead of issue.deleted.
            if (this.issueId && gates.get(id)?.app_id === app) ws.close(1008, "Issue unavailable")
            continue
          }
          if (e.type === "actor.updated" && !this.issueId && !v.team && !options.actorIssues?.some(allowed)) continue
          if ((e.type === "issue.updated" || e.type === "issue.created") && !sees(v, gateOf(e.issue))) continue
          if (e.type === "issue.updated" || e.type === "issue.created") {
            const g = gates.get(e.issue.id)!,
              stat = votes.get(e.issue.id + ":" + voter)
            e = {
              ...e,
              issue: {
                ...summaryFrame(e.issue),
                locked: !!g.locked,
                pinned: !!g.pinned,
                comment_count: v.team ? g.team_count : g.public_count,
                votes: v.team ? g.team_votes : (stat?.votes ?? 0),
                viewer_voted: !!stat?.voted
              }
            }
          }
          if (e.type === "timeline.added") {
            if (e.item.kind === "comment") {
              const c = shape(e.item.comment)
              if (!c) continue
              e = { ...e, item: { kind: "comment", comment: c } }
            } else {
              if (
                !v.team &&
                (e.item.event.data.rule ||
                  ["hidden", "unhidden", "routed", "approval.requested", "approval.decided"].includes(
                    e.item.event.type
                  ))
              )
                continue
              const other = relationId(e.item)
              if (other && !allowed(other)) continue
              if (!v.team)
                e = {
                  ...e,
                  item: { kind: "event", event: { ...e.item.event, actor: requesterActor(e.item.event.actor) } }
                }
            }
          } else if (e.type === "comment.updated") {
            const c = shape(e.comment)
            if (!c) continue
            e = { ...e, comment: c }
          }
          ws.send(JSON.stringify(e, tierReplacer(v.team ? tiers : undefined)))
        }
      } catch {
        ws.close(1011, "Send failed")
      }
    }
  }
  private pending = Promise.resolve()
  contactChanged(app: string, who: string, hint: Hint) {
    if (this.ctx.id.name !== `enduser:${app}:${who}`) throw Error("Wrong stream")
    return this.serialize(() => deliverStream(this.ctx, this.env, hint))
  }
  reviewContact() {
    if (!this.ctx.id.name?.startsWith("enduser:")) throw Error("Wrong stream")
    return this.serialize(() => deliverStream(this.ctx, this.env))
  }
  private serialize<T>(work: () => Promise<T>) {
    const next = this.pending.then(work)
    this.pending = next.then(
      () => {},
      () => {}
    )
    return next
  }
  // A queued write can arrive after an admin unlists its workspace. Never trust that write's
  // payload in the global room: re-read the public projection immediately before broadcasting.
  refreshConversationFeed(issueId: string, type: "feed.issue" | "activity") {
    return this.serialize(async () => {
      if (this.ctx.id.name !== "feed" || !this.ctx.getWebSockets().length) return
      if (type === "feed.issue") {
        const issue = await publicFeedIssue(this.env, issueId)
        if (issue) await this.deliver([{ type, issue }], {})
      } else {
        const presence = await readPresence(this.env, issueId, undefined, true)
        if (presence) await this.deliver([{ type, issue_id: issueId, activity: presence.activity }], {})
      }
    })
  }
  refreshConversationPresence(appId: string, issueId: string, clear?: Actor) {
    return this.serialize(() =>
      refreshActivity(
        this.env,
        this.ctx,
        appId,
        issueId,
        (e) => this.publishConversation([e], { app: appId }),
        async (at, actor) => {
          if (at !== null) {
            await this.ctx.storage.put("scope", { appId, issueId, actor })
            await this.ctx.storage.setAlarm(at)
          } else await this.ctx.storage.deleteAlarm()
        },
        clear
      )
    )
  }
  alarm() {
    if (this.ctx.id.name?.startsWith("enduser:")) return this.reviewContact()
    return this.serialize(async () => {
      const scope = await this.ctx.storage.get<{ appId: string; issueId: string; actor?: Actor }>("scope")
      if (scope) {
        const next = await expireActivity(
          this.env,
          this.ctx,
          scope.appId,
          scope.issueId,
          (e) => this.publishConversation([e], { app: scope.appId }),
          scope.actor
        )
        if (next) await this.ctx.storage.setAlarm(next)
      }
    })
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message === "ping") ws.send("pong")
    else ws.close(1008, "Only ping supported")
  }
  webSocketClose(ws: WebSocket, code = 1000, reason = "") {
    if (this.ctx.id.name?.startsWith("enduser:")) {
      if (code !== 1005 && code !== 1006 && code !== 1015) ws.close(code, reason)
      return this.serialize(async () => {
        if (!this.ctx.getWebSockets().some(other => other !== ws && other.readyState === WebSocket.OPEN))
          await this.ctx.storage.deleteAlarm()
      })
    }
    if (this.ctx.getTags(ws).includes("issue")) {
      const app = ws.deserializeAttachment()?.app
      this.ctx.waitUntil(this.publishConversation([{ type: "viewers", count: this.viewers(ws, app) }], { app }))
    }
  }
  webSocketError(ws: WebSocket) {
    ws.close(1011, "Connection error")
    this.webSocketClose(ws)
  }
}
