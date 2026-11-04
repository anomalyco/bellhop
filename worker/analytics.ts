import type { Analytics } from "../shared/api"
import { bad, sql, type Ctx } from "./core"

// Use the role saved on the post, not the author's membership today. Only legacy
// member actors with no role field need the roster fallback; explicit null means outsider.
const responder = `CASE json_extract(c.author,'$.type') WHEN 'agent' THEN 'agent' WHEN 'member' THEN
  CASE WHEN json_extract(c.author,'$.role') IN ('viewer','member','admin','owner') OR
    (json_type(c.author,'$.role') IS NULL AND EXISTS(SELECT 1 FROM members m WHERE m.app_id=?1 AND m.user_id=json_extract(c.author,'$.id')))
  THEN 'human' END END`
const inWindow = `i.app_id=?1 AND i.created_at BETWEEN ?2 AND ?3`
const publicReply = `c.internal=0 AND c.hidden IS NULL AND c.created_at>=i.created_at`

// Only aggregates cross the D1 boundary. Separate comment, helpful-mark and status
// aggregation prevents fan-out (e.g. three marks are still just one response).
const metrics = `WITH cohort AS MATERIALIZED (
  SELECT i.id,i.created_at,i.status,i.close_reason,t.name tier FROM issues i
  LEFT JOIN tier_assignments a ON a.app_id=i.app_id AND a.actor_id=json_extract(i.author,'$.id')
  LEFT JOIN tiers t ON t.id=a.tier_id WHERE ${inWindow}
), public_team AS (
  SELECT i.id,c.created_at,${responder} kind,
    (SELECT count(*) FROM comment_helpful h WHERE h.comment_id=c.id) marks,
    row_number() OVER(PARTITION BY i.id ORDER BY c.created_at,c.rowid) seq
  FROM cohort i CROSS JOIN comments c WHERE c.issue_id=i.id AND ${publicReply} AND (${responder}) IS NOT NULL
), replies AS (
  SELECT id,min(created_at) first_at,max(kind='agent') FILTER(WHERE seq=1) first_agent,
    count(*) FILTER(WHERE kind='agent') agents,count(*) FILTER(WHERE kind='human') humans,
    sum(marks) FILTER(WHERE kind='agent') agent_marks,sum(marks) FILTER(WHERE kind='human') human_marks
  FROM public_team GROUP BY id
), transitions AS (
  SELECT i.id,max(e.created_at) FILTER(WHERE json_extract(e.data,'$.to')='closed' AND json_extract(e.data,'$.from')!='closed') closed_at,
    max(json_extract(e.data,'$.from')='closed' AND json_extract(e.data,'$.to')!='closed') reopened
  FROM cohort i CROSS JOIN issue_events e WHERE e.issue_id=i.id AND e.type='status_changed' GROUP BY i.id
), facts AS MATERIALIZED (
  SELECT substr(i.created_at,1,10) day,i.tier,i.status='closed' closed,i.close_reason,
    CASE WHEN i.status='closed' THEN e.closed_at END closed_at,coalesce(e.reopened,0) reopened,
    round((julianday(r.first_at)-julianday(i.created_at))*86400,3) response_s,
    CASE WHEN i.close_reason IN ('completed','not_planned') AND i.status='closed' THEN
      round((julianday(e.closed_at)-julianday(i.created_at))*86400,3) END resolution_s,
    r.first_agent,r.agents,r.humans,r.agent_marks,r.human_marks
  FROM cohort i LEFT JOIN replies r USING(id) LEFT JOIN transitions e USING(id)
), samples(metric,bucket,s) AS (
  SELECT 'response','',response_s FROM facts WHERE response_s IS NOT NULL UNION ALL
  SELECT 'resolution','',resolution_s FROM facts WHERE resolution_s IS NOT NULL UNION ALL
  SELECT 'day',day,response_s FROM facts WHERE response_s IS NOT NULL UNION ALL
  SELECT 'tier',tier,response_s FROM facts WHERE response_s IS NOT NULL AND tier IS NOT NULL
), ranked AS (
  SELECT metric,bucket,s,row_number() OVER w pos,count(*) OVER (w ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) n
  FROM samples WINDOW w AS (PARTITION BY metric,bucket ORDER BY s)
), quantiles AS MATERIALIZED (
  SELECT metric,bucket,avg(s) FILTER(WHERE pos IN ((n+1)/2,(n+2)/2)) median,
    max(s) FILTER(WHERE pos=(9*n+9)/10) p90 FROM ranked GROUP BY metric,bucket
), days AS (SELECT day,count(*) opened FROM facts GROUP BY day),
  closures AS (SELECT substr(closed_at,1,10) day,count(*) closed FROM facts WHERE closed_at IS NOT NULL GROUP BY 1),
  dates AS (SELECT day FROM days UNION SELECT day FROM closures),
  tier_totals AS (SELECT tier,count(*) opened FROM facts WHERE tier IS NOT NULL GROUP BY tier)
SELECT count(*) opened,count(*) FILTER(WHERE closed) closed,
  avg(first_agent) by_agent_share,avg(reopened) reopened_share,
  1.0*count(*) FILTER(WHERE closed AND close_reason='completed' AND agents>0 AND humans=0 AND reopened=0) /
    nullif(count(*) FILTER(WHERE closed AND close_reason IN ('completed','not_planned')),0) agent_resolved_share,
  1.0*sum(agent_marks)/sum(agents) helpful_agent,1.0*sum(human_marks)/sum(humans) helpful_human,
  (SELECT median FROM quantiles WHERE metric='response') response_median,(SELECT p90 FROM quantiles WHERE metric='response') response_p90,
  (SELECT median FROM quantiles WHERE metric='resolution') resolution_median,(SELECT p90 FROM quantiles WHERE metric='resolution') resolution_p90,
  (SELECT json_group_array(json_object('date',d.day,'opened',coalesce(o.opened,0),'closed',coalesce(c.closed,0),'first_response_median',q.median))
   FROM dates d LEFT JOIN days o USING(day) LEFT JOIN closures c USING(day) LEFT JOIN quantiles q ON q.metric='day' AND q.bucket=d.day) daily,
  (SELECT json_group_array(json_object('tier',t.tier,'opened',t.opened,'first_response_median',q.median) ORDER BY t.opened DESC,t.tier)
   FROM tier_totals t LEFT JOIN quantiles q ON q.metric='tier' AND q.bucket=t.tier) by_tier FROM facts`

