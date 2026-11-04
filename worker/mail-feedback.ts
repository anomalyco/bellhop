import { sql } from "./core"
import { devMail, provider, secrets } from "./mail-provider"

type Problem = { id: string; status: "bounced" | "complained" }
export async function handleDeliveryProblem(env: Env, email: Problem | Problem[]) {
  // A signed event can arrive before the send acknowledgement. Match only IDs assigned
  // to Bellhop's own single-recipient sends; never take an address from an event body.
  const problems = Array.isArray(email) ? email : [email]
  if (problems.length)
    await sql(
      env,
      `INSERT OR IGNORE INTO mail_feedback(email_id,reason)
    SELECT json_extract(value,'$.id'),'email.'||json_extract(value,'$.status') FROM json_each(?)`,
      JSON.stringify(problems.map(({ id, status }) => ({ id, status })))
    ).run()
}
export async function pollFeedback(env: Env) {
  if (devMail(env) || !secrets(env).OPENSEND_API_KEY) return
  for (const status of ["bounced", "complained"] as const) {
    const prev = await sql(env, "SELECT cursor FROM mail_feedback_cursor WHERE status=?", status).first<string>(
      "cursor"
    )
    const page = async (cursor: string | null) => {
      const q = new URLSearchParams({
        status,
        from: "notifications@mail.blhp.app",
        kind: "transactional",
        limit: "100"
      })
      if (cursor) q.set("cursor", cursor)
      const result = await provider<{
        data: (Problem & { from: string; environment: string })[]
        nextCursor: string | null
      }>(env, "/v1/emails?" + q)
      await handleDeliveryProblem(
        env,
        result.data.filter(
          (e) => e.status === status && e.from === "notifications@mail.blhp.app" && e.environment === "live"
        )
      )
      return result.nextCursor
    }
    // Status filters are paginated by SEND time, not the time of the bounce. Revisit the
    // head every minute and sweep older pages too so a late complaint is not skipped.
    const head = await page(null),
      next = prev && head ? await page(prev) : head
    await sql(env, "UPDATE mail_feedback_cursor SET cursor=? WHERE status=? AND cursor IS ?", next, status, prev).run()
  }
  await sql(env, "DELETE FROM mail_hook_seen WHERE at<unixepoch()-2592000").run()
}
