import type { Actor, Contact, Verification } from "../shared/api"
import { sql } from "./core"
export const contactCols = "t.id,t.name,t.email,NULL external_id,'email' verified_via,t.created_at,t.last_seen_at"
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
