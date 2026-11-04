import { DEFAULT_WEBHOOK_EVENTS, type WebhookPayload, type WebhookEventType, type IssueSummary } from "../shared/api"
import { appUrl, bad, hex, missing, now, secret, sha256, sql, str, uid } from "./core"
import { teamProjection } from "./tier-actors"
import { reportQuery, decodeReport, type ReportRow } from "./report-data"
import { auditActor } from "./audit"
import { importMessage } from "./github-import"
import { requestJson, typeInfo, type TypeInfo } from "./request-types"

export function webhookUrl(value: unknown, env: Env) {
  if (value === null) return null
  const url = URL.parse(str(value, "url", 4096))
  if (!url || url.username || url.password) bad("Invalid webhook URL")
  const host = url.hostname.toLowerCase().replace(/\.+$/, ""),
    own = (env.APP_DOMAIN || "blhp.app").toLowerCase().replace(/\.+$/, "")
  if (
    url.protocol !== "https:" ||
    !host.includes(".") ||
    /^[\d.]+$/.test(host) ||
    !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    ["localhost", "local", "internal", "localdomain", "home.arpa", "blhp.app", own].some(
      (s) => host === s || host.endsWith("." + s)
    )
  )
    bad("Webhook must use HTTPS on an external domain")
  return url.href
}

export const webhookEvents = [
  "issue.escalated",
  "issue.handed_back",
  "ping",
  ...DEFAULT_WEBHOOK_EVENTS,
  "issue.closed",
  "issue.reopened",
  "issue.labeled",
  "issue.unlabeled",
  "issue.assigned",
  "issue.deleted",
  "issue.moved",
  "comment.edited",
  "comment.deleted",
  "verification.completed",
  "reply.held",
  "approval.requested",
  "approval.decided"
] satisfies WebhookEventType[]

// Read the destination in the same transaction as the action. webhookUrl stores
// URL.href (including the slash after the host). Fail closed on malformed legacy
// authorities: no userinfo, path, query or fragment may ever enter the audit log.
function hookEntry(
  env: Env,
  app: string,
  actor: NonNullable<WebhookPayload["actor"]>,
  action: string,
  target: Record<string, unknown>,
  data: Record<string, unknown> = {},
  beforeWrite = false
) {
  return sql(
    env,
    `WITH endpoint AS (SELECT CASE WHEN url LIKE 'https://%' THEN substr(url,9) WHEN url LIKE 'http://%' THEN substr(url,8) END rest FROM webhook_settings WHERE app_id=?1),
    dest AS (SELECT substr(rest,1,instr(rest||'/','/')-1) host FROM endpoint)
    INSERT INTO audit_log(app_id,actor,action,target,data) SELECT ?1,?2,?3,json_set(?4,'$.host',CASE
      WHEN host!='' AND host NOT GLOB '*[^a-zA-Z0-9.:-]*' AND (instr(host,':')=0 OR
        (instr(host,':') BETWEEN 2 AND length(host)-1 AND substr(host,instr(host,':')+1) NOT GLOB '*[^0-9]*')) THEN host END),?5
    FROM dest ${beforeWrite ? "" : "WHERE changes()>0"}`,
    app,
    auditActor(actor),
    action,
    JSON.stringify(target),
    JSON.stringify(data)
  )
}
export async function configureWebhook(
  env: Env,
  app: string,
  actor: NonNullable<WebhookPayload["actor"]>,
  value: unknown,
  selection: unknown = DEFAULT_WEBHOOK_EVENTS
) {
  const url = webhookUrl(value, env)
  if (!Array.isArray(selection) || selection.some((e) => !webhookEvents.includes(e)))
    bad("Unknown webhook event or invalid events list")
  const events = [...new Set<WebhookEventType>(selection)]
  const write = sql(env, "UPDATE webhook_settings SET url=?,events=? WHERE app_id=?", url, JSON.stringify(events), app),
    audit = hookEntry(
      env,
      app,
      actor,
      "webhook.updated",
      { type: "webhook" },
      { enabled: url !== null, events },
      url === null
    )
  await env.DB.batch(url === null ? [audit, write] : [write, audit])
  return { url, events }
}
export async function rotateWebhook(env: Env, app: string, actor: NonNullable<WebhookPayload["actor"]>) {
  const key = secret()
  await env.DB.batch([
    sql(env, "UPDATE webhook_settings SET secret=? WHERE app_id=?", key, app),
    hookEntry(env, app, actor, "webhook.rotated", { type: "webhook" })
  ])
  return { secret: key }
}
export async function testWebhook(
  env: Env,
  origin: string,
  app: WebhookPayload["app"],
  actor: NonNullable<WebhookPayload["actor"]>
) {
  const [id] = await enqueueWebhooks(env, origin, app, actor, null, [{ type: "ping" }])
  if (!id) bad("Set a webhook URL first")
  return { delivery_id: id }
}

