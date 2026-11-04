import { sql } from "../core"

// Called in the mint transaction after redeeming a same-browser OTP. The old
// actor comes only from an authenticated live session; never accept it as input.
export function claimAnonymous(env: Env, app: string, address: string, old: string) {
  const q = (statement: string) =>
      sql(
        env,
        `WITH target AS (SELECT id,json_object('type','guest','id',id,'name',name,'handle','contact-'||substr(id,4,8)) actor FROM contacts WHERE app_id=?1 AND email=?2) ${statement}`,
        app,
        address,
        old
      ),
    actor = "(SELECT actor FROM target)",
    id = "(SELECT id FROM target)",
    issues = "SELECT id FROM issues WHERE app_id=?1",
    own = "json_extract(author,'$.id')=?3"
  return [
    q(`UPDATE issues SET author=${actor},revision=revision+1 WHERE app_id=?1 AND ${own} RETURNING id`),
    q(`UPDATE comments SET author=${actor},revision=revision+1 WHERE issue_id IN(${issues}) AND ${own}`),
    ...["issue_events", "revisions"].map((t) =>
      q(`UPDATE ${t} SET actor=${actor} WHERE issue_id IN(${issues}) AND json_extract(actor,'$.id')=?3`)
    ),
    q(
      `UPDATE issues SET activity=json_set(activity,'$.actor',json(${actor})) WHERE app_id=?1 AND json_extract(activity,'$.actor.id')=?3`
    ),
    q(`UPDATE attachments SET owner_id=${id} WHERE app_id=?1 AND owner_id=?3`),
    q(
      `INSERT OR IGNORE INTO blocks SELECT lower(hex(randomblob(16))),app_id,${id},${actor},moderator,created_at FROM blocks WHERE app_id=?1 AND actor_id=?3`
    ),
    q(
      `INSERT OR IGNORE INTO tier_assignments(app_id,tier_id,actor_id) SELECT app_id,tier_id,${id} FROM tier_assignments WHERE app_id=?1 AND actor_id=?3`
    ),
    q(`DELETE FROM tier_assignments WHERE app_id=?1 AND actor_id=?3`),
    q(
      `INSERT OR IGNORE INTO mail_subs(issue_id,actor_id,address,state,reason,locale) SELECT issue_id,${id},address,state,'manual',locale FROM mail_subs WHERE issue_id IN(${issues}) AND actor_id=?3 AND address=?2 AND state IN ('on','off')`
    ),
    q(`DELETE FROM mail_subs WHERE issue_id IN(${issues}) AND actor_id=?3`),
    q(
      `INSERT INTO api_reads SELECT issue_id,${id},stamp,item FROM api_reads WHERE issue_id IN(${issues}) AND actor_id=?3 ON CONFLICT(issue_id,actor_id) DO UPDATE SET stamp=excluded.stamp,item=excluded.item WHERE (excluded.stamp,excluded.item)>(stamp,item)`
    ),
    q(`DELETE FROM api_reads WHERE issue_id IN(${issues}) AND actor_id=?3`),
    q(
      `UPDATE api_replays SET contact_id=${id} WHERE contact_id=?3 AND key_id IN(SELECT id FROM api_keys WHERE app_id=?1)`
    ),
    q("DELETE FROM guest_report_authors WHERE origin_app=?1 AND actor_id=?3")
  ]
}
