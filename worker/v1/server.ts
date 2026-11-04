import type { Actor, CloseReason, IssueStatus, Label, Role } from "../../shared/api"
import type { Contact, Conversation, ConversationItem, Message, Page } from "../../shared/v1"
import { bad, choice, denied, email, input, memberActor, missing, sql, str, type Ctx } from "../core"
import { apiOrigin, type Scope } from "./access"
import { keyAudit, serverGuard } from "./server-auth"
import { hostClaims, resolveHost } from "../identity"
import { isLocale } from "../locale"
import { contactActor } from "../contact-session"
import { contactRoom } from "./signals"
import { listIssues } from "../issues"
import { addComment, createIssue, updateIssue, type Access } from "../mutations"
import { agentAccessSQL } from "../permissions"
import { requestVerification } from "../helpdesk"
import { requestJson, typeInfo } from "../request-types"
import { proofCols, verification, type ProofRow } from "../helpdesk-data"
import { cursor, position, message, participant, project, wire } from "./conversations"

const contactCols =
  "id,name,email,external_id,unverified_email,verified_via,coalesce(locale,'en') locale,created_at,last_seen_at"
const size = 25
function subject(x: unknown) {
  const v = str(x, "external_id", 255).trim()
  if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v)) bad("Invalid external_id")
  return v
}
async function find(c: Ctx, s: Scope, k: "id" | "external_id", value: string): Promise<Contact> {
  const row =
    (await sql(
      c.env,
      `SELECT ${contactCols} FROM contacts WHERE app_id=? AND ${k}=?`,
      s.app,
      value
    ).first<Contact>()) ?? missing()
  return { ...row, anonymous: false }
}
export const getContact = (c: Ctx, s: Scope) =>
  find(
    c,
    s,
    c.req.param("external_id") === undefined ? "id" : "external_id",
    c.req.param("external_id") === undefined ? c.req.param("id")! : subject(c.req.param("external_id"))
  )