interface Job {
  id: string
  destinationHash: string
}

export type Hook = Pick<
  WebhookPayload,
  "type" | "changes" | "mentioned" | "comment" | "label" | "moved_to" | "verification" | "approval" | "escalation"
> & {
  transition?: Partial<Pick<IssueSummary, "assignee" | "status" | "close_reason">>
}
// Ping is an explicit admin test, not an automatic subscription.
const subscribed = (event: string) => `(${event}='ping' OR ${event} IN (SELECT value FROM json_each(s.events)))`
export async function enqueueWebhooks(
  env: Env,
  origin: string,
  app: WebhookPayload["app"],
  actor: NonNullable<WebhookPayload["actor"]>,
  issue: IssueSummary | null,
  events: Hook[],
  form?: TypeInfo
) {
  if (!events.length) return []
  const readForm = issue && !form && events.some((h) => h.type === "issue.opened" || h.type === "issue.assigned")
  const settings = await sql(
    env,
    `SELECT url,events,${readForm ? `(SELECT ${requestJson(true)} FROM issues i WHERE i.id=? AND i.app_id=s.app_id)` : "NULL"} request_info,(SELECT json_object('id',t.id,'name',t.name,'email',t.email,'unverified_email',t.unverified_email,'external_id',t.external_id,'verified_via',t.verified_via,'created_at',t.created_at,'last_seen_at',t.last_seen_at) FROM contacts t JOIN apps a ON a.id=t.app_id WHERE a.mode='helpdesk' AND t.app_id=s.app_id AND t.id=?) contact,(SELECT count(*) FROM comments c JOIN issues i ON i.id=c.issue_id WHERE i.id=? AND i.app_id=s.app_id) comment_count FROM webhook_settings s WHERE app_id=? AND url IS NOT NULL`,
    ...(readForm ? [issue!.id] : []),
    issue?.author.id ?? null,
    issue?.id ?? null,
    app.id
  ).first<{ url: string; events: string; comment_count: number; contact: string | null; request_info: string | null }>()
  if (!settings) return []
  const enabled = new Set<string>(JSON.parse(settings.events)),
    selected = events.filter((e) => e.type === "ping" || enabled.has(e.type))
  if (!selected.length) return []
  const teamForm = form ?? (settings.request_info ? typeInfo(settings.request_info) : undefined)
  const parents = selected.flatMap((h): (string | null)[] =>
    h.type === "issue.opened" ? [null] : h.type === "comment.created" && h.comment ? [h.comment.id] : []
  )
  const metadata =
    issue && parents.length
      ? (
          await reportQuery(env, app.id, { team: true, actorId: null }, "issue", issue.number, parents).all<ReportRow>()
        ).results.map(decodeReport)
      : []
  // Source tombstones retain the pre-move/delete count; never count comments in a different app.
  const sourceSnapshot = selected.some((e) => e.type === "issue.moved" || e.type === "issue.deleted")
  const { base, hooks } = await teamProjection(env, app.id, {
    base: {
      actor,
      ...(settings.contact && { contact: JSON.parse(settings.contact) }),
      ...(issue
        ? {
            issue: {
              ...issue,
              ...teamForm,
              url: appUrl(env, origin, app.slug, `/issues/${issue.number}`),
              comment_count: sourceSnapshot ? issue.comment_count : settings.comment_count,
              viewer_voted: false
            }
          }
        : {}),
      app: { id: app.id, slug: app.slug, name: app.name },
      mcp_url: new URL("/mcp", origin).href
    },
    hooks: selected
  })
  const ids: string[] = [],
    destinationHash = await sha256(settings.url)
  // One triage action can replace dozens of labels. Keep both round trips and peak
  // payload memory bounded; queue messages only carry IDs and a destination fingerprint.
  for (let offset = 0; offset < hooks.length; offset += 16) {
    const pending = hooks.slice(offset, offset + 16).map(({ transition, ...hook }) => {
      const attached = metadata.filter((m) =>
        hook.type === "issue.opened"
          ? m.attached_to!.comment_id === null
          : hook.type === "comment.created" && m.attached_to!.comment_id === hook.comment?.id
      )
      const id = hook.verification ? "vr-" + hook.verification.id : uid(),
        created_at = now(),
        payload: WebhookPayload & { metadata?: typeof metadata } = {
          ...base,
          ...hook,
          ...(attached.length && { metadata: attached }),
          ...(transition && base.issue && { issue: { ...base.issue, ...transition } }),
          id,
          created_at
        }
      // Recheck policy and scope at insertion. Only confirmed deletions and source-side moves
      // may describe a row that no longer exists in the workspace.
      const gate =
        hook.type === "issue.deleted"
          ? "EXISTS(SELECT 1 FROM issue_tombstones WHERE app_id=?2 AND number=?8)"
          : hook.type === "issue.moved"
            ? "EXISTS(SELECT 1 FROM issue_moves WHERE from_app=?2 AND from_number=?8 AND issue_id=?7)"
            : "(?7 IS NULL OR EXISTS(SELECT 1 FROM issues WHERE app_id=?2 AND id=?7))"
      const statement = sql(
        env,
        `INSERT ${hook.verification ? "OR IGNORE " : ""}INTO webhook_deliveries(id,app_id,event,payload,created_at) SELECT ?1,s.app_id,?3,?4,?5 FROM webhook_settings s
      WHERE s.app_id=?2 AND s.url=?6 AND ${subscribed("?3")} AND ${gate}
      AND (?9 IS NULL OR ${hook.type === "comment.deleted" ? "NOT " : ""}EXISTS(SELECT 1 FROM ${hook.type === "reply.held" ? "held_replies" : "comments"} WHERE id=?9 AND issue_id=?7))`,
        id,
        app.id,
        hook.type,
        JSON.stringify(payload),
        created_at,
        settings.url,
        issue?.id ?? null,
        issue?.number ?? null,
        hook.comment?.id ?? null
      )
      return { id, statement }
    })
    const result = await env.DB.batch([
      ...pending.map((p) => p.statement),
      ...(events.length === 1 && events[0]!.verification
        ? [
            sql(
              env,
              "UPDATE verification_outbox SET destination_hash=? WHERE id=? AND changes()>0",
              destinationHash,
              events[0]!.verification.id
            )
          ]
        : []),
      ...(events.length === 1 && events[0]!.type === "ping"
        ? [hookEntry(env, app.id, actor, "webhook.tested", { type: "delivery", id: pending[0]!.id })]
        : [])
    ])
    const added = pending.flatMap((p, i) => (result[i]!.meta.changes ? [p.id] : []))
    // Verification completion has a transactional outbox. Its dispatcher sends
    // the persisted ID/hash pair and only then removes the recovery record.
    if (!events[0]?.verification) await sendJobs(env, added, destinationHash)
    ids.push(...added)
  }
  return ids
}

