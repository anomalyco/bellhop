import MarkdownIt from "markdown-it"
import { DEFAULT_WEBHOOK_EVENTS, LOCALES } from "../shared/api"
import { toolRoles, tools } from "./mcp"
import { reportLimits } from "./reports"
import { webhookEvents } from "./webhooks"
import index from "../docs/index.md?raw"
import reports from "../docs/reports.md?raw"
import mcp from "../docs/mcp.md?raw"
import webhooks from "../docs/webhooks.md?raw"
import feeds from "../docs/feeds.md?raw"
import production from "virtual:bellhop-production-config"

// The public developer docs. Pages are Markdown in docs/; anything that can drift from the code
// (limits, the MCP tool list, webhook events) is a {{placeholder}} filled from the source of truth.

const migrations = import.meta.glob<string>("../migrations/*.sql", { query: "?raw", import: "default", eager: true })

export type DocPage = {
  slug: string
  path: string
  title: string
  nav: string
  description: string
  markdown: string
  html: string
  headings: { id: string; text: string }[]
}

function fail(message: string): never {
  throw new Error(`docs: ${message}`)
}

function rate(name: string) {
  const r = production.ratelimits.find((x) => x.name === name) ?? fail(`no rate limit ${name}`)
  const { limit, period } = r.simple
  const per = period === 60 ? "minute" : period === 3600 ? "hour" : `${period} seconds`
  return `${limit} per ${per}`
}
function bytes(n: number) {
  if (n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}\u00a0MiB`
  if (n % 1024 === 0) return `${n / 1024}\u00a0KiB`
  return `${n} bytes`
}
/** The last migration (by file name) whose text matches wins: later migrations replace triggers and checks. */
function fromMigrations(pattern: RegExp, what: string) {
  let found: RegExpExecArray | null = null
  for (const name of Object.keys(migrations).sort()) found = pattern.exec(migrations[name]!) ?? found
  return found ?? fail(`no ${what} in migrations`)
}
const daily = fromMigrations(/report_daily_limit CHECK\(uploads<=(\d+) AND bytes<=(\d+)\)/, "report daily limit")
const commentsTrigger = fromMigrations(
  /CREATE TRIGGER comments_rate_limit[\s\S]*?'-1 hour'\)\)>=(\d+)\s+BEGIN/,
  "comments rate limit"
)
const webhookRetries =
  production.queues.consumers.find((q) => q.queue === "bellhop-webhooks")?.max_retries ?? fail("no webhook queue")
// worker/webhooks.ts retries with delaySeconds 2 ** (attempts - 1).
const backoff = Array.from({ length: webhookRetries }, (_, i) => String(2 ** i))
const list = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`

const values: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(reportLimits).map(([k, v]) => [
      `report.${k}`,
      ["request", "log", "sections"].includes(k) ? bytes(v) : String(v)
    ])
  ),
  "report.dailyUploads": daily[1]!,
  "report.dailyBytes": bytes(Number(daily[2])),
  "mcp.commentsPerHour": commentsTrigger[1]!,
  "webhook.retries": String(webhookRetries),
  "webhook.backoff": `${list(backoff)} seconds`,
  locales: LOCALES.map((l) => `\`${l}\``).join(", ")
}