// Backlog is a snapshot, independent of the opening window. A public follow-up by
// the reporter puts the issue back in the team's queue, even if the reporter is staff.
const waiting = `SELECT count(*) n FROM issues i WHERE i.app_id=?1 AND i.status IN ('open','in_progress','waiting') AND coalesce((
  SELECT json_extract(c.author,'$.id')=json_extract(i.author,'$.id') OR (${responder}) IS NULL FROM comments c
  WHERE c.issue_id=i.id AND ${publicReply} ORDER BY c.created_at DESC,c.rowid DESC LIMIT 1),1)`
const labels = `SELECT l.name label,count(*) opened FROM issues i CROSS JOIN issue_labels il JOIN labels l ON l.id=il.label_id
  WHERE ${inWindow} AND il.issue_id=i.id AND l.app_id=i.app_id GROUP BY l.id ORDER BY opened DESC,l.name`

type Summary = Pick<Analytics, "opened" | "closed" | "agent_resolved_share" | "reopened_share"> & {
  by_agent_share: number | null
  response_median: number | null
  response_p90: number | null
  resolution_median: number | null
  resolution_p90: number | null
  helpful_agent: number | null
  helpful_human: number | null
  daily: string
  by_tier: string
}

export async function analytics(c: Ctx, app: string, days: number): Promise<Analytics> {
  if (days !== 7 && days !== 30 && days !== 90) bad("days must be 7, 30 or 90")
  const now = new Date().toISOString(),
    today = Date.parse(now.slice(0, 10)),
    dayMs = 86400000,
    start = today - (days - 1) * dayMs,
    origin = c.env.PUBLIC_ORIGIN || (c.env.APP_DOMAIN ? `https://${c.env.APP_DOMAIN}` : c.req.url),
    key = new Request(
      new URL(`/.bellhop-cache/analytics/${encodeURIComponent(app)}/${days}/${now.slice(0, 10)}`, origin)
    ),
    cache = await caches.open("bellhop-analytics-v1"),
    hit = await cache.match(key)
  if (hit) return hit.json<Analytics>()
  const args = [app, new Date(start).toISOString(), now],
    [aggregate, backlog, breakdown] = await c.env.DB.batch([
      sql(c.env, metrics, ...args),
      sql(c.env, waiting, app),
      sql(c.env, labels, ...args)
    ])
  const row = aggregate!.results[0] as Summary,
    dates = new Map((JSON.parse(row.daily) as Analytics["daily"]).map((d) => [d.date, d])),
    result: Analytics = {
      days,
      opened: row.opened,
      closed: row.closed,
      first_response: { median: row.response_median, p90: row.response_p90, by_agent_share: row.by_agent_share },
      resolution: { median: row.resolution_median, p90: row.resolution_p90 },
      agent_resolved_share: row.agent_resolved_share,
      reopened_share: row.reopened_share,
      helpful_per_reply: { agent: row.helpful_agent, human: row.helpful_human },
      waiting_on_team: (backlog!.results[0] as { n: number }).n,
      daily: Array.from({ length: days }, (_, i) => {
        const date = new Date(start + i * dayMs).toISOString().slice(0, 10)
        return dates.get(date) ?? { date, opened: 0, closed: 0, first_response_median: null }
      }),
      by_tier: JSON.parse(row.by_tier),
      by_label: breakdown!.results as Analytics["by_label"]
    }
  // Internal cache only. Both transports authenticate/authorize before looking here;
  // never put a session cookie on this entry or return a publicly cacheable API response.
  c.executionCtx.waitUntil(cache.put(key, Response.json(result, { headers: { "Cache-Control": "max-age=60" } })))
  return result
}
