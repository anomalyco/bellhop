import type { Actor, Contact, Verification } from "../shared/api"
import { sql } from "./core"
export const contactCols =
  "t.id,t.name,t.email,t.unverified_email,t.external_id,t.verified_via,t.created_at,t.last_seen_at"
/** Credential attribution stays on the team/audit side, never on a requester-facing actor. */
export function requesterActor(a: Actor): Actor {
  return a.type === "agent" && a.id.startsWith("api-key:")
    ? { type: "member", id: "workspace-team", name: a.name, avatar_url: null }
    : a
}
export type ProofRow = Omit<Verification, "requested_by"> & { issue_id: string; requested_by: string }
export const proofCols =
  "v.id,v.issue_id,v.email,CASE WHEN v.state='pending' AND v.expires<=unixepoch() THEN 'expired' ELSE v.state END state,v.requested_by,v.created_at,v.verified_at"
export const verification = ({ id, email, state, created_at, verified_at, requested_by }: ProofRow): Verification => ({
  id,
  email,
  state,
  created_at,
  verified_at,
  requested_by: JSON.parse(requested_by) as Actor
})
export function contactQuery(env: Env, app: string, targets: string, ...args: unknown[]) {
  return sql(
    env,
    `SELECT ${contactCols},i.id issue_id FROM issues i JOIN contacts t ON t.app_id=i.app_id AND t.id=json_extract(i.author,'$.id') JOIN apps a ON a.id=i.app_id AND a.mode='helpdesk' WHERE i.app_id=? AND i.id IN (${targets})`,
    app,
    ...args
  )
}
export function proofQuery(env: Env, app: string, targets: string, ...args: unknown[]) {
  return sql(
    env,
    `SELECT ${proofCols} FROM email_codes v WHERE v.app_id=? AND v.kind='verification' AND v.issue_id IN (${targets}) ORDER BY v.created_at,v.id`,
    app,
    ...args
  )
}
export type ContactRow = Contact & { issue_id: string }
