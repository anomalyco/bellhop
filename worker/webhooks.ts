import type { WebhookPayload } from "../shared/api"
import { bad, hex, now, secret, sha256, sql, str, uid } from "./core"
import { teamProjection } from "./tier-actors"

export function webhookUrl(value: unknown, env: Env) {
  if (value === null) return null
  const url = URL.parse(str(value, "url", 4096))
  if (!url || url.username || url.password) bad("Invalid webhook URL")
  const local = env.DEV_LOGIN === "1" && ["localhost", "127.0.0.1"].includes(url.hostname)
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) bad("Webhook URL must use HTTPS")
  return url.href
}

export async function configureWebhook(env: Env, app: string, value: unknown) {
  const url = webhookUrl(value, env)
  await sql(env, "UPDATE webhook_settings SET url=? WHERE app_id=?", url, app).run()
  return { url }
}
export async function rotateWebhook(env: Env, app: string) {
  const key = secret()
  await sql(env, "UPDATE webhook_settings SET secret=? WHERE app_id=?", key, app).run()
  return { secret: key }
}
export async function testWebhook(
  env: Env,
  origin: string,
  app: WebhookPayload["app"],
  actor: NonNullable<WebhookPayload["actor"]>
) {
  const id = await enqueueWebhook(env, origin, { type: "ping", app, actor })
  if (!id) bad("Set a webhook URL first")
  return { delivery_id: id }
}

interface Job {
  id: string
  destinationHash: string
}

export async function enqueueWebhook(
  env: Env,
  origin: string,
  { app, ...event }: Omit<WebhookPayload, "id" | "created_at" | "mcp_url">
) {
  const settings = await sql(
    env,
    `SELECT url,(SELECT count(*) FROM comments WHERE issue_id=?) comment_count FROM webhook_settings WHERE app_id=?`,
    event.issue?.id ?? null,
    app.id
  ).first<{ url: string | null; comment_count: number }>()
  if (!settings?.url) return null
  const url = settings.url
  const id = uid(),
    created_at = now()
  const payload: WebhookPayload = {
    ...event,
    ...(event.issue ? { issue: { ...event.issue, comment_count: settings.comment_count, viewer_voted: false } } : {}),
    id,
    created_at,
    app: { id: app.id, slug: app.slug, name: app.name },
    mcp_url: new URL("/mcp", origin).href
  }
  const inserted = await sql(
    env,
    `INSERT INTO webhook_deliveries(id,app_id,event,payload,created_at) SELECT ?,?,?,?,?
     WHERE (? IS NULL OR EXISTS(SELECT 1 FROM issues WHERE id=? AND app_id=?))
       AND (? IS NULL OR EXISTS(SELECT 1 FROM comments WHERE id=? AND issue_id=?))`,
    id,
    app.id,
    payload.type,
    JSON.stringify(await teamProjection(env, app.id, payload)),
    created_at,
    payload.issue?.id ?? null,
    payload.issue?.id ?? null,
    app.id,
    payload.comment?.id ?? null,
    payload.comment?.id ?? null,
    payload.issue?.id ?? null
  ).run()
  if (!inserted.meta.changes) return null // A deletion won the race with enqueueing this snapshot.
  try {
    // Keep large payloads and credentials out of the queue. Don't replay old events to a new URL.
    await env.WEBHOOKS.send({ id, destinationHash: await sha256(url) } satisfies Job)
  } catch (error) {
    await sql(env, "UPDATE webhook_deliveries SET status='failed' WHERE id=? AND status='pending'", id).run()
    throw error
  }
  return id
}

async function deliver(env: Env, message: Message<Job>) {
  const { id, destinationHash } = message.body
  const delivery = await sql(
    env,
    `SELECT d.payload,d.event,s.url,s.secret FROM webhook_deliveries d
    JOIN webhook_settings s ON s.app_id=d.app_id WHERE d.id=? AND d.status='pending'`,
    id
  ).first<{ payload: string; event: string; url: string | null; secret: string }>()
  if (!delivery) return message.ack()
  const { payload, event, url, secret } = delivery
  if (!url || (await sha256(url)) !== destinationHash) {
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
    const res = await fetch(webhookUrl(url, env)!, {
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
    status !== null && status >= 200 && status < 300 ? "delivered" : message.attempts >= 7 ? "failed" : "pending"
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

export async function queue(batch: MessageBatch<Job>, env: Env) {
  await Promise.all(batch.messages.map((message) => deliver(env, message)))
}