export async function listContacts(c: Ctx, s: Scope): Promise<Page<Contact>> {
  const term = str(c.req.query("q") ?? "", "query", 255, true).toLowerCase(),
    pos = position(c.req.query("cursor")),
    rows = (
      await sql(
        c.env,
        `SELECT ${contactCols} FROM contacts WHERE app_id=?1 AND (?2='' OR instr(lower(name),?2) OR instr(lower(email),?2) OR instr(lower(unverified_email),?2) OR instr(lower(external_id),?2)) ${pos ? "AND (created_at,id)<(?3,?4)" : ""} ORDER BY created_at DESC,id DESC LIMIT 26`,
        s.app,
        term,
        ...(pos ?? [])
      ).all<Contact>()
    ).results,
    data = rows.slice(0, size).map((r) => ({ ...r, anonymous: false })),
    last = data.at(-1)
  return { data, next_cursor: rows.length > size ? cursor(last!.created_at, last!.id) : null }
}
export async function upsert(c: Ctx, s: Scope, b: Record<string, unknown>) {
  const sub = subject(c.req.param("external_id")),
    v = hostClaims(sub, b, (reason) => bad(`Invalid contact ${reason}`))
  if (b.locale !== undefined && !isLocale(b.locale)) bad("Invalid locale")
  const q = [serverGuard(c.env, s), ...resolveHost(c.env, { ...v, app: s.app }, { id: s.key, kind: "api" })]
  if (b.locale !== undefined)
    q.push(sql(c.env, "UPDATE contacts SET locale=? WHERE app_id=? AND external_id=?", b.locale, s.app, sub))
  q.push(
    keyAudit(c.env, s.app, s.key, "api.contact.upserted", "contact", sub, {}, true),
    sql(c.env, `SELECT ${contactCols} FROM contacts WHERE app_id=? AND external_id=?`, s.app, sub)
  )
  const r = (await c.env.DB.batch<Contact>(q)).at(-1)!.results[0] ?? missing()
  s.replayContact = r.id
  return { ...r, anonymous: false }
}
export async function erase(c: Ctx, s: Scope) {
  const id = c.req.param("id")!
  await find(c, s, "id", id)
  s.replayContact = id
  const [, deleted] = await c.env.DB.batch([
    serverGuard(c.env, s, "EXISTS(SELECT 1 FROM contacts WHERE app_id=k.app_id AND id=?)", [id]),
    sql(c.env, "DELETE FROM contacts WHERE app_id=? AND id=? RETURNING id", s.app, id),
    keyAudit(c.env, s.app, s.key, "api.contact.erased", "contact", id)
  ])
  if (!deleted!.results.length) missing()
  await contactRoom(c.env, s.app, id).reviewContact()
  return { ok: true }
}
export async function workspaceTarget(c: Ctx, s: Scope, id: string) {
  const row =
    (await sql(
      c.env,
      "SELECT number,json_extract(author,'$.id') actor FROM issues WHERE app_id=? AND id=?",
      s.app,
      id
    ).first<{ number: number; actor: string }>()) ?? missing()
  s.replayContact = row.actor
  return row.number
}
const staffWire = `json_set(${wire},'$.internal',t.internal,'$.hidden',t.hidden)`
const audience = (c: Ctx, s: Scope) => ({ env: c.env, app: s.app, who: "", origin: apiOrigin(c) })
export async function workspaceConversations(c: Ctx, s: Scope, id?: string): Promise<Page<Conversation>> {
  let ids: string[],
    next_cursor: string | null = null
  if (id) ids = [id]
  else {
    const status = c.req.query("status"),
      filter = status ? choice(status, ["open", "closed", "in_progress", "waiting"] as const, "status") : null,
      q = c.req.query("q") ?? "",
      p = await listIssues(
        c.env,
        s.app,
        {
          allStates: true,
          sort: "updated",
          limit: size,
          query: q + (filter ? ` ${filter === "open" || filter === "closed" ? "is" : "status"}:${filter}` : ""),
          contactId: c.req.query("contact_id"),
          cursor: c.req.query("cursor")
        },
        { team: true, actorId: null }
      )
    ids = p.issues.map((i) => i.id)
    next_cursor = p.next_cursor
  }
  if (!ids.length) return { data: [], next_cursor }
  const sub = `FROM issues i JOIN json_each(?2) j ON i.id=j.value WHERE i.app_id=?1`,
    args = [s.app, JSON.stringify(ids)]
  const [rs, vs] = await c.env.DB.batch([
    sql(
      c.env,
      `SELECT i.id,i.number,i.title subject,i.status,i.close_reason,i.created_at,i.updated_at,i.assignee,i.hidden IS NOT NULL hidden,${requestJson(true)} request_info,
    (SELECT id FROM contacts WHERE app_id=i.app_id AND id=json_extract(i.author,'$.id')) contact_id,EXISTS(SELECT 1 FROM api_created_issues WHERE issue_id=i.id) api,
    (SELECT json_group_array(l.name ORDER BY l.name) FROM issue_labels il JOIN labels l ON l.id=il.label_id WHERE il.issue_id=i.id) labels,
    (SELECT ${staffWire} FROM api_workspace_items t WHERE t.issue_id=i.id ORDER BY t.created_at DESC,t.id DESC LIMIT 1) last_item,
    (SELECT count(*) FROM api_items t WHERE t.issue_id=i.id AND (t.type='verification_requested' OR (t.type='message' AND json_extract(t.actor,'$.id')!=json_extract(i.author,'$.id'))) AND NOT EXISTS(SELECT 1 FROM api_reads m WHERE m.issue_id=i.id AND m.actor_id=json_extract(i.author,'$.id') AND (m.stamp,m.item)>=(t.created_at,t.id))) unread
    ${sub} ORDER BY cast(j.key AS integer)`,
      ...args
    ),
    sql(
      c.env,
      `SELECT ${proofCols} FROM email_codes v WHERE v.app_id=?1 AND v.kind='verification' AND v.issue_id IN(SELECT i.id ${sub}) ORDER BY v.created_at,v.id`,
      ...args
    )
  ])
  if (id && !rs!.results.length) missing()
  const proofs = vs!.results as ProofRow[]
  const data = await Promise.all(
    (
      rs!.results as {
        id: string
        number: number
        subject: string
        status: IssueStatus
        close_reason: CloseReason | null
        created_at: string
        updated_at: string
        assignee: string | null
        hidden: number
        contact_id: string | null
        request_info: string | null
        api: number
        labels: string
        last_item: string | null
        unread: number
      }[]
    ).map(async ({ api, labels, assignee, hidden, last_item, request_info, ...r }) => ({
      ...r,
      ...typeInfo(request_info),
      labels: JSON.parse(labels) as string[],
      assignee: assignee ? participant(JSON.parse(assignee)) : null,
      hidden: !!hidden,
      ...(api ? { created_via: "api" as const } : {}),
      last_item: last_item ? await project(last_item, audience(c, s), true) : null,
      verifications: proofs.filter((v) => v.issue_id === r.id).map(verification)
    }))
  )
  return { data, next_cursor }
}
const operator = (s: Scope): Actor => ({ type: "agent", id: "api-key:" + s.key, name: s.name })
function access(
  c: Ctx,
  s: Scope,
  actor: Actor,
  role: Access["role"],
  write: NonNullable<Access["serverWrite"]>
): Access {
  return {
    env: c.env,
    app: { id: s.app, slug: s.slug, name: s.name, public: false },
    actor,
    role,
    desk: true,
    ctx: c.executionCtx,
    origin: c.env.APP_DOMAIN ? "https://" + c.env.APP_DOMAIN : apiOrigin(c),
    serverWrite: write
  }
}
export async function openFor(c: Ctx, s: Scope, b: Record<string, unknown>) {
  const selector = input(b.contact),
    byId = selector.id !== undefined
  if (byId === (selector.external_id !== undefined)) bad("Choose one contact identifier")
  const t = await find(
      c,
      s,
      byId ? "id" : "external_id",
      byId ? str(selector.id, "contact id", 80) : subject(selector.external_id)
    ),
    m = message(input(b.message)),
    title = b.subject === undefined ? m.body.trim().slice(0, 120) || "Attachment" : str(b.subject, "subject", 256)
  s.replayContact = t.id
  const a = access(c, s, contactActor(t), null, (id) => [
    serverGuard(c.env, s, "EXISTS(SELECT 1 FROM contacts WHERE app_id=k.app_id AND id=? AND name IS ?)", [
      t.id,
      t.name
    ]),
    sql(c.env, "INSERT INTO api_created_issues VALUES(?)", id),
    keyAudit(c.env, s.app, s.key, "api.conversation.created", "issue", id, { contact_id: t.id })
  ])
  a.locale = t.locale
  const issue = await createIssue(
    a,
    { ...m, title, private: true, metadata_id: b.metadata_id, request_type_id: b.request_type, fields: b.fields },
    { c, operator: operator(s), staff: true, serverKey: s.key }
  )
  return (await workspaceConversations(c, s, issue.id)).data[0]!
}
const memberQuery =
  "SELECT u.id,u.name,u.avatar_url,m.role FROM users u JOIN members m ON m.user_id=u.id WHERE m.app_id=? AND u.email=?"
