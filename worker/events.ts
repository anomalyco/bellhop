import type {
  Activity,
  Actor,
  App,
  Comment,
  IssueSummary,
  LiveEvent,
  TimelineItem,
  Label,
  CloseReason,
  IssueStatus
} from "../shared/api"
import { missing, now, rows, sql, str } from "./core"
import { readPresence, visibleIssues } from "./issues"
import { enqueueWebhooks, type Hook } from "./webhooks"
import { projectTiers } from "./tier-actors"

export type Work = Pick<ExecutionContext, "waitUntil">
export interface Change {
  type: "issue.opened" | "issue.updated" | "comment.created"
  app: Pick<App, "id" | "slug" | "name" | "public">
  origin: string
  issue: IssueSummary
  actor: Actor
  items?: TimelineItem[]
  comments?: Comment[]
  deletedComment?: string
  removed?: Comment
  ruleItems?: TimelineItem[]
  internalOnly?: boolean
  liveOnly?: boolean
  mentioned?: Actor[]
  changes?: string[]
}
export const appRoom = (env: Env, id: string) => env.ROOMS.getByName(`app:${id}`)
export const issueRoom = (env: Env, id: string) => env.ROOMS.getByName(`issue:${id}`)
export const feedRoom = (env: Env) => env.ROOMS.getByName("feed")

export function actorUpdated(env: Env, ctx: Work, app: string, issues: string[], previous_id: string, actor: Actor) {
  const event: LiveEvent = { type: "actor.updated", previous_id, actor }
  ctx.waitUntil(
    (async () => {
      await appRoom(env, app).publishConversation([event], { app, actorIssues: issues })
      for (let i = 0; i < issues.length; i += 8) {
        await Promise.all(issues.slice(i, i + 8).map((id) => issueRoom(env, id).publishConversation([event], { app })))
      }
    })()
  )
  // A guest rename or sign-in can change an issue author without an ordinary issue write.
  // Only refresh summaries that actually show that actor (not every old comment's thread).
  if (issues.length)
    ctx.waitUntil(
      (async () => {
        if (!(await sql(env, "SELECT 1 FROM apps WHERE id=? AND public=1", app).first())) return
        for (let offset = 0; offset < issues.length; offset += 64) {
          const affected = await rows<{ id: string }>(
            sql(
              env,
              `SELECT i.id FROM issues i WHERE ${visibleIssues("?")} AND i.id IN (SELECT value FROM json_each(?))
        AND ? IN (json_extract(i.author,'$.id'),json_extract(i.assignee,'$.id'),json_extract(i.activity,'$.actor.id'))`,
              app,
              JSON.stringify(issues.slice(offset, offset + 64)),
              actor.id
            )
          )
          for (let i = 0; i < affected.length; i += 8)
            await Promise.all(
              affected.slice(i, i + 8).map((r) => feedRoom(env).refreshConversationFeed(r.id, "feed.issue"))
            )
        }
      })()
    )
}

