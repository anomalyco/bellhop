import type { Actor, Verification } from "../../shared/api"
import type { Conversation, ConversationItem, Message, Page, Participant, Upload } from "../../shared/v1"
import { bad, fail, ids, input, missing, sql, str, type Ctx } from "../core"
import { addComment, createIssue, type Access } from "../mutations"
import { issueRoom } from "../events"
import { redeemCode } from "../email-codes"
import { dispatchProof } from "../helpdesk"
import { proofCols, verification, type ProofRow } from "../helpdesk-data"
import { clientIP, enforce } from "../rate-limits"
import { liveGuard, type Scope } from "./access"

const owned = `i.app_id=? AND i.hidden IS NULL AND json_extract(i.author,'$.id')=? AND EXISTS(SELECT 1 FROM apps a WHERE a.id=i.app_id AND a.mode='helpdesk')`
const args = (s: Scope) => [s.app, s.user!.id]
export async function target(c: Ctx, s: Scope, id: string) {
  return (
    (await sql(c.env, `SELECT i.number FROM issues i WHERE ${owned} AND i.id=?`, ...args(s), id).first<number>(
      "number"
    )) ?? missing()
  )
}
function participant(a: Actor): Participant {
  if (a.type === "guest") return { type: "user", id: a.id, name: a.name }
  return {
    type: a.type === "member" ? "team" : "agent",
    id: a.id,
    name: a.name,
    avatar_url: a.type === "member" ? a.avatar_url : null
  }
}
function access(c: Ctx, s: Scope, id?: string): Access {
  return {
    env: c.env,
    ctx: c.executionCtx,
    app: { id: s.app, slug: s.slug, name: s.name, public: false },
    actor: { type: "guest", id: s.user!.id, name: s.user!.name, handle: "requester" },
    role: null,
    desk: true,
    locale: s.user!.locale,
    origin: c.env.APP_DOMAIN ? "https://" + c.env.APP_DOMAIN : new URL(c.req.url).origin,
    credentialGuard: liveGuard(c, s, id)
  }
}