async function member(c: Ctx, s: Scope, address: unknown, writer = false) {
  const row = await sql(
    c.env,
    memberQuery + (writer ? " AND m.role IN ('owner','admin','member')" : ""),
    s.app,
    email(address)
  ).first<{ id: string; name: string; avatar_url: string | null; role: Role }>()
  if (!row) denied()
  return memberActor(row, row.role)
}
export async function replyAs(c: Ctx, s: Scope, id: string, n: number, b: Record<string, unknown>): Promise<Message> {
  if (b.as === undefined) bad("as.member is required")
  const address = email(input(b.as).member),
    actor = await member(c, s, address, true)
  if (b.internal !== undefined && typeof b.internal !== "boolean") bad("Invalid internal flag")
  const a = access(c, s, actor, "member", (mid) => [
    serverGuard(c.env, s, `EXISTS(${memberQuery} AND u.id=? AND m.role IN ('owner','admin','member'))`, [
      s.app,
      address,
      actor.id
    ]),
    keyAudit(c.env, s.app, s.key, "api.message.created", "comment", mid, {
      issue_id: id,
      as_member: actor.id,
      internal: b.internal === true
    })
  ])
  const m = await addComment(a, n, { ...message(b), internal: b.internal ?? false })
  return {
    id: m.id,
    conversation_id: id,
    created_at: m.created_at,
    edited_at: m.edited_at,
    author: participant(actor),
    internal: m.internal,
    body: m.body,
    attachments: m.attachments.map((f) => ({
      id: f.id,
      name: f.name,
      type: f.mime,
      size: f.size,
      url: apiOrigin(c) + f.url
    }))
  }
}
export async function patchConversation(c: Ctx, s: Scope, id: string, n: number, b: Record<string, unknown>) {
  const patch: Record<string, unknown> = {},
    guards: D1PreparedStatement[] = [],
    actor = operator(s)
  let to: Actor | null | undefined
  if (b.status !== undefined) patch.status = b.status
  if (b.close_reason !== undefined) patch.close_reason = b.close_reason
  if (b.assignee !== undefined) {
    if (b.assignee === null) to = null
    else {
      const x = input(b.assignee)
      if ((x.member !== undefined) === (x.agent !== undefined)) bad("Choose one assignee")
      if (x.member !== undefined) {
        const address = email(x.member)
        to = await member(c, s, address)
        guards.push(serverGuard(c.env, s, `EXISTS(${memberQuery} AND u.id=?)`, [s.app, address, to.id]))
      } else {
        const agent = str(x.agent, "agent", 80),
          acl = `SELECT 1 FROM (${agentAccessSQL}) WHERE agent_id=? AND app_id=? AND role IS NOT NULL`,
          row =
            (await sql(c.env, `SELECT name FROM agents WHERE id=? AND EXISTS(${acl})`, agent, agent, s.app).first<{
              name: string
            }>()) ?? missing()
        to = { type: "agent", id: agent, name: row.name }
        guards.push(serverGuard(c.env, s, `EXISTS(${acl})`, [agent, s.app]))
      }
    }
    patch.assignee_id = to?.id ?? null
  }
  if (b.labels !== undefined) {
    if (!Array.isArray(b.labels) || b.labels.length > 50) bad("Expected label names")
    const names = [...new Set(b.labels.map((x) => str(x, "label", 60).replace(/[A-Z]/g, (ch) => ch.toLowerCase())))],
      labels = (
        await sql(
          c.env,
          "SELECT id,name FROM labels WHERE app_id=? AND name IN(SELECT value FROM json_each(?))",
          s.app,
          JSON.stringify(names)
        ).all<Label>()
      ).results
    if (labels.length !== names.length) bad("Unknown label")
    patch.label_ids = labels.map((x) => x.id)
  }
  if (!Object.keys(patch).length) bad("Expected a conversation change")
  const a = access(c, s, actor, "member", () => [
    serverGuard(c.env, s, "EXISTS(SELECT 1 FROM issues WHERE app_id=k.app_id AND id=?)", [id]),
    ...guards,
    keyAudit(c.env, s.app, s.key, "api.conversation.updated", "issue", id, { fields: Object.keys(patch) })
  ])
  await updateIssue(a, n, patch, false, to)
  return (await workspaceConversations(c, s, id)).data[0]!
}
export async function requestProof(c: Ctx, s: Scope, n: number, b: Record<string, unknown>) {
  return requestVerification(
    c,
    { id: s.app, name: s.name },
    n,
    b.email,
    operator(s),
    { actorId: null, team: true },
    s.key
  )
}
