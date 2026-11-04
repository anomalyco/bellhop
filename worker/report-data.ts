import type { Attachment, IssueRef, ReportMetadata } from "../shared/api"
import { fail, missing, now, sql, str } from "./core"
import { actorIds, type Viewer } from "./visibility"

const members = `viewer AS (SELECT ? team,? ids)`
const owned = (actor: string) =>
  `json_extract(${actor},'$.id') IN (SELECT value FROM json_each((SELECT ids FROM viewer)))`
const team = "(SELECT team FROM viewer)"
const openIssue = `(${team} OR (i.hidden IS NULL AND (i.private=0 OR ${owned("i.author")})))`
const openComment = `(c.id IS NULL OR ${team} OR (c.internal=0 AND c.hidden IS NULL))`
const joins = `FROM report_metadata m LEFT JOIN issues i ON i.id=m.issue_id AND i.app_id=m.app_id LEFT JOIN comments c ON c.id=m.comment_id AND c.issue_id=i.id`
// Ownership is the author of the post that supplied the diagnostics. Opening the thread
// does not grant access to someone else's diagnostic comment, nor override note visibility.
const allowed = `m.ready=1 AND (m.issue_id IS NULL OR (i.id IS NOT NULL AND (m.comment_id IS NULL OR c.id IS NOT NULL) AND ${openIssue} AND ${openComment} AND (${team} OR ${owned("coalesce(c.author,i.author)")})))`
type Row = Omit<ReportMetadata, "source" | "system" | "context" | "logs" | "matches" | "attached_to"> & {
  source: string | null
  system: string
  context: string
  logs: string
  matches: string
  number: number | null
  comment_id: string | null
}
const projection = `m.id,m.title,m.message,m.source,m.system,m.context,m.fingerprint,m.created_at,m.expires_at,i.number,m.comment_id,
  (SELECT json_group_array(json_object('id',l.id,'name',l.name,'size',l.size) ORDER BY l.rowid) FROM report_logs l WHERE l.metadata_id=m.id) logs,
  (SELECT json_group_array(json_object('id',x.id,'number',x.number,'title',x.title,'status',x.status,'close_reason',x.close_reason)) FROM
    (SELECT DISTINCT i.id,i.number,i.title,i.status,i.close_reason,i.updated_at FROM report_metadata other JOIN issues i ON i.id=other.issue_id AND i.app_id=other.app_id
     LEFT JOIN comments c ON c.id=other.comment_id WHERE other.app_id=m.app_id AND other.fingerprint=m.fingerprint AND other.issue_id IS NOT NULL
     AND i.id IS NOT m.issue_id AND i.status!='closed' AND ${openIssue} AND ${openComment} ORDER BY i.updated_at DESC,i.id LIMIT 20) x) matches`
export function reportQuery(
  env: Env,
  app: string,
  v: Viewer,
  by: "issue" | "id",
  value: number | string,
  parents?: (string | null)[]
) {
  return sql(
    env,
    `WITH ${members} SELECT ${projection} ${joins} WHERE m.app_id=? AND ${by === "issue" ? "m.issue_id=(SELECT id FROM issues WHERE app_id=? AND number=?)" : "m.id=?"} AND ${allowed}
     ${parents ? "AND ((m.comment_id IS NULL AND ?) OR m.comment_id IN(SELECT value FROM json_each(?)))" : ""} ORDER BY m.created_at,m.id`,
    Number(v.team),
    JSON.stringify(actorIds(v)),
    app,
    ...(by === "issue" ? [app] : []),
    value,
    ...(parents ? [Number(parents.includes(null)), JSON.stringify(parents.filter(Boolean))] : [])
  )
}
export type ReportRow = Row
export function logAttachment(l: Pick<Attachment, "id" | "name" | "size">, metadata: string): Attachment {
  return {
    id: l.id,
    name: l.name,
    size: l.size,
    kind: "file",
    mime: "text/plain",
    url: `/media/${l.id}/${encodeURIComponent(l.name)}?metadata=${metadata}`
  }
}
export function decodeReport(r: Row): ReportMetadata {
  const { number, comment_id, ...rest } = r
  return {
    ...rest,
    source: r.source ? JSON.parse(r.source) : null,
    system: JSON.parse(r.system),
    context: JSON.parse(r.context),
    attached_to: number === null ? null : { number, comment_id },
    logs: (JSON.parse(r.logs) as Pick<Attachment, "id" | "name" | "size">[]).map((l) => logAttachment(l, r.id)),
    matches: JSON.parse(r.matches) as IssueRef[]
  }
}
export async function getReport(env: Env, app: string, id: string, v: Viewer) {
  const row = await reportQuery(env, app, v, "id", id).first<Row>()
  if (row) {
    if (row.expires_at && row.expires_at <= now()) fail(410, "expired", "Report metadata expired")
    return decodeReport(row)
  }
  if (await sql(env, "SELECT 1 FROM expired_reports WHERE app_id=? AND id=?", app, id).first())
    fail(410, "expired", "Report metadata expired")
  missing()
}
export function attachReport(env: Env, app: string, input: unknown, issue: string, comment: string | null) {
  if (input === undefined) return []
  const id = str(input, "metadata_id", 80)
  return [
    sql(env, "INSERT INTO pending_report(id,app_id) VALUES(?,?)", id, app),
    sql(
      env,
      "UPDATE report_metadata SET issue_id=?,comment_id=?,expires_at=NULL WHERE id=? AND app_id=?",
      issue,
      comment,
      id,
      app
    ),
    ...(comment
      ? []
      : [
          sql(
            env,
            `UPDATE issues SET system_info=coalesce((SELECT system FROM report_metadata WHERE id=? AND system!='{}'),system_info) WHERE id=? AND (system_info IS NULL OR system_info='{}')`,
            id,
            issue
          )
        ])
  ]
}
export async function reportLog(env: Env, id: string, app: string, v: Viewer, capability: string | undefined) {
  return sql(
    env,
    `WITH ${members} SELECT l.name,l.size,l.object_key ${joins} JOIN report_logs l ON l.metadata_id=m.id WHERE l.id=? AND m.app_id=? AND ${allowed}
    AND (m.expires_at IS NULL OR m.expires_at>?) AND (m.issue_id IS NOT NULL OR ${team} OR m.id=?)`,
    Number(v.team),
    JSON.stringify(actorIds(v)),
    id,
    app,
    now(),
    capability ?? null
  ).first<{ name: string; size: number; object_key: string }>()
}
export async function purgeReportObjects(env: Env, keys: string[]) {
  if (!keys.length) return
  await env.MEDIA.delete(keys)
  await sql(
    env,
    "DELETE FROM report_log_gc WHERE object_key IN(SELECT value FROM json_each(?))",
    JSON.stringify(keys)
  ).run()
}
export async function expireReports(env: Env) {
  await sql(
    env,
    "DELETE FROM report_metadata WHERE id IN(SELECT id FROM report_metadata WHERE expires_at<=? ORDER BY expires_at LIMIT 100)",
    now()
  ).run()
  const gc = await sql(env, "SELECT object_key FROM report_log_gc LIMIT 500").all<{ object_key: string }>()
  await purgeReportObjects(
    env,
    gc.results.map((r) => r.object_key)
  )
}
