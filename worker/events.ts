import type { Activity, Actor, App, IssueSummary, LiveEvent, TimelineItem, WebhookEventType } from "../shared/api"
import { missing, now, sql, str } from "./core"
import { currentActivity } from "./issues"
import { enqueueWebhook } from "./webhooks"

export type Work = Pick<ExecutionContext, "waitUntil">
export interface Change {
  type: Exclude<WebhookEventType, "ping">
  app: Pick<App, "id" | "slug" | "name">
  origin: string
  issue: IssueSummary
  actor: Actor
  items?: TimelineItem[]
  changes?: string[]
}
export const appRoom = (env: Env, id: string) => env.ROOMS.getByName(`app:${id}`)
export const issueRoom = (env: Env, id: string) => env.ROOMS.getByName(`issue:${id}`)

// All issue writes converge here after D1 commits. Only the public summary goes on the wire.
export function emit(env: Env, ctx: Work, change: Change) {
  const { type, app, issue, items = [] } = change
  const updated: LiveEvent = { type: "issue.updated", issue }
  const list: LiveEvent = type === "issue.opened" ? { type: "issue.created", issue } : updated
  const timeline: LiveEvent[] = items.map((item) => ({ type: "timeline.added", issue_id: issue.id, item }))
  ctx.waitUntil(
    Promise.all([appRoom(env, app.id).publish([list]), issueRoom(env, issue.id).publish([...timeline, updated])])
  )
  if (type === "comment.created" && change.actor.type === "agent") return
  const origin = env.PUBLIC_ORIGIN || change.origin
  ctx.waitUntil(
    enqueueWebhook(env, origin, {
      app,
      type,
      actor: change.actor,
      issue: { ...issue, url: new URL(`/${app.slug}/issues/${issue.number}`, origin).href },
      ...(type === "issue.updated" && { changes: change.changes ?? [] }),
      ...(type === "comment.created" && { comment: items.find((i) => i.kind === "comment")?.comment })
    })
  )
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
  await issueRoom(env, issueId).refreshPresence(appId, issueId)
}
// Refresh from D1 rather than broadcasting the caller's snapshot: overlapping requests can
// reach a Room in a different order than their commits. The Room serializes refresh and expiry.
export async function refreshActivity(
  env: Env,
  appId: string,
  issueId: string,
  publish: (event: LiveEvent) => void,
  schedule: (at: number | null) => Promise<void>
) {
  const activity = currentActivity(
    await sql(env, "SELECT activity FROM issues WHERE id=? AND app_id=?", issueId, appId).first<string>("activity")
  )
  const event: LiveEvent = { type: "activity", issue_id: issueId, activity }
  await schedule(activity ? Date.parse(activity.expires_at) : null)
  publish(event)
  await appRoom(env, appId).publish([event])
}
// Called inside the issue Room's alarm; do not RPC back into the same Room.
export async function expireActivity(env: Env, appId: string, issueId: string, publish: (event: LiveEvent) => void) {
  const cleared = await sql(
    env,
    "UPDATE issues SET activity=NULL WHERE id=? AND app_id=? AND json_extract(activity,'$.expires_at')<=?",
    issueId,
    appId,
    now()
  ).run()
  if (cleared.meta.changes) {
    const event: LiveEvent = { type: "activity", issue_id: issueId, activity: null }
    publish(event)
    await appRoom(env, appId).publish([event])
  }
  const next = await sql(
    env,
    "SELECT json_extract(activity,'$.expires_at') expires_at FROM issues WHERE id=? AND app_id=?",
    issueId,
    appId
  ).first<string>("expires_at")
  return next ? Date.parse(next) : null
}