const files = `(SELECT json_group_array(json_object('id',a.id,'name',a.name,'type',a.mime,'size',a.size)) FROM attachment_links l JOIN attachments a ON a.id=l.attachment_id WHERE l.issue_id=t.issue_id AND coalesce(l.comment_id,l.issue_id)=t.id)`
const wire = `json_object('id',t.id,'created_at',t.created_at,'issue_id',t.issue_id,'actor',json(t.actor),'type',t.type,'body',t.body,'edited_at',t.edited_at,'data',json(t.data),'files',json(${files}))`
type ItemRow = {
  id: string
  issue_id: string
  created_at: string
  actor: Actor
  type: string
  body: string
  edited_at: string | null
  data: {
    to: Conversation["status"]
    close_reason: Conversation["close_reason"]
    assignee: Actor | null
    verification_id: string
  } | null
  files: Omit<Upload, "url">[]
}
function project(raw: string): ConversationItem {
  const r = JSON.parse(raw) as ItemRow,
    who = participant(r.actor),
    base = { id: r.id, created_at: r.created_at }
  if (r.type === "message")
    return {
      ...base,
      kind: "message",
      message: {
        ...base,
        conversation_id: r.issue_id,
        author: who,
        body: r.body,
        edited_at: r.edited_at,
        attachments: r.files.map((a) => ({
          ...a,
          url: `/media/${encodeURIComponent(a.id)}/${encodeURIComponent(a.name)}`
        }))
      }
    }
  const d = r.data!,
    event =
      r.type === "assigned" || r.type === "claimed"
        ? {
            type: "assigned" as const,
            assignee: r.type === "claimed" ? who : d.assignee ? participant(d.assignee) : null
          }
        : r.type === "status_changed"
          ? { type: "status_changed" as const, status: d.to, close_reason: d.close_reason ?? null }
          : {
              type: r.type === "verified" ? ("verified" as const) : ("verification_requested" as const),
              verification_id: d.verification_id
            }
  return { ...base, kind: "event", actor: who, event }
}
const cursor = (stamp: string, id: string) => btoa(JSON.stringify([stamp, id]))
function position(s: string | undefined): [string, string] | null {
  if (s === undefined) return null
  try {
    const x = JSON.parse(atob(str(s, "cursor", 512)))
    if (
      Array.isArray(x) &&
      x.length === 2 &&
      typeof x[0] === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x[0]) &&
      typeof x[1] === "string" &&
      x[1].length < 100
    )
      return [x[0], x[1]]
  } catch {}
  return bad("Invalid cursor")
}
const pageSize = 25
function publicProof(row: ProofRow): Verification {
  const proof = verification(row),
    a = proof.requested_by
  return {
    ...proof,
    requested_by:
      a.type === "guest"
        ? { type: a.type, id: a.id, name: a.name, handle: a.handle }
        : a.type === "agent"
          ? { type: a.type, id: a.id, name: a.name }
          : { type: a.type, id: a.id, name: a.name, avatar_url: a.avatar_url }
  }
}
export async function conversations(c: Ctx, s: Scope, id?: string): Promise<Page<Conversation>> {
  const status = id ? undefined : c.req.query("status"),
    pos = id ? null : position(c.req.query("cursor"))
  if (status !== undefined && !["open", "closed"].includes(status)) bad("Invalid status")
  type Row = Omit<Conversation, "assignee" | "last_item" | "verifications"> & {
    assignee: string | null
    last_item: string
  }
  const rs = (
    await sql(
      c.env,
      `WITH page AS (SELECT i.id,i.number,i.title subject,i.status,i.close_reason,i.created_at,i.assignee,
    (SELECT ${wire} FROM api_items t WHERE t.issue_id=i.id ORDER BY t.created_at DESC,t.id DESC LIMIT 1) last_item,
    (SELECT max(t.created_at) FROM api_items t WHERE t.issue_id=i.id) updated_at,
    (SELECT count(*) FROM api_items t WHERE t.issue_id=i.id AND json_extract(t.actor,'$.id')!=json_extract(i.author,'$.id') AND (t.created_at,t.id)>(coalesce(m.stamp,''),coalesce(m.item,''))) unread
    FROM issues i LEFT JOIN api_reads m ON m.issue_id=i.id AND m.actor_id=json_extract(i.author,'$.id') WHERE ${owned} ${id ? "AND i.id=?" : ""} ${status ? `AND i.status${status === "open" ? "!=" : "="}'closed'` : ""}) SELECT * FROM page ${pos ? "WHERE (updated_at,id)<(?,?)" : ""} ORDER BY updated_at DESC,id DESC LIMIT 26`,
      ...args(s),
      ...(id ? [id] : []),
      ...(pos ?? [])
    ).all<Row>()
  ).results
  if (id && !rs.length) missing()
  const more = rs.length > pageSize,
    selected = rs.slice(0, pageSize),
    last = selected.at(-1)
  const proofs = selected.length
    ? (
        await sql(
          c.env,
          `SELECT ${proofCols} FROM email_codes v JOIN issues i ON i.id=v.issue_id AND i.app_id=v.app_id WHERE ${owned} AND v.kind='verification' AND i.id IN(SELECT value FROM json_each(?)) ORDER BY v.created_at,v.id`,
          ...args(s),
          JSON.stringify(selected.map((x) => x.id))
        ).all<ProofRow>()
      ).results
    : []
  return {
    data: selected.map((r) => ({
      ...r,
      assignee: r.assignee ? participant(JSON.parse(r.assignee)) : null,
      last_item: r.last_item ? project(r.last_item) : null,
      verifications: proofs.filter((v) => v.issue_id === r.id).map(publicProof)
    })),
    next_cursor: more ? cursor(last!.updated_at, last!.id) : null
  }
}
export async function items(c: Ctx, s: Scope, id: string): Promise<Page<ConversationItem>> {
  const after = c.req.query("after")
  let pos = position(c.req.query("cursor"))
  if (after !== undefined) {
    if (pos) bad("Use either after or cursor")
    const row = await sql(
      c.env,
      `SELECT t.created_at FROM api_items t JOIN issues i ON i.id=t.issue_id WHERE ${owned} AND i.id=? AND t.id=?`,
      ...args(s),
      id,
      after
    ).first<string>("created_at")
    if (!row) bad("Invalid after")
    pos = [row, after]
  }
  const rs = (
    await sql(
      c.env,
      `SELECT ${wire} item FROM api_items t JOIN issues i ON i.id=t.issue_id WHERE ${owned} AND i.id=? ${pos ? "AND (t.created_at,t.id)>(?,?)" : ""} ORDER BY t.created_at,t.id LIMIT 26`,
      ...args(s),
      id,
      ...(pos ?? [])
    ).all<{ item: string }>()
  ).results
  const data = rs.slice(0, pageSize).map((r) => project(r.item)),
    last = data.at(-1)
  return { data, next_cursor: rs.length > pageSize ? cursor(last!.created_at, last!.id) : null }
}
function message(b: Record<string, unknown>) {
  const body = str(b.body, "body", 65536, true),
    attachment_ids = ids(b.attachments, "attachments")
  if (!body.trim() && !attachment_ids.length) bad("A message needs text or an attachment")
  return { body, attachment_ids }
}
export async function open(c: Ctx, s: Scope, b: Record<string, unknown>) {
  if (s.user!.anonymous && s.require_verified_email) fail(401, "contact_required", "Verified contact required")
  const m = message(input(b.message)),
    title = b.subject === undefined ? m.body.trim().slice(0, 120) || "Attachment" : str(b.subject, "subject", 256)
  const created = await createIssue(access(c, s), { ...m, title, private: true, metadata_id: b.metadata_id })
  return (await conversations(c, s, created.id)).data[0]!
}
export async function postMessage(
  c: Ctx,
  s: Scope,
  id: string,
  n: number,
  b: Record<string, unknown>
): Promise<Message> {
  const m = await addComment(access(c, s, id), n, message(b))
  return {
    id: m.id,
    conversation_id: id,
    created_at: m.created_at,
    edited_at: m.edited_at,
    body: m.body,
    author: participant(m.author),
    attachments: m.attachments.map((a) => ({ id: a.id, name: a.name, type: a.mime, size: a.size, url: a.url }))
  }
}
export async function mark(c: Ctx, s: Scope, id: string, b: Record<string, unknown>) {
  const item = str(b.item_id, "item_id", 100)
  const [, r] = await c.env.DB.batch([
    liveGuard(c, s, id),
    sql(
      c.env,
      `INSERT INTO api_reads SELECT issue_id,?,created_at,id FROM api_items WHERE issue_id=? AND id=? ON CONFLICT(issue_id,actor_id) DO UPDATE SET stamp=CASE WHEN (excluded.stamp,excluded.item)>(stamp,item) THEN excluded.stamp ELSE stamp END,item=CASE WHEN (excluded.stamp,excluded.item)>(stamp,item) THEN excluded.item ELSE item END RETURNING item`,
      s.user!.id,
      id,
      item
    )
  ])
  if (!r!.results.length) bad("Unknown visible item")
  return { ok: true }
}
export async function typing(c: Ctx, s: Scope, id: string) {
  const activity = { actor: access(c, s).actor, text: null, expires_at: new Date(Date.now() + 5000).toISOString() }
  await c.env.DB.batch([
    liveGuard(c, s, id),
    sql(c.env, "UPDATE issues SET activity=? WHERE id=?", JSON.stringify(activity), id)
  ])
  await issueRoom(c.env, id).refreshConversationPresence(s.app, id)
  return { ok: true }
}
export async function confirm(
  c: Ctx,
  s: Scope,
  id: string,
  vid: string,
  b: Record<string, unknown>
): Promise<Verification> {
  await enforce(c, "RL_IP", "code-verify:" + clientIP(c))
  const row =
    (await sql(
      c.env,
      `SELECT ${proofCols} FROM email_codes v JOIN issues i ON i.id=v.issue_id AND i.app_id=v.app_id WHERE ${owned} AND i.id=? AND v.id=? AND v.kind='verification'`,
      ...args(s),
      id,
      vid
    ).first<ProofRow>()) ?? missing()
  try {
    await redeemCode(
      c.env,
      { kind: "verification", app: s.app, issue: id, email: row.email },
      b.code,
      vid,
      [s.user!.id],
      liveGuard(c, s, id)
    )
  } finally {
    c.executionCtx.waitUntil(dispatchProof(c.env, vid))
  }
  return publicProof(
    (await sql(
      c.env,
      `SELECT ${proofCols} FROM email_codes v WHERE v.id=? AND v.app_id=?`,
      vid,
      s.app
    ).first<ProofRow>()) ?? missing()
  )
}