// What each tool returns. Kept next to the generated table, and checked for completeness.
const returns: Record<keyof typeof toolRoles, string> = {
  list_apps: "Each workspace's `slug`, `name` and the agent's `role` there.",
  create_app: "The new workspace.",
  get_app: "The workspace: details, counts, labels and templates, and the agent's role.",
  list_issues: "`issues`, `pinned`, `counts` and `next_cursor`.",
  search_issues: "The same shape as `list_issues`, across open and closed issues.",
  get_issue: "The issue with its timeline, internal notes, attachments, relations and metadata summaries.",
  get_attachment: "A log's text, an image as `image` content, or a URL for anything else.",
  get_metadata: "The report metadata: specs, context, logs and fingerprint matches.",
  list_labels: "The labels.",
  list_templates: "The templates, with label names.",
  list_saved_replies: "The saved replies.",
  list_tiers: "The tiers and their rules.",
  list_mentionables: "Members and agents with their `@handles`.",
  comment: "The new comment.",
  edit_comment: "The updated comment.",
  set_activity: "`{ ok: true }`.",
  update_issue: "The updated issue.",
  claim_issue: "The updated issue.",
  relate_issues: "The updated issue.",
  moderate: "The updated issue or comment.",
  transfer_issue: "The issue in its new workspace.",
  set_tier: "The reporter's new tier.",
  get_analytics: "Response, resolution and agent metrics for the period.",
  get_contact: "The help desk contact (verified email, external id, how they verified) with their requests.",
  list_request_types: "The workspace’s request types, field definitions and team routing settings.",
  set_request_type: "The updated request with its validated answers and effective autonomy.",
  request_verification: "The new verification, `pending` until the requester enters the code.",
  update_app: "The updated workspace.",
  get_webhook: "`url`, `has_secret`, `events` and recent `deliveries`.",
  set_webhook: "`url` and `events`.",
  redeliver_webhook: "`{ delivery_id }` of the new delivery.",
  rotate_webhook_secret: "`{ secret }`, shown once.",
  test_webhook: "`{ delivery_id }` of the ping.",
  create_label: "The new label.",
  update_label: "The updated label.",
  delete_label: "`{ ok: true }`.",
  create_template: "The new template.",
  update_template: "The updated template.",
  delete_template: "`{ ok: true }`.",
  list_members: "Members and pending invitations.",
  invite_member: "`{ ok: true }`.",
  set_member_role: "`{ ok: true }`.",
  remove_member: "`{ ok: true }`."
}
const roleGroups = [
  ["discover", "Any agent"],
  ["read", "Viewer"],
  ["respond", "Responder"],
  ["triage", "Member"],
  ["setup", "Admin"],
  ["create", "Allowed to create workspaces"]
] as const
type Schema = { type?: string | string[]; enum?: unknown[]; items?: { enum?: unknown[] } }
function argument(name: string, schema: Schema, required: boolean) {
  const options = schema.enum ?? schema.items?.enum
  const types = [schema.type ?? []].flat().filter((t) => t !== "string")
  const detail = options
    ? `${schema.type === "array" ? "array of " : ""}${options.map((o) => `\`${String(o)}\``).join(", ")}`
    : types.join(" or ")
  return `\`${name}\`${required ? "\\*" : ""}${detail ? ` (${detail})` : ""}`
}
function toolTable() {
  const missing = tools.filter((t) => !returns[t.name])
  if (missing.length) fail(`no "returns" for ${missing.map((t) => t.name).join(", ")}`)
  return roleGroups
    .map(([role, heading]) => {
      const group = tools.filter((t) => toolRoles[t.name] === role)
      if (!group.length) return ""
      const entries = group.map((t) => {
        const props = t.inputSchema.properties as Record<string, Schema>
        const args = Object.entries(props)
          .filter(([k]) => k !== "app")
          .map(([k, s]) => argument(k, s, t.inputSchema.required.includes(k)))
        const ret = returns[t.name].replace(/^[A-Z]/, (l) => l.toLowerCase())
        return `#### \`${t.name}\`\n\n${t.description} Returns ${ret}\n\n${args.length ? `Arguments: ${args.join(", ")}` : "No arguments."}\n`
      })
      return `### ${heading}\n\n${entries.join("\n")}`
    })
    .filter(Boolean)
    .join("\n")
}

// Only events in webhookEvents (what Settings offers and the Worker sends) render.
const eventNotes: Record<string, string> = {
  ping: "**Send test** was pressed. Always delivered, whatever is selected.",
  "issue.opened": "An issue was opened.",
  "issue.updated": "Anything about an issue changed. `changes` lists what.",
  "issue.closed": "An issue was closed. `issue.close_reason` says why.",
  "issue.reopened": "A closed issue was reopened.",
  "issue.labeled": "A label was added. The label is in `label`.",
  "issue.unlabeled": "A label was removed. The label is in `label`.",
  "issue.assigned": "The assignee changed. `issue.assignee` is `null` when it was cleared.",
  "issue.deleted": "An issue was deleted.",
  "issue.moved": "An issue was moved to another workspace. `moved_to` says where.",
  "comment.created": "A comment or internal note was posted, not by an agent.",
  "comment.edited": "A comment was edited, not by an agent.",
  "comment.deleted": "A comment was deleted.",
  "mention.created": "Someone @mentioned a team member or an agent.",
  "verification.completed":
    "An email verification on a request finished. `verification` says whether it was verified, failed or expired."
}
function eventTable() {
  // A newly added event shouldn't take the docs down; it shows up undescribed and is logged.
  const missing = webhookEvents.filter((e) => !eventNotes[e])
  if (missing.length) console.error("bellhop.docs_event_undescribed", { events: missing })
  const rows = webhookEvents.map(
    (e) =>
      `| \`${e}\` | ${e === "ping" ? "Always" : DEFAULT_WEBHOOK_EVENTS.includes(e) ? "Yes" : "No"} | ${eventNotes[e] ?? ""} |`
  )
  return `| Event | Default | When |\n| --- | --- | --- |\n${rows.join("\n")}`
}
const tables: Record<string, () => string> = { "mcp-tools": toolTable, "webhook-events": eventTable }

