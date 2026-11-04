import { appUrl, rows, sql } from "./core"
import type { Locale, IssueStatus } from "../shared/api"
import { mailCopy, formatMail } from "./mail-copy"
import { esc, mailOrigin, mailToken, sendMail, unsubscribeURL, ProviderError, type TokenRow } from "./mail-provider"

export async function enqueueDue(env: Env) {
  const at = Math.floor(Date.now() / 1000)
  await sql(
    env,
    `INSERT OR IGNORE INTO mail_batches(id,sub_id,issue_id,address,due,sealed)
    SELECT 'nudge-'||n.period,n.sub,n.issue_id,n.address,unixepoch(),1 FROM due_nudges n
    WHERE NOT EXISTS(SELECT 1 FROM mail_batches b WHERE b.id='nudge-'||n.period) LIMIT 100`
  ).run()
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
type Recipient = TokenRow & {
  mode: string
  locale: Locale
  address: string
  name: string
  slug: string
  number: number
  title: string
  issue_id: string
  app_id: string
}
type Item = { kind: string; description: string | null; author: string | null; internal: number }
export async function deliverBatch(env: Env, id: string) {
  const [claim, recipient, items] = await env.DB.batch([
    sql(
      env,
      "UPDATE mail_batches SET sealed=1,lease=unixepoch()+120 WHERE id=? AND due<=unixepoch() AND lease<=unixepoch()",
      id
    ),
    sql(
      env,
      `SELECT p.id,p.nonce,p.address,p.number,p.title,p.issue_id,p.app_id,a.mode,a.name,a.slug,coalesce(u.locale,p.locale,'en') locale FROM mail_batches b JOIN mail_people p ON p.id=b.sub_id JOIN apps a ON a.id=p.app_id LEFT JOIN users u ON u.id=p.user_id WHERE b.id=? AND b.sealed=1 AND p.state='on' AND (a.mode='tracker' OR p.user_id IS NULL OR p.role IS NOT NULL)`,
      id
    ),
    sql(
      env,
      `SELECT n.kind,coalesce(json_extract(c.author,'$.name'),json_extract(c.author,'$.handle')) author,coalesce(c.internal,0) internal,
      CASE WHEN n.kind='status' THEN json_extract(e.data,'$.to') ELSE substr(c.body,1,4096) END description
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
  const nudge = id.startsWith("nudge-") ? id.slice(6) : null
  if (
    nudge &&
    p &&
    (await sql(env, "SELECT 1 FROM due_nudges WHERE period=? AND sub=? AND address=?", nudge, p.id, p.address).first())
  )
    data.push({
      kind: "nudge",
      author: null,
      internal: 0,
      description: null
    })
  if (p && data.length) {
    const copy = mailCopy[p.locale],
      note = data.some((n) => n.internal),
      [reply, unsub] = await Promise.all([mailToken(env, note ? "note" : "reply", p), mailToken(env, "unsubscribe", p)])
    const url = appUrl(env, mailOrigin(env), p.slug, `/issues/${p.number}`),
      off = unsubscribeURL(env, unsub),
      all = off + "&all=1"
    const cap = Math.max(32, Math.min(4096, Math.floor(55000 / data.length))),
      lines = data.map((n) => {
        if (n.kind === "nudge") return copy.nudge
        if (n.kind === "status") return formatMail(copy.status, { status: copy.statuses[n.description as IssueStatus] ?? n.description ?? "" })
        if (n.kind === "assigned") return copy.assigned
        if (n.kind === "mention" && n.description === null) return copy.mentioned
        const label = n.kind === "mention" ? copy.mention : copy.reply,
          heading = n.author ? formatMail(copy.by, { label, author: n.author }) : label
        return (
          `${heading}${n.internal ? ` (${copy.note})` : ""}: ` +
          (n.description?.slice(0, cap) || copy.attachment) +
          ((n.description?.length ?? 0) >= cap ? "…" : "")
        )
      }),
      instruction = note ? copy.noteAnswer : copy.answer
    const clean = (s: string) => s.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").trim()
    await sendMail(env, "bellhop-" + id, {
      to: p.address,
      fromName: p.mode === "helpdesk" ? clean(p.name) : formatMail(copy.sender, { app: clean(p.name) }),
      subject: formatMail(copy.subject, { title: clean(p.title), number: p.number, app: clean(p.name) }),
      replyTo: [`reply+${reply}@mail.blhp.app`],
      html: `<h1>${esc(p.title)}</h1>${lines.map((line) => `<p>${esc(line).replace(/\n/g, "<br>")}</p>`).join("")}<p><a href="${esc(url)}">${esc(formatMail(copy.view, { number: p.number }))}</a></p><p>${esc(instruction)}</p><p><a href="${esc(off)}">${esc(copy.unsubscribe)}</a>${p.mode === "helpdesk" ? "" : ` · <a href="${esc(all)}">${esc(copy.stop)}</a>`}</p>`,
      text: `${lines.join("\n\n")}\n\n${url}\n${instruction}\n\n${copy.unsubscribe}: ${off}${p.mode === "helpdesk" ? "" : `\n${copy.stop}: ${all}`}`
    })
    if (nudge)
      await sql(
        env,
        // Unsubscribing while the provider acknowledges a send can delete the batch.
        // Still remember the successful send if the issue is in the same workspace.
        `INSERT OR IGNORE INTO nudge_events SELECT ?,id,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM issues WHERE id=? AND app_id=?`,
        nudge,
        p.issue_id,
        p.app_id
      ).run()
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