export async function redeliver(env: Env, app: string, actor: NonNullable<WebhookPayload["actor"]>, original: string) {
  const id = uid()
  // Copy inside the transaction: a concurrently purged snapshot cannot be resurrected.
  // Keep the original event timestamp and content; only delivery identity changes.
  const [old, copy] = await env.DB.batch<{ url: string | null }>([
    sql(
      env,
      "SELECT s.url FROM webhook_deliveries d JOIN webhook_settings s ON s.app_id=d.app_id WHERE d.app_id=? AND d.id=?",
      app,
      original
    ),
    sql(
      env,
      `INSERT INTO webhook_deliveries(id,app_id,event,payload,created_at) SELECT ?1,d.app_id,d.event,json_set(d.payload,'$.id',?1,'$.redelivery_of',d.id),?2
      FROM webhook_deliveries d JOIN webhook_settings s ON s.app_id=d.app_id WHERE d.app_id=?3 AND d.id=?4 AND s.url IS NOT NULL AND ${subscribed("d.event")}`,
      id,
      now(),
      app,
      original
    ),
    hookEntry(env, app, actor, "webhook.redelivered", { type: "delivery", id: original }, { delivery_id: id })
  ])
  const row = old!.results[0] ?? missing()
  if (!row.url || !copy!.meta.changes) bad("Configure a webhook subscribed to this event first")
  await sendJobs(env, [id], await sha256(row.url))
  return { delivery_id: id }
}
async function sendJobs(env: Env, ids: string[], destinationHash: string) {
  if (!ids.length) return
  try {
    // Keep large payloads and credentials out of the queue. Don't replay old events to a new URL.
    await env.WEBHOOKS.sendBatch(ids.map((id) => ({ body: { id, destinationHash } satisfies Job })))
  } catch (error) {
    await sql(
      env,
      "UPDATE webhook_deliveries SET status='failed' WHERE id IN(SELECT value FROM json_each(?)) AND status='pending'",
      JSON.stringify(ids)
    ).run()
    throw error
  }
}