function expand(source: string) {
  const out = source
    .replace(/^\{\{table:([a-z-]+)\}\}$/gm, (_, name: string) => (tables[name] ?? fail(`unknown table ${name}`))())
    .replace(/\{\{rate:([A-Z_]+)\}\}/g, (_, name: string) => rate(name))
    .replace(/\{\{([a-zA-Z.]+)\}\}/g, (_, key: string) => values[key] ?? fail(`unknown placeholder ${key}`))
  if (out.includes("{{")) fail(`unexpanded placeholder near ${out.slice(out.indexOf("{{"), out.indexOf("{{") + 40)}`)
  return out
}

function frontmatter(source: string) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(source) ?? fail("missing frontmatter")
  const meta = Object.fromEntries(
    m[1]!.split("\n").map((line) => {
      const i = line.indexOf(":")
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()]
    })
  )
  for (const k of ["title", "nav", "description"]) if (!meta[k]) fail(`missing ${k}`)
  return { meta: meta as { title: string; nav: string; description: string }, body: source.slice(m[0].length) }
}

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9_\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")

function renderer() {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false })
  const escape = md.utils.escapeHtml
  md.core.ruler.push("heading_ids", (state) => {
    const used = new Set<string>()
    const tokens = state.tokens
    tokens.forEach((t, i) => {
      if (t.type !== "heading_open") return
      const text = tokens[i + 1]?.content ?? ""
      let id = slugify(text) || "section",
        n = 1
      while (used.has(id)) id = `${slugify(text)}-${++n}`
      used.add(id)
      t.attrSet("id", id)
    })
  })
  md.renderer.rules.fence = (tokens, i) => {
    const t = tokens[i]!
    const lang = t.info.trim().split(/\s+/)[0] ?? ""
    const cls = lang ? ` class="language-${escape(lang)}"` : ""
    // The header row is always there, so the copy button (shown by JavaScript) moves nothing.
    return `<div class="code-block"><div class="code-head"><span>${escape(lang)}</span><button type="button" class="copy" hidden>Copy</button></div><pre tabindex="0"><code${cls}>${escape(t.content)}</code></pre></div>\n`
  }
  md.renderer.rules.table_open = () => `<div class="table-wrap" tabindex="0"><table>\n`
  md.renderer.rules.table_close = () => `</table></div>\n`
  return md
}

const sources: [string, string][] = [
  ["index", index],
  ["reports", reports],
  ["mcp", mcp],
  ["webhooks", webhooks],
  ["feeds", feeds]
]

let built: DocPage[] | null = null
/** Every page, built once per isolate. Throws if a placeholder or generated table can't be filled. */
export function docPages(): DocPage[] {
  if (built) return built
  const md = renderer()
  const pages = sources.map(([slug, source]) => {
    const { meta, body } = frontmatter(source)
    const markdown = expand(body)
    const env = {}
    const tokens = md.parse(markdown, env)
    const headings = tokens.flatMap((t, i) =>
      t.type === "heading_open" && t.tag === "h2"
        ? [{ id: String(t.attrGet("id") ?? ""), text: (tokens[i + 1]?.content ?? "").replace(/`/g, "") }]
        : []
    )
    return {
      slug,
      path: slug === "index" ? "/docs" : `/docs/${slug}`,
      ...meta,
      markdown,
      html: md.renderer.render(tokens, md.options, env),
      headings
    }
  })
  built = pages
  return pages
}
