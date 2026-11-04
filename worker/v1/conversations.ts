import type { Actor } from "../../shared/api"
import type { Verification } from "../../shared/v1"
import type { Conversation, ConversationItem, Message, Page, Participant, Upload } from "../../shared/v1"
import { bad, fail, ids, input, missing, sql, str, type Ctx } from "../core"
import { addComment, createIssue, type Access } from "../mutations"
import { issueRoom } from "../events"
import { redeemCode } from "../email-codes"
import { dispatchProof } from "../helpdesk"
import { proofCols, verification, type ProofRow } from "../helpdesk-data"
import { clientIP, enforce } from "../rate-limits"
import { contactActor } from "../contact-session"
import { liveGuard, apiOrigin, type Scope } from "./access"
import { signedFiles, type Audience } from "./signed-media"
import { signalContact } from "./signals"

const owned = `i.app_id=? AND i.hidden IS NULL AND json_extract(i.author,'$.id')=? AND EXISTS(SELECT 1 FROM apps a WHERE a.id=i.app_id AND a.mode='helpdesk')`
const args = (s: Scope) => [s.app, s.user!.id]
export async function target(c: Ctx, s: Scope, id: string) {
  return (
    (await sql(c.env, `SELECT i.number FROM issues i WHERE ${owned} AND i.id=?`, ...args(s), id).first<number>(
      "number"
    )) ?? missing()
  )
}
export function participant(a: Actor): Participant {
  if (a.type === "agent" && a.id.startsWith("api-key:"))
    return { type: "team", id: "workspace-team", name: a.name, avatar_url: null }
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
    actor: s.user!.anonymous
      ? { type: "guest", id: s.user!.id, name: s.user!.name, handle: "guest-" + s.user!.id.slice(5, 13) }
      : contactActor(s.user!),
    role: null,
    desk: true,
    locale: s.user!.locale,
    origin: c.env.APP_DOMAIN ? "https://" + c.env.APP_DOMAIN : new URL(c.req.url).origin,
    credentialGuard: liveGuard(c, s, id)
  }
}