async function deliver(env: Env, message: Message<Job>) {
  const { id, destinationHash } = message.body
  const delivery = await sql(
    env,
    `SELECT d.payload,d.event,CASE WHEN ${subscribed("d.event")} THEN s.url END url,s.secret FROM webhook_deliveries d
    JOIN webhook_settings s ON s.app_id=d.app_id WHERE d.id=? AND d.status='pending'`,
    id
  ).first<{ payload: string; event: string; url: string | null; secret: string }>()
  if (!delivery) return message.ack()
  const { payload, event, url, secret } = delivery
  // Revalidate the persisted destination as well as its fingerprint: it may predate this policy.
  let destination: string | null = null
  if (url && (await sha256(url)) === destinationHash) {
    try {
      destination = webhookUrl(url, env)
    } catch {
      /* A forbidden legacy URL is terminal. */
    }
  }
  if (!destination) {
    await sql(env, "UPDATE webhook_deliveries SET status='failed' WHERE id=? AND status='pending'", id).run()
    return message.ack()
  }

  const t = Math.floor(Date.now() / 1000),
    enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign"
  ])
  const signature = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${payload}`)))
  let status: number | null = null
  try {
    const res = await fetch(destination, {
      method: "POST",
      body: payload,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "Content-Type": "application/json",
        "Bellhop-Event": event,
        "Bellhop-Delivery": id,
        "Bellhop-Signature": `t=${t},v1=${signature}`
      }
    })
    status = res.status
    await res.body?.cancel()
  } catch {
    /* Network errors and timeouts have no HTTP status. */
  }

  // wrangler.jsonc: one initial attempt + max_retries: 6.
  const state =
    status !== null && status >= 200 && status < 300
      ? "delivered"
      : (status !== null && status >= 300 && status < 400) || message.attempts >= 7
        ? "failed"
        : "pending"
  await sql(
    env,
    `UPDATE webhook_deliveries SET status=?,attempts=max(attempts,?),response_status=?
    WHERE id=? AND status='pending'`,
    state,
    message.attempts,
    status,
    id
  ).run()
  if (state === "pending") message.retry({ delaySeconds: 2 ** (message.attempts - 1) })
  else message.ack()
}

export async function queue(batch: MessageBatch<Job | Parameters<typeof importMessage>[1]["body"]>, env: Env) {
  await Promise.all(
    batch.messages.map((m) =>
      "kind" in m.body && m.body.kind === "github.import"
        ? importMessage(env, m as Parameters<typeof importMessage>[1])
        : deliver(env, m as Message<Job>)
    )
  )
}
