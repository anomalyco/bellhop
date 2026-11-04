import type { Approval, ApprovalToken } from "../shared/api"
import { bad, choice, fail, input, missing, now, sql, str, uid, type Ctx } from "./core"
import { agentAccessSQL } from "./permissions"
import { entry } from "./audit"
import { seal, unseal } from "./identity-keys"
import type { Access } from "./mutations"
import { issueSummary } from "./issues"
import { emit } from "./events"
import { enqueueWebhooks } from "./webhooks"
import { typeGuard } from "./request-types"
import { serverGuard } from "./v1/server-auth"
import type { Scope } from "./v1/access"

export const memberGrant = `SELECT 1 FROM members m JOIN apps w ON w.id=m.app_id WHERE w.mode='helpdesk' AND m.app_id=? AND m.user_id=? AND m.role IN ('owner','admin','member')`
export const responderGrant = `SELECT 1 FROM (${agentAccessSQL}) WHERE app_id=? AND agent_id=? AND role IN ('responder','member','admin')`
const readDoc = (env: Env, app: string, id: string) =>
  sql(env, "SELECT doc,issue_id FROM approval_docs WHERE app_id=? AND id=?", app, id)
type Doc = { doc: string; issue_id: string }
const decode = (row: Doc | undefined | null): Approval => JSON.parse((row ?? missing()).doc)

async function announce(a: Access, p: Approval, issueId: string, decided: boolean) {
  const type = decided ? "approval.decided" : "approval.requested",
    issue = await issueSummary(a.env, a.app.id, p.issue_number)
  if (issue.id !== issueId) return
  const event = {
    id: p.id + (decided ? "-decision" : ""),
    type,
    actor: a.actor,
    data: { approval: p },
    created_at: (decided ? p.decided_at : p.created_at)!
  } as const
  emit(a.env, a.ctx, {
    app: a.app,
    origin: a.origin,
    issue,
    actor: a.actor,
    type: "issue.updated",
    liveOnly: true,
    internalOnly: true,
    items: [{ kind: "event", event }]
  })
  await enqueueWebhooks(a.env, a.origin, a.app, a.actor, issue, [{ type, approval: p }])
}

export async function requestApproval(a: Access, n: number, b: Record<string, unknown>) {
  const action = str(b.action, "action", 40),
    summary = str(b.summary, "summary", 300),
    details = b.details === undefined ? {} : input(b.details)
  if (!/^[a-z0-9_]{1,40}$/.test(action)) bad("Invalid action")
  if (
    Object.keys(details).length > 20 ||
    Object.values(details).some(
      (v) => typeof v !== "string" && typeof v !== "boolean" && !(typeof v === "number" && Number.isFinite(v))
    )
  )
    bad("details must have at most 20 scalar fields")
  const id = uid(),
    { env, app, actor } = a
  const [, write, , read] = await env.DB.batch<Doc>([
    typeGuard(env, `EXISTS(${responderGrant})`, app.id, actor.id),
    sql(
      env,
      `INSERT INTO approvals(id,issue_id,action,summary,details,requested_by,created_at,expires) SELECT ?,i.id,?,?,?,?,?,unixepoch()+604800 FROM issues i JOIN apps w ON w.id=i.app_id AND w.mode='helpdesk' WHERE w.id=? AND i.number=?`,
      id,
      action,
      summary,
      JSON.stringify(details),
      JSON.stringify(actor),
      now(),
      app.id,
      n
    ),
    entry(env, app.id, actor, "approval.requested", { type: "approval", id, number: n }, { action }),
    readDoc(env, app.id, id)
  ])
  if (!write!.meta.changes) missing()
  const p = decode(read!.results[0])
  a.ctx.waitUntil(announce(a, p, read!.results[0]!.issue_id, false))
  return p
}
export async function decideApproval(a: Access, n: number, id: string, b: Record<string, unknown>) {
  const decision = choice(b.decision, ["approve", "reject"] as const, "decision"),
    note = b.note === undefined ? null : str(b.note, "note", 1000, true),
    { env, app, actor } = a
  const [, write, , read] = await env.DB.batch<Doc>([
    typeGuard(env, `EXISTS(${memberGrant})`, app.id, actor.id),
    sql(
      env,
      `UPDATE approvals SET state=?,decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),decided_by=?,note=?,expires=unixepoch()+1800 WHERE id=? AND state='pending' AND expires>unixepoch() AND issue_id=(SELECT id FROM issues WHERE app_id=? AND number=?)`,
      decision === "approve" ? "approved" : "rejected",
      JSON.stringify(actor),
      note,
      id,
      app.id,
      n
    ),
    entry(env, app.id, actor, "approval.decided", { type: "approval", id, number: n }, { decision }),
    readDoc(env, app.id, id)
  ])
  const p = decode(read!.results[0])
  if (p.issue_number !== n) missing()
  if (!write!.meta.changes)
    fail(p.state === "expired" ? 410 : 409, "approval_unavailable", "Approval cannot be decided again")
  a.ctx.waitUntil(announce(a, p, read!.results[0]!.issue_id, true))
  return p
}

