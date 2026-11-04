import { entry } from "./audit"
import { sha256, sql, type Ctx } from "./core"
import { requireTeam } from "./permissions"

// Relational NDJSON keeps even a single very long thread streamable. Parent IDs
// are explicit and each issue is immediately followed by its child records.
type Row = Record<string, unknown> & { seq: number; num: number }
const size = 128
const sections = [
  [
    "app",
    `apps x`,
    `x.id=?1`,
    `x.id,x.slug,x.name,x.description,x.public,x.created_at,x.default_private,x.reporter_can_choose,x.nudge_days`
  ],
  ["label", "labels x", "x.app_id=?1", "x.id,x.name,x.color,x.description"],
  [
    "request_type",
    "request_types x",
    "x.app_id=?1",
    "x.id,x.name,x.description,x.fields,x.require_verification,x.route,x.autonomy,x.position,x.archived"
  ],
  [
    "template",
    "templates x",
    "x.app_id=?1",
    `x.id,x.name,x.description,x.title,x.body,x.ask_system_info,x.position,(SELECT json_group_array(label_id) FROM template_labels WHERE template_id=x.id) label_ids`
  ],
  [
    "tier",
    "tiers x",
    "x.app_id=?1",
    `x.id,x.name,x.color,x.description,x.position,x.assignee_id,x.force_private,x.agents_reply,(SELECT json_group_array(label_id) FROM tier_labels WHERE tier_id=x.id) label_ids`
  ],
  [
    "tier_assignment",
    "tier_assignments x",
    "x.app_id=?1",
    "x.actor_id,x.tier_id,(x.pending_email IS NOT NULL) pending"
  ],
  [
    "member",
    "members x LEFT JOIN users u ON u.id=x.user_id",
    "x.app_id=?1",
    "x.user_id id,x.email,u.name,x.role,1 joined"
  ],
  ["invitation", "workspace_invitations x", "x.app_id=?1", "x.id,x.email,x.role,0 joined"]
] as const
const children = [
  [
    "issue",
    "",
    "i",
    `i.id,i.title,i.body,i.status,i.close_reason,i.author,i.assignee,i.created_at,i.updated_at,i.edited_at,i.hidden,i.private,i.locked,i.pinned,i.template_id,i.mentions,i.system_info,i.github_repo,i.github_number,
    (SELECT json_group_array(label_id) FROM issue_labels WHERE issue_id=i.id) label_ids`
  ],
  [
    "comment",
    "JOIN comments x ON x.issue_id=i.id",
    "x",
    "x.id,x.author,x.body,x.created_at,x.updated_at,x.edited_at,x.internal,x.hidden,x.mentions,x.via"
  ],
  ["event", "JOIN issue_events x ON x.issue_id=i.id", "x", "x.id,x.type AS event_type,x.actor,x.data,x.created_at"],
  [
    "request_answers",
    "JOIN request_answers x ON x.issue_id=i.id AND x.app_id=i.app_id",
    "x",
    "x.type_id,x.answers,x.public_answers"
  ],
  [
    "tier_event",
    "JOIN tier_issue_events x ON x.issue_id=i.id AND x.app_id=i.app_id",
    "x",
    "x.id,x.type AS event_type,i.author actor,x.data,i.created_at"
  ],
  ["nudge", "JOIN nudge_events x ON x.issue_id=i.id", "x", "x.id,'nudged' event_type,x.created_at"],
  ["vote", "JOIN issue_votes x ON x.issue_id=i.id", "x", "x.voter"],
  [
    "helpful",
    "JOIN comments c ON c.issue_id=i.id JOIN comment_helpful x ON x.comment_id=c.id",
    "x",
    "x.comment_id,x.voter"
  ],
  ["relation", "JOIN relations x ON x.source_id=i.id", "x", "x.id,x.type AS relation_type,x.target_id"],
  [
    "attachment",
    "JOIN attachment_links x ON x.issue_id=i.id JOIN attachments a ON a.id=x.attachment_id",
    "x",
    "a.id,a.name,a.mime,a.size,a.kind,x.comment_id"
  ],
  [
    "metadata",
    "JOIN report_metadata x ON x.issue_id=i.id AND x.app_id=i.app_id AND x.ready=1",
    "x",
    "x.id,x.comment_id,x.title,x.message,x.source,x.system,x.context,x.fingerprint,x.created_at"
  ],
  [
    "log_attachment",
    "JOIN report_metadata m ON m.issue_id=i.id AND m.app_id=i.app_id AND m.ready=1 JOIN report_logs x ON x.metadata_id=m.id",
    "x",
    "x.id,x.name,x.size,x.metadata_id,m.comment_id"
  ]
] as const
type Section = (typeof children)[number]
// IDs and byte lengths first: 512 small records per D1 read, but never hundreds
// of maximum-sized bodies at once. One oversize row always makes progress.
const wide: Partial<Record<Section[0], string[]>> = {
  issue: ["i.body", "i.title", "i.system_info", "i.mentions"],
  comment: ["x.body", "x.mentions"],
  metadata: ["x.system", "x.context", "x.message"],
  request_answers: ["x.answers", "x.public_answers"]
}
async function* archive(c: Ctx) {
  const app = c.var.app.id,
    admin = c.var.user!.id,
    acl = `EXISTS(SELECT 1 FROM members WHERE app_id=?1 AND user_id=?2 AND role IN ('admin','owner'))`
  for (const [type, from, where, fields] of sections) {
    let seq = 0
    const limit = type === "request_type" ? 2 : size // Includes archived, potentially large definitions.
    for (;;) {
      const r = await sql(
        c.env,
        `SELECT x.rowid seq,${fields} FROM ${from} WHERE ${where} AND ${acl} AND x.rowid>?3 ORDER BY x.rowid LIMIT ${limit}`,
        app,
        admin,
        seq
      ).all<Row>()
      for (const { seq: key, ...data } of r.results) {
        seq = key
        if (data.label_ids) data.label_ids = JSON.parse(String(data.label_ids))
        if (type === "request_type") {
          data.fields = JSON.parse(String(data.fields))
          if (data.route) data.route = JSON.parse(String(data.route))
          data.archived = !!data.archived
          data.require_verification = !!data.require_verification
        }
        yield { type, data }
      }
      if (r.results.length < limit) break
    }
  }
  // Parallel cursors over indexed issue numbers, not a query per issue. Cap each
  // source independently so dense threads do not build an unbounded JSON array.
  const high = (await sql(c.env, "SELECT max(number) n FROM issues WHERE app_id=?", app).first<number>("n")) ?? 0
  async function* source([type, join, alias, fields]: Section) {
    let num = 0,
      seq = 0
    const window = `FROM issues i ${join} WHERE i.app_id=?1 AND ${acl} AND i.number BETWEEN ?3 AND ?4 AND (i.number,${alias}.rowid)>(?3,?5) ORDER BY i.number,${alias}.rowid LIMIT 512`,
      cols = wide[type]
    const query = cols
      ? `WITH keys AS MATERIALIZED (SELECT i.number num,${alias}.rowid seq,128+${cols.map((k) => `coalesce(octet_length(${k}),0)`).join("+")} bytes ${window}),
      budget AS (SELECT *,sum(bytes) OVER(ORDER BY num,seq ROWS UNBOUNDED PRECEDING)-bytes prior FROM keys)
      SELECT b.num,b.seq,i.id issue_id,${fields} FROM budget b JOIN issues i ON i.app_id=?1 AND i.number=b.num ${join}
      WHERE b.prior<524288 AND ${alias}.rowid=b.seq ORDER BY b.num,b.seq`
      : `SELECT i.number num,${alias}.rowid seq,i.id issue_id,${fields} ${window}`
    for (;;) {
      const r = await sql(c.env, query, app, admin, num, high, seq).all<Row>()
      for (const { num: n, seq: s, ...data } of r.results) {
        num = n
        seq = s
        for (const k of [
          "author",
          "assignee",
          "hidden",
          "data",
          "mentions",
          "label_ids",
          "system_info",
          "source",
          "system",
          "context",
          "actor",
          "answers",
          "public_answers"
        ])
          if (typeof data[k] === "string") data[k] = JSON.parse(data[k] as string)
        if (typeof data.voter === "string" && data.voter.startsWith("g:"))
          data.voter = "guest:" + (await sha256(`${app}:${data.voter}`)).slice(0, 32)
        if (type === "attachment" || type === "log_attachment")
          data.url =
            `/media/${data.id}/${encodeURIComponent(String(data.name))}` +
            (type === "log_attachment" ? `?metadata=${data.metadata_id}` : "")
        if (type === "issue") {
          data.imported = data.github_repo
            ? {
                source: "github",
                url: `https://github.com/${data.github_repo}/issues/${data.github_number}`,
                number: data.github_number
              }
            : null
          delete data.github_repo
          delete data.github_number
        }
        yield { type, number: n, data }
      }
      if (!r.results.length || (!cols && r.results.length < 512)) break
    }
  }
  const cursors = children.map(source),
    heads = await Promise.all(cursors.map((x) => x.next()))
  for (;;) {
    let at = -1,
      lowest = Infinity
    for (const [n, h] of heads.entries())
      if (!h.done && h.value.number < lowest) {
        lowest = h.value.number
        at = n
      }
    if (at < 0) break
    yield heads[at]!.value!
    heads[at] = await cursors[at]!.next()
  }
}
export async function exportWorkspace(c: Ctx) {
  requireTeam(c, "setup")
  await entry(
    c.env,
    c.var.app.id,
    c.var.actor,
    "app.exported",
    { type: "app", id: c.var.app.id },
    { format: "ndjson" },
    "1"
  ).run()
  const gen = archive(c),
    enc = new TextEncoder()
  return c.body(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        let text = ""
        for (let n = 0; n < 128 && text.length < 65536; n++) {
          const r = await gen.next()
          if (r.done) {
            if (text) controller.enqueue(enc.encode(text))
            controller.close()
            return
          }
          text += JSON.stringify(r.value) + "\n"
        }
        controller.enqueue(enc.encode(text))
      },
      async cancel() {
        await gen.return(undefined)
      }
    }),
    200,
    {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="${c.var.app.slug}.ndjson"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff"
    }
  )
}