const files = `(SELECT json_group_array(json_object('id',a.id,'name',a.name,'type',a.mime,'size',a.size)) FROM attachment_links l JOIN attachments a ON a.id=l.attachment_id WHERE l.issue_id=t.issue_id AND coalesce(l.comment_id,l.issue_id)=t.id)`
export const wire = `json_object('id',t.id,'created_at',t.created_at,'issue_id',t.issue_id,'actor',json(t.actor),'type',t.type,'body',t.body,'edited_at',t.edited_at,'data',json(t.data),'files',json(${files}))`
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
const audience = (c: Ctx, s: Scope): Audience => ({ env: c.env, app: s.app, who: s.user!.id, origin: apiOrigin(c) })
export async function project(raw: string, a: Audience, workspace = false): Promise<ConversationItem> {
  const r = JSON.parse(raw) as ItemRow & { internal?: number; hidden?: number },
    who = r.actor ? participant(r.actor) : null,
    base = { id: r.id, created_at: r.created_at, ...(workspace && { internal: !!r.internal, hidden: !!r.hidden }) }
  if (r.type === "message")
    return {
      ...base,
      kind: "message",
      message: {
        ...base,
        conversation_id: r.issue_id,
        author: who!,
        body: r.body,
        edited_at: r.edited_at,
        attachments: workspace
          ? r.files.map((f) => ({
              ...f,
              url: `${a.origin}/media/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name)}`
            }))
          : await signedFiles(a, r.files)
      }
    }
  if (
    workspace &&
    (r.internal || !["assigned", "claimed", "status_changed", "verified", "verification_requested"].includes(r.type))
  )
    return {
      ...base,
      kind: "event",
      actor: who,
      event: { type: "workspace_event", action: r.type, data: r.data ?? {} }
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
export const cursor = (stamp: string, id: string) => btoa(JSON.stringify([stamp, id]))
export function position(s: string | undefined): [string, string] | null {
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
      a.type === "agent" && a.id.startsWith("api-key:")
        ? { type: "team", id: "workspace-team", name: a.name, avatar_url: null }
        : a.type === "guest"
          ? { type: a.type, id: a.id, name: a.name, handle: a.handle }
          : a.type === "agent"
            ? { type: a.type, id: a.id, name: a.name }
            : { type: a.type, id: a.id, name: a.name, avatar_url: a.avatar_url }
  }
}
type Row = Omit<Conversation, "assignee" | "last_item" | "verifications"> & {
  assignee: string | null
  last_item: string
}
function conversationQuery(a: Audience, id?: string, status?: string, pos?: [string, string] | null) {
  return sql(
    a.env,
    `WITH page AS (SELECT i.id,i.number,i.title subject,i.status,i.close_reason,i.created_at,i.assignee,
    (SELECT ${wire} FROM api_items t WHERE t.issue_id=i.id ORDER BY t.created_at DESC,t.id DESC LIMIT 1) last_item,
    (SELECT max(t.created_at) FROM api_items t WHERE t.issue_id=i.id) updated_at,
    (SELECT count(*) FROM api_items t WHERE t.issue_id=i.id AND (t.type='verification_requested' OR (t.type='message' AND json_extract(t.actor,'$.id')!=json_extract(i.author,'$.id'))) AND (t.created_at,t.id)>(coalesce(m.stamp,''),coalesce(m.item,''))) unread
    FROM issues i LEFT JOIN api_reads m ON m.issue_id=i.id AND m.actor_id=json_extract(i.author,'$.id') WHERE ${owned} ${id ? "AND i.id=?" : ""} ${status ? `AND i.status${status === "open" ? "!=" : "="}'closed'` : ""}) SELECT * FROM page ${pos ? "WHERE (updated_at,id)<(?,?)" : ""} ORDER BY updated_at DESC,id DESC LIMIT 26`,
    a.app,
    a.who,
    ...(id ? [id] : []),
    ...(pos ?? [])
  )
}
function proofsQuery(a: Audience, ids: string[]) {
  return sql(
    a.env,
    `SELECT ${proofCols} FROM email_codes v JOIN issues i ON i.id=v.issue_id AND i.app_id=v.app_id WHERE ${owned} AND v.kind='verification' AND i.id IN(SELECT value FROM json_each(?)) ORDER BY v.created_at,v.id`,
    a.app,
    a.who,
    JSON.stringify(ids)
  )
}
async function projectRow(a: Audience, r: Row, proofs: ProofRow[]): Promise<Conversation> {
  return {
    ...r,
    assignee: r.assignee ? participant(JSON.parse(r.assignee)) : null,
    last_item: r.last_item ? await project(r.last_item, a) : null,
    verifications: proofs.filter((v) => v.issue_id === r.id).map(publicProof)
  }
}
export async function conversations(c: Ctx, s: Scope, id?: string): Promise<Page<Conversation>> {
  const status = id ? undefined : c.req.query("status"),
    pos = id ? null : position(c.req.query("cursor")),
    a = audience(c, s)
  if (status !== undefined && !["open", "closed"].includes(status)) bad("Invalid status")
  const rs = (await conversationQuery(a, id, status, pos).all<Row>()).results
  if (id && !rs.length) missing()
  const more = rs.length > pageSize,
    selected = rs.slice(0, pageSize),
    last = selected.at(-1)
  const proofs = selected.length
    ? (
        await proofsQuery(
          a,
          selected.map((x) => x.id)
        ).all<ProofRow>()
      ).results
    : []
  return {
    data: await Promise.all(selected.map((r) => projectRow(a, r, proofs))),
    next_cursor: more ? cursor(last!.updated_at, last!.id) : null
  }
}
export async function items(c: Ctx, s: Scope, id: string, workspace = false): Promise<Page<ConversationItem>> {
  const { before, after, last, cursor: raw } = c.req.query()
  if (
    (after !== undefined && (before !== undefined || last !== undefined || raw !== undefined)) ||
    (raw !== undefined && (before !== undefined || last !== undefined))
  )
    bad("Conflicting item boundaries")
  const backCursor = raw?.match(/^b\.([1-9]\d{0,2})\.(.+)$/),
    back = !!backCursor || before !== undefined || last !== undefined
  const count = backCursor ? Number(backCursor[1]) : last === undefined ? pageSize : Number(last)
  if ((last !== undefined && !/^[1-9]\d{0,2}$/.test(last)) || !Number.isInteger(count) || count < 1 || count > 100)
    bad("last must be 1–100")
  let pos = position(backCursor ? backCursor[2] : raw)
  const from = workspace
      ? "FROM api_workspace_items t JOIN issues i ON i.id=t.issue_id WHERE i.app_id=? AND i.id=?"
      : `FROM api_items t JOIN issues i ON i.id=t.issue_id WHERE ${owned} AND i.id=?`,
    bindings = workspace ? [s.app, id] : [...args(s), id]
  const anchor = before ?? after
  if (anchor !== undefined) {
    const stamp = await sql(
      c.env,
      `SELECT t.created_at ${from} AND t.id=?`,
      ...bindings,
      str(anchor, "item id", 100)
    ).first<string>("created_at")
    if (!stamp) bad("Unknown visible item")
    pos = [stamp, anchor]
  }
  const shape = workspace ? `json_set(${wire},'$.internal',t.internal,'$.hidden',t.hidden)` : wire,
    dir = back ? "DESC" : "ASC"
  const rows = (
    await sql(
      c.env,
      `SELECT ${shape} item ${from} ${pos ? `AND (t.created_at,t.id)${back ? "<" : ">"}(?,?)` : ""} ORDER BY t.created_at ${dir},t.id ${dir} LIMIT ?`,
      ...bindings,
      ...(pos ?? []),
      count + 1
    ).all<{ item: string }>()
  ).results
  const data = await Promise.all(
      rows
        .slice(0, count)
        .map((r) => project(r.item, { env: c.env, app: s.app, who: s.user?.id ?? "", origin: apiOrigin(c) }, workspace))
    ),
    edge = data.at(-1)
  return {
    data: back ? data.reverse() : data,
    next_cursor: rows.length > count ? (back ? `b.${count}.` : "") + cursor(edge!.created_at, edge!.id) : null
  }
}
export function message(b: Record<string, unknown>) {
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
    attachments: await signedFiles(
      audience(c, s),
      m.attachments.map((a) => ({ id: a.id, name: a.name, type: a.mime, size: a.size }))
    )
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
  c.executionCtx.waitUntil(signalContact(c.env, s.app, s.user!.id, { issue: id }))
  return { ok: true }
}
// One D1 snapshot for the visible conversation, items, proofs and all socket credentials.
export async function streamSnapshot(a: Audience, id: string, ids: string[], auth: D1PreparedStatement) {
  const [conv, proof, items, access] = await a.env.DB.batch<Record<string, unknown>>([
    conversationQuery(a, id),
    proofsQuery(a, [id]),
    sql(
      a.env,
      `SELECT ${wire} item FROM api_items t JOIN issues i ON i.id=t.issue_id WHERE ${owned} AND i.id=? AND t.id IN(SELECT value FROM json_each(?)) ORDER BY t.created_at,t.id`,
      a.app,
      a.who,
      id,
      JSON.stringify(ids)
    ),
    auth
  ])
  const row = conv!.results[0] as Row | undefined
  return {
    access: access!.results,
    conversation: row ? await projectRow(a, row, proof!.results as ProofRow[]) : null,
    items: await Promise.all(items!.results.map((r) => project(r.item as string, a)))
  }
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