type SigningKey = { kid: string; cipher: string }
const enc = new TextEncoder(),
  url64 = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "")
async function signingKey(env: Env, app: string) {
  const select = () => sql(env, "SELECT kid,cipher FROM approval_keys WHERE app_id=?", app).first<SigningKey>()
  let row = await select()
  if (!row) {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair,
      kid = uid()
    const pub = await crypto.subtle.exportKey("raw", pair.publicKey)
    if (!(pub instanceof ArrayBuffer)) throw Error("Invalid Ed25519 public key export")
    const x = url64(new Uint8Array(pub))
    const cipher = await seal(
      env,
      app,
      kid,
      JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
      "approval-signing/v1"
    )
    // Always load the winning pair, including on simultaneous first use.
    await sql(
      env,
      "INSERT INTO approval_keys(app_id,kid,x,cipher) VALUES(?,?,?,?) ON CONFLICT(app_id) DO NOTHING",
      app,
      kid,
      x,
      cipher
    ).run()
    row = await select()
  }
  const { kid, cipher } = row ?? missing(),
    jwk = JSON.parse(new TextDecoder().decode(await unseal(env, app, kid, cipher, "approval-signing/v1")))
  return { kid, key: await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]) }
}
export async function getApproval(a: Access, id: string) {
  const { env, app, actor } = a,
    p = decode(await readDoc(env, app.id, id).first<Doc>())
  if (p.state !== "approved" || p.requested_by.id !== actor.id || a.role === "viewer") return p
  const { kid, key } = await signingKey(env, app.id),
    by = p.decided_by!
  const claims: ApprovalToken = {
    iss: "https://blhp.app",
    aud: app.slug,
    sub: id,
    jti: id,
    act: p.action,
    det: p.details,
    req: p.issue_number,
    by: { id: by.id, name: by.name! },
    iat: Math.floor(Date.parse(p.decided_at!) / 1000),
    exp: Date.parse(p.expires_at) / 1000
  }
  const segment = (v: unknown) => url64(enc.encode(JSON.stringify(v))),
    payload = segment({ alg: "EdDSA", kid, typ: "JWT" }) + "." + segment(claims)
  const signature = url64(new Uint8Array(await crypto.subtle.sign("Ed25519", key, enc.encode(payload))))
  const [, r] = await env.DB.batch<Doc>([
    typeGuard(env, `EXISTS(${responderGrant})`, app.id, actor.id),
    readDoc(env, app.id, id)
  ])
  const latest = decode(r!.results[0])
  return latest.state === "approved" ? { ...latest, token: payload + "." + signature } : latest
}
export async function jwks(env: Env) {
  return {
    keys: (
      await sql(
        env,
        `SELECT 'OKP' kty,'Ed25519' crv,'EdDSA' alg,'sig' AS use,kid,x FROM approval_keys ORDER BY kid`
      ).all()
    ).results
  }
}
export async function consume(c: Ctx, s: Scope, id: string) {
  const [, w, , r] = await c.env.DB.batch<Doc>([
    serverGuard(c.env, s),
    sql(
      c.env,
      `UPDATE approvals SET state='used' WHERE id=? AND state='approved' AND expires>unixepoch() AND issue_id IN(SELECT id FROM issues WHERE app_id=?)`,
      id,
      s.app
    ),
    entry(c.env, s.app, { type: "agent", id: "api-key:" + s.key, name: s.name }, "approval.used", {
      type: "approval",
      id
    }),
    readDoc(c.env, s.app, id)
  ])
  const p = decode(r!.results[0])
  if (!w!.meta.changes)
    fail(p.state === "used" ? 409 : 410, "approval_unavailable", "Approval is not available for use")
  return p
}
export async function listApprovals(c: Ctx, s: Scope, id: string) {
  const [, r] = await c.env.DB.batch<Doc>([
    serverGuard(c.env, s),
    sql(c.env, "SELECT doc FROM approval_docs WHERE app_id=? AND issue_id=? ORDER BY created_at,id", s.app, id)
  ])
  return r!.results.map(decode)
}
