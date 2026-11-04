import MarkdownIt from "markdown-it"
import { DEFAULT_WEBHOOK_EVENTS, LOCALES } from "../shared/api"
import { toolRoles, tools } from "./mcp"
import { reportLimits } from "./reports"
import { webhookEvents } from "./webhooks"
import { routes } from "./v1"
import { uploadSpec } from "./media"
import { contactTTL } from "./contact-session"
import uploadsSource from "./v1/uploads.ts?raw"
import sessionsSource from "./v1/sessions.ts?raw"
import replaySource from "./v1/replay.ts?raw"
import signedMediaSource from "./v1/signed-media.ts?raw"
import realtimeSource from "./v1/realtime.ts?raw"
import index from "../docs/index.md?raw"
import reports from "../docs/reports.md?raw"
import mcp from "../docs/mcp.md?raw"
import webhooks from "../docs/webhooks.md?raw"
import feeds from "../docs/feeds.md?raw"
import publicApi from "../docs/api.md?raw"
import widget from "../docs/widget.md?raw"
import identity from "../docs/identity.md?raw"
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
  if (n % (1024 * 1024 * 1024) === 0) return `${n / (1024 * 1024 * 1024)}\u00a0GiB`
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
// Public API v1 limits, read from the code that enforces them.
const sourceMatch = (source: string, pattern: RegExp, what: string) => pattern.exec(source) ?? fail(`no ${what}`)
const sessionLife = sourceMatch(sessionsSource, /min\(unixepoch\(\)\+(\d+),born\+(\d+)\)/, "session lifetime")
const uploadDaily = fromMigrations(
  /NEW\.scope!='workspace' THEN (\d+) WHEN \(SELECT trusted FROM apps WHERE id=NEW\.app_id\) THEN (\d+) ELSE (\d+) END/,
  "upload byte quota"
)
const replayTtl = sourceMatch(replaySource, /response\.status < 500 \? (\d+) : (\d+)/, "replay lifetimes")
const duration = (seconds: number) => {
  const unit = (n: number, word: string) => `${n}\u00a0${word}${n === 1 ? "" : "s"}`
  if (seconds % 86400 === 0 && seconds > 86400) return unit(seconds / 86400, "day")
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour")
  if (seconds % 60 === 0) return unit(seconds / 60, "minute")
  return unit(seconds, "second")
}
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
  locales: LOCALES.map((l) => `\`${l}\``).join(", "),
  "v1.session": duration(Number(sessionLife[1])),
  "v1.sessionCap": duration(Number(sessionLife[2])),
  "v1.uploadImage": bytes(uploadSpec("a.png", "image/png").limit),
  "v1.uploadVideo": bytes(uploadSpec("a.mp4", "video/mp4").limit),
  "v1.uploadFile": bytes(uploadSpec("a.pdf", "application/pdf").limit),
  "v1.uploadsPerHour": String(
    Number(sourceMatch(uploadsSource, /-1 hour'\)[^`]*LIMIT 1 OFFSET (\d+)/, "hourly uploads")[1]) + 1
  ),
  "v1.uploadContactDaily": bytes(Number(uploadDaily[1])),
  "v1.uploadWorkspaceDaily": bytes(Number(uploadDaily[3])),
  "v1.replaySuccess": duration(Number(replayTtl[2])),
  "v1.replayClientError": duration(Number(replayTtl[1])),
  "v1.mediaTtl": duration(Number(sourceMatch(signedMediaSource, /ttl = (\d+)/, "signed media lifetime")[1])),
  "identity.session": duration(contactTTL),
  "v1.ticketTtl": duration(
    Number(sourceMatch(realtimeSource, /Date\.now\(\) \/ 1000\) \+ (\d+)/, "ticket lifetime")[1])
  )
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
  request_approval: "A pending, team-only action approval.",
  get_approval: "The approval; a live signed token is included only for the agent that requested it.",
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
  const all = [schema.type ?? []].flat()
  // Strings are the default and go unsaid, unless the argument can also be something else ("string or null").
  const types = all.length > 1 ? all : all.filter((t) => t !== "string")
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
// The public API v1 reference, from the OpenAPI document GET /v1/openapi.json serves (built from the same route
// table the API dispatches with). Only the one-line summaries are written here; a route without one still renders.
type Api = {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, JsonSchema>; securitySchemes: Record<string, { bearerFormat?: string }> }
}
type Operation = {
  operationId: string
  description?: string
  security: Record<string, string[]>[]
  parameters: { in: string; name: string; required: boolean; schema: JsonSchema }[]
  requestBody?: { content: Record<string, { schema: JsonSchema }> }
  responses: Record<string, { description: string; content?: Record<string, { schema: JsonSchema }>; "x-websocket-frame"?: JsonSchema }>
}
type JsonSchema = {
  $ref?: string
  type?: string
  format?: string
  enum?: unknown[]
  const?: unknown
  items?: JsonSchema
  properties?: Record<string, JsonSchema>
  required?: string[]
  anyOf?: JsonSchema[]
  oneOf?: JsonSchema[]
  allOf?: JsonSchema[]
  additionalProperties?: JsonSchema
  description?: string
  maxLength?: number
  minimum?: number
  maximum?: number
  pattern?: string
}
const api = () => ((routes.openapi ?? fail("no openapi route")).run as unknown as () => Api)()
const operations: Record<string, [group: string, title: string, summary: string]> = {
  createSession: ["Sessions", "Start a session", "With a secret key, for a user your server vouches for. With a publishable key, from an identity token or anonymously (where the workspace allows it)."],
  startEmail: ["Sessions", "Send an email sign-in code", "Needs a Turnstile token, so it works only where the workspace's human check runs. Returns `Challenge-Token`; keep it in this browser."],
  verifyEmail: ["Sessions", "Sign in with the email code", "Send the code with the same `Challenge-Token`. With an anonymous session's bearer, its conversations move to the verified contact and that session ends."],
  refreshSession: ["Sessions", "Refresh a session", "A new token for up to {{v1.session}} more, at most {{v1.sessionCap}} after the first sign-in. The old token and its sockets stop working."],
  revokeSession: ["Sessions", "Sign out", "Ends the session and closes its sockets."],
  workspace: ["Sessions", "Get the workspace", "The name and icon to show, and which sign-ins this origin offers."],
  getMe: ["Sessions", "Get the user", "The person this session belongs to."],
  updateMe: ["Sessions", "Update the user", "Their display name and language."],
  listConversations: ["Conversations", "List conversations", "A session gets the user's own, newest activity first. A secret key gets the workspace's, filtered by `status`, `contact_id` or `q`."],
  createConversation: ["Conversations", "Start a conversation", "With its first message. A secret key opens it for a `contact`."],
  getConversation: ["Conversations", "Get a conversation", ""],
  listItems: ["Conversations", "List messages and events", "Oldest first by default; `after` catches up. `last` opens at the newest items and `before` pages back from an item."],
  postMessage: ["Conversations", "Send a message", "Markdown, with upload ids in `attachments`. A secret key replies `as` a team member."],
  markRead: ["Conversations", "Mark as read", "Everything up to `item_id`."],
  typing: ["Conversations", "Show typing", "The team sees the user typing for a few seconds."],
  confirmVerification: ["Conversations", "Confirm an email verification", "The code the team's verification request sent to an address."],
  upload: ["Uploads and realtime", "Upload a file", "`multipart/form-data` with one part named `file`. Attach the returned id to a message within 24 hours."],
  realtime: ["Uploads and realtime", "Get a realtime URL", "A single-use WebSocket URL, valid for {{v1.ticketTtl}}."],
  connectRealtime: ["Uploads and realtime", "Connect to realtime", "Open the URL from the call above unchanged. Frames are `RealtimeEvent` JSON."],
  listContacts: ["Server API", "List contacts", "Persistent contacts, not anonymous visitors. Search them with `q`."],
  getContact: ["Server API", "Get a contact", ""],
  getContactBySubject: ["Server API", "Get a contact by your user id", "The contact whose `external_id` is your user id."],
  upsertContact: ["Server API", "Create or update a contact", "Keyed by your user id. The same email-linking rules as starting a session."],
  eraseContact: ["Server API", "Erase a contact", "Removes their identity, sessions and verification records. Their requests stay, written by a deleted user."],
  updateConversation: ["Server API", "Update a conversation", "Status and close reason, assignee and labels."],
  requestVerification: ["Server API", "Ask to verify an email", "Emails a code to the address; the requester enters it in the conversation."],
  openapi: ["Discovery", "Get the OpenAPI document", "This reference as OpenAPI 3.1."]
}
const groups = ["Sessions", "Conversations", "Uploads and realtime", "Server API", "Discovery"]
const credentials: Record<string, string> = {
  secret: "secret key",
  publishable: "publishable key",
  session: "session",
  socketTicket: "realtime ticket"
}
const schemaName = (ref: string) => ref.slice(ref.lastIndexOf("/") + 1)
const schemaLink = (name: string) => `[\`${name}\`](#${slugify(`${name} object`)})`
function typeText(s: JsonSchema): string {
  if (s.$ref) return schemaLink(schemaName(s.$ref))
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``
  if (s.enum) return s.enum.map((v) => `\`${JSON.stringify(v)}\``).join(" or ")
  if (s.anyOf) return s.anyOf.map(typeText).join(" or ")
  if (s.oneOf) return s.oneOf.map(typeText).join(" or ")
  if (s.allOf) return s.allOf.map(typeText).join(" and ")
  if (s.type === "array") return `array of ${s.items ? typeText(s.items) : "values"}`
  if (s.type === "object" && s.properties)
    return `{ ${Object.keys(s.properties).map((k) => `\`${k}\``).join(", ")} }`
  if (s.type === "object") return s.additionalProperties ? `object of ${typeText(s.additionalProperties)}` : "object"
  const limits = [
    s.format,
    s.maxLength !== undefined && `up to ${s.maxLength} characters`,
    s.minimum !== undefined && s.maximum !== undefined && `${s.minimum}–${s.maximum}`
  ].filter(Boolean)
  return `${s.type ?? "any"}${limits.length ? ` (${limits.join(", ")})` : ""}`
}
const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ")
function operationEntry(method: string, path: string, op: Operation) {
  const known = operations[op.operationId]
  const [, title, summary] = known ?? ["", op.operationId, ""]
  const auth = op.security.length
    ? op.security.map((s) => credentials[Object.keys(s)[0]!] ?? Object.keys(s)[0]).join(" or ")
    : "none"
  const params = op.parameters.map(
    (p) => `| \`${p.name}\` | ${p.in} | ${cell(typeText(p.schema))} | ${p.required ? "yes" : ""} |`
  )
  const body = op.requestBody && Object.entries(op.requestBody.content)[0]
  const [status, ok] = Object.entries(op.responses).find(([code]) => Number(code) < 400)!
  const result = ok.content?.["application/json"]?.schema ?? ok["x-websocket-frame"]
  // The per-route descriptions in the document are the generic codes for each status; the page's Errors table
  // explains them once.
  const errors = Object.keys(op.responses)
    .filter((code) => Number(code) >= 400)
    .map((code) => `\`${code}\``)
  return [
    `#### ${title}`,
    "",
    `\`${method.toUpperCase()} /v1${path}\` · ${auth}`,
    "",
    ...(summary ? [expand(summary), ""] : []),
    ...(op.description ? [op.description, ""] : []),
    ...(params.length ? ["| Parameter | In | Type | Required |", "| --- | --- | --- | --- |", ...params, ""] : []),
    ...(body ? [`Body: ${body[0] === "multipart/form-data" ? "`multipart/form-data`, " : ""}${typeText(body[1].schema)}`, ""] : []),
    `Returns \`${status}\`${result ? ` with ${typeText(result)}` : ""}. [Errors](#errors): ${list(errors)}.`,
    ""
  ].join("\n")
}
function apiReference() {
  const doc = api()
  const entries = Object.entries(doc.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ method, path, op, group: operations[op.operationId]?.[0] ?? "Other" }))
  )
  const undescribed = entries.filter((e) => !operations[e.op.operationId]).map((e) => e.op.operationId)
  if (undescribed.length) console.error("bellhop.docs_operation_undescribed", { operations: undescribed })
  return [...groups, "Other"]
    .map((group) => {
      const inGroup = entries.filter((e) => e.group === group)
      if (!inGroup.length) return ""
      inGroup.sort((a, b) => Object.keys(operations).indexOf(a.op.operationId) - Object.keys(operations).indexOf(b.op.operationId))
      return `### ${group}\n\n${inGroup.map((e) => operationEntry(e.method, e.path, e.op)).join("\n")}`
    })
    .filter(Boolean)
    .join("\n")
}
function fields(s: JsonSchema, schemas: Record<string, JsonSchema>): [string, JsonSchema, boolean][] {
  if (s.$ref) return fields(schemas[schemaName(s.$ref)]!, schemas)
  if (s.allOf) return s.allOf.flatMap((x) => fields(x, schemas))
  return Object.entries(s.properties ?? {}).map(([k, v]) => [k, v, (s.required ?? []).includes(k)])
}
function schemaReference() {
  const { schemas } = api().components
  return Object.entries(schemas)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, s]) => {
      const variants = s.oneOf
      const body = variants
        ? variants
            .map((v) => {
              const f = fields(v, schemas)
              return `- ${v.$ref ? typeText(v) : f.map(([k, t, required]) => `\`${k}\`${required ? "" : "?"}: ${typeText(t)}`).join(", ")}`
            })
            .join("\n")
        : (() => {
            const f = fields(s, schemas)
            if (!f.length) return typeText(s)
            const optional = f.some(([, , required]) => !required)
            return [
              `| Field | Type${optional ? " | Required" : ""} |`,
              `| --- | ---${optional ? " | ---" : ""} |`,
              ...f.map(([k, t, required]) => `| \`${k}\` | ${cell(typeText(t) + (t.description ? `. ${t.description}` : ""))}${optional ? ` | ${required ? "yes" : ""}` : ""} |`)
            ].join("\n")
          })()
      return `#### \`${name}\` object\n\n${variants ? "One of:\n\n" : ""}${body}\n`
    })
    .join("\n")
}
const tables: Record<string, () => string> = {
  "mcp-tools": toolTable,
  "webhook-events": eventTable,
  "api-reference": apiReference,
  "api-schemas": schemaReference
}

function expand(source: string) {
  const out = source
    .replace(/^\{\{table:([a-z-]+)\}\}$/gm, (_, name: string) => (tables[name] ?? fail(`unknown table ${name}`))())
    .replace(/\{\{rate:([A-Z0-9_]+)\}\}/g, (_, name: string) => rate(name))
    .replace(/\{\{([a-zA-Z0-9.]+)\}\}/g, (_, key: string) => values[key] ?? fail(`unknown placeholder ${key}`))
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
  ["feeds", feeds],
  ["api", publicApi],
  ["widget", widget],
  ["identity", identity]
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