// All issue writes converge here after D1 commits. Only the public summary goes on the wire.
export function emit(env: Env, ctx: Work, change: Change) {
  // Room RPCs are mixed-audience and may cross a deployment boundary. Even a pre-tiers Room
  // must never receive tier metadata. The receiving Room decorates only authenticated team frames.
  change = projectTiers(change)
  const { type, app, issue, items = [] } = change
  const updated: LiveEvent = { type: "issue.updated", issue }
  const list: LiveEvent = type === "issue.opened" ? { type: "issue.created", issue } : updated
  const timeline: LiveEvent[] = items.map((item) => ({ type: "timeline.added", issue_id: issue.id, item }))
  for (const comment of change.comments ?? []) timeline.push({ type: "comment.updated", issue_id: issue.id, comment })
  if (change.deletedComment)
    timeline.push({ type: "comment.deleted", issue_id: issue.id, comment_id: change.deletedComment })
  const affected = [...(change.comments ?? []), ...items.flatMap((i) => (i.kind === "comment" ? [i.comment] : []))]
  const internalOnly = change.internalOnly === true || (affected.length > 0 && affected.every((c) => c.internal))
  ctx.waitUntil(
    Promise.all([
      appRoom(env, app.id).publishConversation([list], { app: app.id, internalOnly }),
      issueRoom(env, issue.id).publishConversation([...timeline, updated], { app: app.id, internalOnly })
    ])
  )
  if (!internalOnly && app.public && !issue.private && !issue.hidden)
    ctx.waitUntil(feedRoom(env).refreshConversationFeed(issue.id, "feed.issue"))
  if (change.liveOnly) return
  const origin = env.PUBLIC_ORIGIN || change.origin
  const payload = { type, ...(type === "issue.updated" && { changes: change.changes ?? [] }) }
  // Webhook recipients are team integrations, not one of the connected browser viewers.
  const comments = change.comments?.length
    ? change.comments
    : items.flatMap((i) => (i.kind === "comment" ? [i.comment] : []))
  const hooks: Hook[] = []
  for (const mentioned of change.mentioned ?? []) {
    if (mentioned.id !== change.actor.id)
      hooks.push({
        ...payload,
        type: "mention.created",
        mentioned,
        ...(comments[0] ? { comment: { ...comments[0], viewer_is_author: false, viewer_helpful: false } } : {})
      })
  }
  const edit = change.changes?.includes("comment.edited")
  if (!(change.actor.type === "agent" && (type === "comment.created" || edit))) {
    if (!comments.length) hooks.push(payload)
    else
      for (const c of comments) {
        const comment = { ...c, viewer_is_author: false, viewer_helpful: false }
        hooks.push({ ...payload, comment })
        if (edit) hooks.push({ type: "comment.edited", comment })
      }
  }
  if (change.removed)
    hooks.push({
      type: "comment.deleted",
      comment: {
        ...change.removed,
        viewer_is_author: false,
        viewer_helpful: false,
        body: "",
        mentions: [],
        attachments: []
      }
    })
  for (const item of [...items, ...(change.ruleItems ?? [])]) {
    if (item.kind !== "event") continue
    const { type: t, data } = item.event
    if (t === "status_changed" && data.from !== data.to) {
      if (data.to === "closed")
        hooks.push({
          type: "issue.closed",
          transition: { status: "closed", close_reason: data.close_reason as CloseReason }
        })
      else if (data.from === "closed")
        hooks.push({ type: "issue.reopened", transition: { status: data.to as IssueStatus, close_reason: null } })
    } else if (t === "labeled" || t === "unlabeled") hooks.push({ type: `issue.${t}`, label: data.label as Label })
    else if (t === "assigned" || t === "claimed")
      hooks.push({
        type: "issue.assigned",
        transition: { assignee: t === "claimed" ? item.event.actor : (data.assignee as Actor | null) }
      })
  }
  ctx.waitUntil(enqueueWebhooks(env, origin, app, change.actor, issue, hooks))
}
export async function setActivity(
  env: Env,
  appId: string,
  issueId: string,
  actor: Actor,
  text: string | null = null,
  clear = false
) {
  if (text !== null) str(text, "activity", 240, true)
  const activity: Activity | null = clear
    ? null
    : { actor, text, expires_at: new Date(Date.now() + 60000).toISOString() }
  // Clearing after an agent posts must not erase another agent's newer presence.
  const result = await sql(
    env,
    `UPDATE issues SET activity=? WHERE id=? AND app_id=? ${clear ? "AND json_extract(activity,'$.actor.id')=?" : ""}`,
    activity ? JSON.stringify(activity) : null,
    issueId,
    appId,
    ...(clear ? [actor.id] : [])
  ).run()
  if (!result.meta.changes) {
    if (clear) return
    missing()
  }
  await issueRoom(env, issueId).refreshConversationPresence(appId, issueId)
}
// Refresh from D1 rather than broadcasting the caller's snapshot: overlapping requests can
// reach a Room in a different order than their commits. The Room serializes refresh and expiry.
export async function refreshActivity(
  env: Env,
  ctx: Work,
  appId: string,
  issueId: string,
  publish: (event: LiveEvent) => Promise<void>,
  schedule: (at: number | null) => Promise<void>
) {
  const presence = await readPresence(env, issueId, appId),
    activity = presence?.activity ?? null
  if (!presence) return // A delayed source-room refresh must not cancel a transferred issue's target alarm.
  const event: LiveEvent = { type: "activity", issue_id: issueId, activity }
  await schedule(activity ? Date.parse(activity.expires_at) : null)
  await publish(event)
  if (presence?.public) ctx.waitUntil(feedRoom(env).refreshConversationFeed(issueId, "activity"))
  await appRoom(env, appId).publishConversation([event], { app: appId })
}
// Called inside the issue Room's alarm; do not RPC back into the same Room.
export async function expireActivity(
  env: Env,
  ctx: Work,
  appId: string,
  issueId: string,
  publish: (event: LiveEvent) => Promise<void>
) {
  const cleared = await sql(
    env,
    `UPDATE issues SET activity=NULL WHERE id=? AND app_id=? AND json_extract(activity,'$.expires_at')<=?
     RETURNING ((SELECT public FROM apps WHERE id=issues.app_id) AND private=0 AND hidden IS NULL) public`,
    issueId,
    appId,
    now()
  ).first<{ public: number }>()
  if (cleared) {
    const event: LiveEvent = { type: "activity", issue_id: issueId, activity: null }
    await publish(event)
    if (cleared.public) ctx.waitUntil(feedRoom(env).refreshConversationFeed(issueId, "activity"))
    await appRoom(env, appId).publishConversation([event], { app: appId })
    return null // The guarded write cleared this presence; a later refresh schedules its own alarm.
  }
  const next = await sql(
    env,
    "SELECT json_extract(activity,'$.expires_at') expires_at FROM issues WHERE id=? AND app_id=?",
    issueId,
    appId
  ).first<string>("expires_at")
  return next ? Date.parse(next) : null
}
