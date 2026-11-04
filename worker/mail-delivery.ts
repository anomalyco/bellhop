import { appUrl, rows, sql } from "./core"
import { esc, mailOrigin, mailToken, sendMail, unsubscribeURL, ProviderError, type TokenRow } from "./mail-provider"

export async function enqueueDue(env: Env) {
  const at = Math.floor(Date.now() / 1000)
  const jobs = await rows<{ id: string; due: number }>(
    sql(
      env,
      `UPDATE mail_batches SET wake=? WHERE id IN(SELECT id FROM mail_batches WHERE wake<=? ORDER BY due LIMIT 100) RETURNING id,due`,
      at + 600,
      at
    )
  )
  if (jobs.length)
    await env.MAIL.sendBatch(jobs.map((j) => ({ body: { id: j.id }, delaySeconds: Math.max(0, j.due - at) })))
}
type Recipient = TokenRow & { address: string; name: string; slug: string; number: number; title: string }
type Item = { kind: string; description: string; author: string | null; internal: number }
export async function deliverBatch(env: Env, id: string) {
  const [claim, recipient, items] = await env.DB.batch([
    sql(
      env,
      "UPDATE mail_batches SET sealed=1,lease=unixepoch()+120 WHERE id=? AND due<=unixepoch() AND lease<=unixepoch()",
      id
    ),
    sql(
      env,
      `SELECT p.id,p.nonce,p.address,p.number,p.title,a.name,a.slug FROM mail_batches b JOIN mail_people p ON p.id=b.sub_id JOIN apps a ON a.id=p.app_id WHERE b.id=? AND b.sealed=1 AND p.state='on'`,
      id
    ),
    sql(
      env,
      `SELECT n.kind,coalesce(json_extract(c.author,'$.name'),json_extract(c.author,'$.handle')) author,coalesce(c.internal,0) internal,
      CASE WHEN n.kind='status' THEN 'Status: '||json_extract(e.data,'$.to') WHEN n.kind='assigned' THEN 'Assigned to you' WHEN n.kind='mention' AND c.id IS NULL THEN 'You were mentioned in the issue' ELSE substr(c.body,1,4096) END description
      FROM mail_items n JOIN mail_batches b ON b.id=n.batch_id AND b.sealed=1 JOIN mail_people p ON p.id=b.sub_id AND p.state='on' JOIN issues i ON i.id=p.issue_id
      LEFT JOIN comments c ON c.id=n.ref AND c.issue_id=i.id LEFT JOIN issue_events e ON n.kind='status' AND e.id=n.ref AND e.issue_id=i.id
      WHERE b.id=? AND n.actor!=p.actor_id AND (c.id IS NULL OR json_extract(c.author,'$.id')!=p.actor_id) AND ((p.role IS NULL AND NOT EXISTS(SELECT 1 FROM members m WHERE m.app_id=p.app_id AND m.email=p.address AND m.user_id IS NOT NULL)
         AND (p.reason='manual' OR (p.reason='opened' AND p.opened) OR (p.reason='replied' AND p.replied)) AND ((n.kind='reply' AND c.id IS NOT NULL AND c.hidden IS NULL AND c.internal=0) OR (n.kind='status' AND e.type='status_changed')))
       OR (p.role IS NOT NULL AND ((n.kind='assigned' AND p.assigned AND json_extract(i.assignee,'$.id')=p.actor_id) OR (n.kind='mention' AND p.mentions AND c.hidden IS NULL AND (c.id IS NOT NULL OR n.ref=i.id)
       AND EXISTS(SELECT 1 FROM json_each(CASE WHEN n.ref=i.id THEN i.mentions ELSE c.mentions END) WHERE json_extract(value,'$.actor.id')=p.actor_id))))) ORDER BY n.id`,
      id
    )
  ])
  if (!claim!.meta.changes) return
  const p = recipient!.results[0] as Recipient | undefined,
    data = items!.results as Item[]
  if (p && data.length) {
    const note = data.some((n) => n.internal),
      [reply, unsub] = await Promise.all([mailToken(env, note ? "note" : "reply", p), mailToken(env, "unsubscribe", p)])
    const url = appUrl(env, mailOrigin(env), p.slug, `/issues/${p.number}`),
      off = unsubscribeURL(env, unsub),
      all = off + "&all=1"
    const cap = Math.max(32, Math.min(4096, Math.floor(55000 / data.length))),
      lines = data.map((n) => {
        const label = n.kind === "mention" ? "Mention" : n.kind === "reply" ? "Reply" : ""
        return (
          (label ? `${label}${n.author ? " from " + n.author : ""}${n.internal ? " (internal note)" : ""}: ` : "") +
          (n.description?.slice(0, cap) || "(attachment)") +
          ((n.description?.length ?? 0) >= cap ? "…" : "")
        )
      }),
      instruction = note ? "Reply to this email to leave an internal note." : "Reply to this email to answer."
    const clean = (s: string) => s.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim()
    await sendMail(env, "bellhop-" + id, {
      to: p.address,
      fromName: `${clean(p.name)} via Bellhop`,
      subject: `Re: ${clean(p.title)} (#${p.number} · ${clean(p.name)})`,
      replyTo: [`reply+${reply}@mail.blhp.app`],
      html: `<h1>${esc(p.title)}</h1>${lines.map((line) => `<p>${esc(line).replace(/\n/g, "<br>")}</p>`).join("")}<p><a href="${esc(url)}">View issue #${p.number}</a></p><p>${instruction}</p><p><a href="${esc(off)}">Unsubscribe from this issue</a> · <a href="${esc(all)}">Stop all Bellhop email</a></p>`,
      text: `${lines.join("\n\n")}\n\n${url}\n${instruction}\n\nUnsubscribe from this issue: ${off}\nStop all Bellhop email: ${all}`
    })
  }
  await sql(env, "DELETE FROM mail_batches WHERE id=? AND sealed=1", id).run()
}
export async function mailQueue(batch: MessageBatch<{ id: string }>, env: Env) {
  for (const m of batch.messages) {
    try {
      await deliverBatch(env, m.body.id)
      m.ack()
    } catch (e) {
      console.error("bellhop.mail_delivery_failed", {
        batch: m.body.id,
        status: e instanceof ProviderError ? e.status : null
      })
      if (e instanceof ProviderError && [400, 409, 413, 422].includes(e.status)) {
        // Invalid/screened content or an ambiguous idempotency conflict: never try a different key.
        await sql(
          env,
          "UPDATE mail_batches SET wake=9223372036854775807,lease=9223372036854775807 WHERE id=?",
          m.body.id
        ).run()
        m.ack()
      } else {
        await sql(env, "UPDATE mail_batches SET lease=0 WHERE id=?", m.body.id).run()
        m.retry({ delaySeconds: Math.min(600, 2 ** m.attempts) })
      }
    }
  }
}
