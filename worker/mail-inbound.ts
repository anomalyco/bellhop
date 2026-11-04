import type { Actor, App, Locale, Role } from "../shared/api"
import { ApiFailure, dbError, memberActor, sha256, sql } from "./core"
import { addComment, type Access } from "./mutations"
import { checkToken, devMail, mailOrigin, provider, ProviderError, secrets, type TokenRow } from "./mail-provider"

const mailbox = "mbx_c8c083e4706d4df2be5596548f7a4295"
type Address = { address: string }
export type Incoming = {
  id: string
  mailboxId: string
  direction: string
  from: Address
  to: Address[]
  subject: string
  text: string
  replyText: string
  headers: { name: string; value: string }[]
  spam: boolean
  automated: boolean
  verdicts: { dmarc?: string; virus?: string; spam?: string }
}
type Person = TokenRow & {
  locale: Locale | null
  actor_id: string
  address: string
  user_id: string | null
  name: string | null
  avatar_url: string | null
  role: Role | null
  guest_hash: string | null
  owner_alias: string | null
  number: number
  app_id: string
  slug: string
  app_name: string
  public: number
}
export async function handleInboundMessage(env: Env, ctx: Access["ctx"], m: Incoming) {
  if (
    m.mailboxId !== mailbox ||
    m.direction !== "inbound" ||
    m.spam ||
    m.automated ||
    m.verdicts?.dmarc !== "PASS" ||
    m.verdicts.virus === "FAIL" ||
    m.verdicts.spam === "FAIL"
  )
    return "ignored"
  const header = (name: string) =>
    m.headers.filter((h) => h.name.toLowerCase() === name).map((h) => h.value.trim().toLowerCase())
  if (
    header("auto-submitted").some((v) => v !== "no") ||
    header("return-path").includes("<>") ||
    header("content-type").some((v) => v.includes("multipart/report")) ||
    header("x-autoreply").length ||
    header("x-autorespond").length ||
    header("precedence").some((v) => ["list", "bulk", "junk"].includes(v)) ||
    /^(?:\s*(?:re|fw):)*\s*(?:out of (?:the )?office|automatic reply|auto[- ]?reply|undeliverable|delivery status notification)\b/i.test(
      m.subject
    )
  )
    return "ignored"
  const from = m.from.address.trim().toLowerCase()
  if (/^(?:mailer-daemon|postmaster|no-?reply|bounces?)(?:[+.-]|@)/i.test(from)) return "ignored"
  const targets = [
    ...new Set(
      m.to
        .map((t) => t.address.trim().toLowerCase())
        .filter((s) => /^reply\+[a-f0-9]{24}\.[a-f0-9]{32}@mail\.blhp\.app$/.test(s))
    )
  ]
  if (targets.length !== 1) return "ignored"
  const token = targets[0]!.slice(6).split("@")[0]!,
    p = await sql(
      env,
      `SELECT p.*,a.name app_name,a.slug,a.public,coalesce(u.name,g.name) name,u.avatar_url FROM mail_people p JOIN apps a ON a.id=p.app_id LEFT JOIN users u ON u.id=p.user_id LEFT JOIN guest_names g ON g.guest_hash=p.guest_hash WHERE p.id=? AND p.address=? AND p.state='on'`,
      token.slice(0, 24),
      from
    ).first<Person>()
  if (!p) return "ignored"
  const note = await checkToken(env, "note", p, token)
  if (note ? !p.role : !(await checkToken(env, "reply", p, token))) return "ignored"
  if (await sql(env, "SELECT 1 FROM mail_inbound WHERE id=?", m.id).first()) return "duplicate"
  const body = (
    m.replyText?.trim() ||
    m.text.split(
      /^(?:\s*>|On .{1,500} wrote:\s*$|On [^\n]{0,300}\n[^\n]{0,300}wrote:\s*$|[- ]{2,}(?:Original Message|Forwarded message)[- ]*|_{10,}\s*$|From:\s+\S.*$)/im
    )[0] ||
    ""
  )
    .trim()
    .replace(/\b(?:reply\+)?[0-9a-f]{24}\.[0-9a-f]{32}(?:@mail\.blhp\.app)?\b/gi, "[private email token]")
  if (!body || body.length > 65536) return "ignored"
  const sender = await sha256(from)
  if (
    !(await env[p.role ? "RL_AGENT" : "RL_IP"].limit({ key: `email:${sender}` })).success ||
    !(await env[p.role ? "RL_TEAM" : "RL_WRITE"].limit({ key: `email:${p.app_id}:${sender}` })).success
  )
    return "limited"
  const actor: Actor = p.user_id
    ? memberActor({ id: p.user_id, name: p.name!, avatar_url: p.avatar_url }, p.role)
    : { type: "guest", id: p.actor_id, handle: "guest-" + p.actor_id.slice(0, 4), name: p.name || "Guest" }
  const app: Pick<App, "id" | "name" | "slug" | "public"> = {
    id: p.app_id,
    name: p.app_name,
    slug: p.slug,
    public: !!p.public
  }
  try {
    await addComment(
      {
        env,
        ctx,
        origin: mailOrigin(env),
        app,
        actor,
        role: p.role,
        locale: p.locale ?? "en",
        guestHash: p.guest_hash ?? undefined,
        aliases: p.owner_alias ? [p.owner_alias] : []
      },
      p.number,
      { body, internal: note },
      undefined,
      { message: m.id, sub: p.id, nonce: p.nonce, address: from }
    )
    return "posted"
  } catch (e) {
    if (await sql(env, "SELECT 1 FROM mail_inbound WHERE id=?", m.id).first()) return "duplicate"
    const err = e instanceof ApiFailure ? e : e instanceof Error ? dbError(e) : null
    if ((err && [400, 403, 404, 410, 429].includes(err.status)) || String(e).includes("mail_inbound.sub_id"))
      return "ignored"
    throw e
  }
}
export type InboundEvent = {
  cursor: string
  type: string
  addressId: string
  messageId: string
  data: { automated?: boolean; spam?: boolean }
}
export async function receiveEvent(env: Env, ctx: Access["ctx"], e: InboundEvent) {
  if (e.type !== "message.received" || e.addressId !== mailbox || !e.messageId || e.data?.automated || e.data?.spam)
    return
  if (await sql(env, "SELECT 1 FROM mail_inbound WHERE id=?", e.messageId).first()) return
  const id = encodeURIComponent(e.messageId)
  try {
    const msg = await provider<
      Pick<Incoming, "id" | "from" | "to" | "subject" | "direction" | "text" | "replyText"> & { addressIds: string[] }
    >(env, `/v1/inbound/messages/${id}?addressId=${mailbox}`)
    if (msg.id !== e.messageId || !msg.addressIds.includes(mailbox)) return
    // The public inbound message projection has no Auto-Submitted header or trusted SES
    // verdicts. Read those from the scoped mailbox view, never from sender-authored text.
    const safety = await provider<Pick<Incoming, "id" | "mailboxId" | "spam" | "automated" | "headers" | "verdicts">>(
      env,
      `/mailbox/v1/mailboxes/${mailbox}/messages/${id}`
    )
    if (safety.id !== msg.id || safety.mailboxId !== mailbox) return
    const outcome = await handleInboundMessage(env, ctx, {
      ...msg,
      mailboxId: mailbox,
      spam: safety.spam,
      automated: safety.automated,
      headers: safety.headers,
      verdicts: safety.verdicts
    })
    if (outcome === "ignored" || outcome === "limited")
      await sql(env, "INSERT OR IGNORE INTO mail_inbound VALUES(?,'')", msg.id).run()
  } catch (e) {
    if (!(e instanceof ProviderError && e.status === 404)) throw e
  }
}
export async function pollInbound(env: Env, ctx: Access["ctx"]) {
  // OpenSend inbound is live-only. Never read the real mailbox from a dev Worker.
  if (devMail(env) || !secrets(env).OPENSEND_INBOUND_KEY) return
  let cursor = (await sql(env, "SELECT cursor FROM mail_cursor WHERE id=1").first<string>("cursor")) ?? "0"
  const page = await provider<{ cursor: string; data: InboundEvent[] }>(
    env,
    `/v1/inbound/events?addressId=${mailbox}&types=message.received&after=${cursor}&limit=25`
  )
  for (const e of page.data) {
    await receiveEvent(env, ctx, e)
    if (
      !(await sql(env, "UPDATE mail_cursor SET cursor=? WHERE id=1 AND cursor=?", e.cursor, cursor).run()).meta.changes
    )
      return
    cursor = e.cursor
  }
}
