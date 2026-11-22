import type { FeedbackInfo } from "../shared/api"
import { sql } from "./core"

export type FeedbackRow = {
  anonymous: number
  email: string | null
  confirmed: number
  user: string | null
  app: string | null
  device: string | null
  install: string | null
  category: string | null
  screenshots: string
  metadata: string
  same_install: string
}
/** FeedbackInfo for one issue (by a SQL expression for its id); team and agents only. */
export const feedbackQuery = (env: Env, target: string, ...args: unknown[]) =>
  sql(
    env,
    `SELECT f.anonymous,f.email,f.user,f.app,f.device,f.install,f.category,f.screenshots,
    EXISTS(SELECT 1 FROM mail_subs s WHERE s.issue_id=f.issue_id AND s.address=f.email AND s.state='on') confirmed,
    (SELECT json_group_object(key,value) FROM feedback_meta WHERE issue_id=f.issue_id) metadata,
    (SELECT json_group_array(json_object('id',x.id,'number',x.number,'title',x.title,'status',x.status,'close_reason',x.close_reason)) FROM
      (SELECT i.id,i.number,i.title,i.status,i.close_reason FROM feedback g JOIN issues i ON i.id=g.issue_id AND i.app_id=g.app_id
       WHERE g.app_id=f.app_id AND g.install_hash=f.install_hash AND g.issue_id!=f.issue_id ORDER BY g.created_at DESC LIMIT 10) x) same_install
    FROM feedback f WHERE f.issue_id=(${target})`,
    ...args
  )
export function feedbackInfo(r: FeedbackRow | undefined | null): FeedbackInfo | null {
  if (!r) return null
  const parse = <T>(v: string | null) => (v ? (JSON.parse(v) as T) : null)
  return {
    anonymous: !!r.anonymous,
    email: r.email ? { address: r.email, confirmed: !!r.confirmed } : null,
    user: parse(r.user),
    app: parse(r.app),
    device: parse(r.device),
    install_id: r.install,
    metadata: JSON.parse(r.metadata),
    category: r.category,
    screenshot_ids: JSON.parse(r.screenshots),
    same_install: JSON.parse(r.same_install)
  }
}
export async function loadFeedback(env: Env, issue: string) {
  return feedbackInfo(await feedbackQuery(env, "?", issue).first<FeedbackRow>())
}
