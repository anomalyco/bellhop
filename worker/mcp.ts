import { Hono } from "hono"
import type { AgentRole, App, Label, Template } from "../shared/api"
import {
  appCols,
  createApp,
  deleteTemplate,
  detail,
  labels,
  templates,
  updateApp,
  webhookDeliveries,
  writeLabel,
  writeTemplate
} from "./apps"
import { ApiFailure, bad, choice, dbError, denied, fail, ids, input, missing, sha256, sql, str } from "./core"
import type { Bindings, Ctx } from "./core"
import { agentAccessSQL, can, teamRole } from "./permissions"
import type { Action } from "./permissions"
import { roster, changeMember, invite } from "./members"
import { setActivity } from "./events"
import { attachment, getIssue, issueSummary, listIssues } from "./issues"
import type { AttachmentRow } from "./issues"
import { addComment, relate, removeLabel, updateIssue } from "./mutations"
import type { Access } from "./mutations"
import { oauthOrigin } from "./oauth"
import { configureWebhook, rotateWebhook, testWebhook } from "./webhooks"

const number = { type: "integer", minimum: 1 },
  text = { type: "string" },
  limit = { ...number, maximum: 100 }
const states = ["open", "closed"] as const,
  relations = ["duplicate_of", "related", "blocks"] as const
const toolRoles = {
  list_apps: "discover",
  create_app: "create",
  get_app: "read",
  list_issues: "read",
  search_issues: "read",
  get_issue: "read",
  get_attachment: "read",
  list_labels: "read",
  list_templates: "read",
  comment: "respond",
  set_activity: "respond",
  update_issue: "triage",
  claim_issue: "triage",
  relate_issues: "triage",
  update_app: "setup",
  get_webhook: "setup",
  set_webhook: "setup",
  rotate_webhook_secret: "setup",
  test_webhook: "setup",
  create_label: "setup",
  update_label: "setup",
  delete_label: "setup",
  create_template: "setup",
  update_template: "setup",
  delete_template: "setup",
  list_members: "setup",
  invite_member: "setup",
  set_member_role: "setup",
  remove_member: "setup"
} as const satisfies Record<string, Action | "discover" | "create">
function tool(
  name: keyof typeof toolRoles,
  description: string,
  properties: Record<string, object>,
  required: string[] = []
) {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties:
        name === "list_apps" || name === "create_app"
          ? properties
          : {
              ...properties,
              app: {
                type: "string",
                description: "Workspace slug. Required when more than one workspace is connected."
              }
            },
      required,
      additionalProperties: false
    }
  }
}
const templateFields = {
  name: text,
  description: text,
  title: text,
  body: text,
  labels: { type: "array", items: text, maxItems: 50 },
  ask_system_info: { type: "boolean" },
  position: { type: "integer" }
}
const workspaceTools = [
  tool("get_app", "Read workspace details, counts, labels, and templates.", {}),
  tool("update_app", "Update workspace name or description (admin).", { name: text, description: text }),
  tool("get_webhook", "Read webhook configuration and recent deliveries (admin).", {}),
  tool("set_webhook", "Set an HTTPS webhook URL, or remove it (admin).", { url: { type: ["string", "null"] } }, [
    "url"
  ]),
  tool("rotate_webhook_secret", "Rotate the signing secret and return the new secret once (admin).", {}),
  tool("test_webhook", "Queue a ping to the configured webhook (admin).", {}),
  tool("create_label", "Create a label (admin).", { name: text, color: text, description: text }, ["name"]),
  tool(
    "update_label",
    "Update a label by its current name (admin).",
    { name: text, new_name: text, color: text, description: text },
    ["name"]
  ),
  tool("delete_label", "Delete a named label and remove it from issues (admin).", { name: text }, ["name"]),
  tool("list_templates", "List issue templates with their labels.", {}),
  tool("create_template", "Create an issue template using label names (admin).", templateFields, ["name"]),
  tool("update_template", "Update a template by its current name (admin).", { ...templateFields, new_name: text }, [
    "name"
  ]),
  tool("delete_template", "Delete a template by name (admin).", { name: text }, ["name"]),
  tool("list_members", "List the team and invitations (admin).", {}),
  tool(
    "invite_member",
    "Invite an account; defaults to member (admin).",
    { email: text, role: { enum: ["viewer", "member", "admin", "owner"] } },
    ["email"]
  ),
  tool(
    "set_member_role",
    "Change a team role (admin; managing admins/owners needs owner delegation).",
    { email: text, role: { enum: ["viewer", "member", "admin", "owner"] } },
    ["email", "role"]
  ),
  tool("remove_member", "Remove a team member or invitation (admin).", { email: text }, ["email"])
]
const tools = [
  ...workspaceTools,
  tool("list_apps", "List the workspaces this agent can use and its role in each.", {}),
  tool(
    "create_app",
    "Create a workspace owned by your account. Requires separate permission to create workspaces.",
    { name: text, slug: text, description: text },
    ["name", "slug"]
  ),
  tool("list_issues", "List issues by state, label, or search terms.", {
    state: { ...text, enum: states },
    label: text,
    query: text,
    limit
  }),
  tool("get_issue", "Read an issue with its timeline, attachments, relations, and system info.", { number }, [
    "number"
  ]),
  tool("search_issues", "Search titles, bodies, and comments across open and closed issues.", { query: text, limit }, [
    "query"
  ]),
  tool("get_attachment", "Read an image or get an absolute link to a larger image, video, or file.", { id: text }, [
    "id"
  ]),
  tool("list_labels", "List the labels available in this app.", {}),
  tool("comment", "Post an agent comment and clear your activity on the issue.", { number, body: text }, [
    "number",
    "body"
  ]),
  tool(
    "update_issue",
    "Change the title, status, close reason, or complete list of label names.",
    {
      number,
      status: { ...text, enum: ["open", "in_progress", "waiting", "closed"] },
      close_reason: { ...text, enum: ["completed", "not_planned", "duplicate"] },
      labels: { type: "array", items: text },
      title: text
    },
    ["number"]
  ),
  tool(
    "relate_issues",
    "Add a directional relation from one issue to another.",
    {
      number,
      other_number: number,
      type: { ...text, enum: relations }
    },
    ["number", "other_number", "type"]
  ),
  tool("claim_issue", "Assign the issue to this agent.", { number }, ["number"]),
  tool(
    "set_activity",
    "Show typing or a short status for 60 seconds, or clear it.",
    {
      number,
      text: { type: ["string", "null"] },
      clear: { type: "boolean" }
    },
    ["number"]
  )
]

const textResult = (value: unknown) => ({
  content: [
    {
      type: "text",
      text:
        typeof value === "string"
          ? value
          : JSON.stringify(value, (key, v) =>
              (key === "author" || key === "actor") && v?.type === "guest" && v.name
                ? { ...v, display_name: `${v.name} (${v.handle})` }
                : v
            )
    }
  ]
})
function integer(v: unknown, field: string, max = Number.MAX_SAFE_INTEGER) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > max) bad(`Invalid ${field}`)
  return v
}
type Workspace = Omit<App, "role"> & { role: AgentRole }
type Caller = { actor: Access["actor"]; apps: Workspace[]; user: string; create: boolean }
function named<T extends { name: string }>(items: T[], value: unknown, kind: "label" | "template"): T {
  const name = str(value, "name", kind === "template" ? 120 : 60)
    .trim()
    .toLowerCase()
  const matches = items.filter((item) => item.name.toLowerCase() === name)
  if (matches.length > 1) bad(`Ambiguous ${kind} name; rename one in workspace settings`)
  return matches[0] ?? bad(`Unknown ${kind} name`)
}
function labelIds(available: Label[], names: unknown) {
  return ids(names, "labels").map((name) => named(available, name, "label").id)
}
function templateResult(t: Template, all: Label[]) {
  return { ...t, labels: all.filter((l) => t.label_ids.includes(l.id)).map((l) => l.name) }
}
async function call(c: Ctx, caller: Caller, name: string, args: Record<string, unknown>) {
  const definition = tools.find((t) => t.name === name) ?? bad("Unknown tool"),
    schema = definition.inputSchema,
    action = toolRoles[definition.name]
  if (
    Object.keys(args).some((k) => !Object.hasOwn(schema.properties, k)) ||
    schema.required.some((k) => !Object.hasOwn(args, k))
  )
    bad("Unexpected or missing tool argument")
  if (action === "discover") return textResult(caller.apps)
  if (action === "create") {
    if (!caller.create) denied()
    return textResult(await createApp(c, { id: caller.user }, args, caller.actor.id))
  }
  const { app: slug, ...b } = args
  const options = caller.apps.map((app) => app.slug).join(", ") || "(none)"
  if (slug === undefined && caller.apps.length > 1) bad(`Choose an app. Allowed: ${options}`)
  const chosen = slug === undefined ? caller.apps[0] : caller.apps.find((app) => app.slug === slug)
  if (!chosen) fail(403, "forbidden", `Workspace not allowed. Allowed: ${options}`)
  if (!can(chosen.role, action)) denied()
  const a: Access = {
    app: chosen,
    env: c.env,
    ctx: c.executionCtx,
    origin: oauthOrigin(c),
    actor: caller.actor,
    role: chosen.role
  }
  const { env, app, actor } = a,
    n = () => integer(b.number, "number")
  const manager = { user: caller.user, agent: caller.actor.id }
  switch (name) {
    case "get_app":
      return textResult({ ...(await detail(c, { ...chosen, role: null })), role: chosen.role })
    case "update_app":
      return textResult(await detail(c, await updateApp(env, { ...chosen, role: "admin" }, b)))
    case "list_members":
      return textResult(await roster(env, app.id))
    case "invite_member":
      await invite(env, app.id, manager, b.email, teamRole(b.role === undefined ? "member" : b.role))
      return textResult({ ok: true })
    case "set_member_role":
      await changeMember(env, app.id, manager, { email: b.email }, teamRole(b.role))
      return textResult({ ok: true })
    case "remove_member":
      await changeMember(env, app.id, manager, { email: b.email }, null)
      return textResult({ ok: true })
    case "get_webhook": {
      const hook = await sql(
        env,
        "SELECT url,secret!='' has_secret FROM webhook_settings WHERE app_id=?",
        app.id
      ).first<{ url: string | null; has_secret: number }>()
      if (!hook) missing()
      return textResult({
        url: hook.url,
        has_secret: !!hook.has_secret,
        deliveries: await webhookDeliveries(env, app.id)
      })
    }
    case "set_webhook":
      return textResult(await configureWebhook(env, app.id, b.url))
    case "rotate_webhook_secret":
      return textResult(await rotateWebhook(env, app.id))
    case "test_webhook":
      return textResult(await testWebhook(env, a.origin, app, actor))
    case "create_label":
      return textResult(await writeLabel(env, app.id, b))
    case "update_label":
    case "delete_label": {
      const label = named(await labels(env, app.id), b.name, "label")
      if (name === "update_label")
        return textResult(await writeLabel(env, app.id, { ...b, name: b.new_name }, label.id))
      await removeLabel(a, label.id)
      return textResult({ ok: true })
    }
    case "list_templates": {
      const [items, all] = await Promise.all([templates(env, app.id), labels(env, app.id)])
      return textResult(items.map((t) => templateResult(t, all)))
    }
    case "delete_template": {
      const t = named(await templates(env, app.id), b.name, "template")
      return textResult(await deleteTemplate(env, app.id, t.id))
    }
    case "create_template":
    case "update_template": {
      const old = name === "update_template" ? named(await templates(env, app.id), b.name, "template") : undefined
      const all = await labels(env, app.id)
      const t = await writeTemplate(
        env,
        app.id,
        {
          ...b,
          name: old ? b.new_name : b.name,
          label_ids: b.labels === undefined ? undefined : labelIds(all, b.labels)
        },
        old?.id
      )
      return textResult(templateResult(t, all))
    }
    case "list_issues":
    case "search_issues":
      return textResult(
        await listIssues(env, app.id, {
          allStates: name === "search_issues",
          state: b.state === undefined ? undefined : choice(b.state, states, "state"),
          label: b.label === undefined ? undefined : str(b.label, "label", 60),
          query: b.query === undefined ? undefined : str(b.query, "query", 512),
          limit: b.limit === undefined ? undefined : integer(b.limit, "limit", 100)
        })
      )
    case "get_issue":
      return textResult(await getIssue(env, app.id, n(), actor, can(a.role, "read")))
    case "list_labels":
      return textResult(await labels(env, app.id))
    case "get_attachment": {
      const row = await sql(
        env,
        `SELECT id,name,mime,kind,size,object_key FROM attachments
        WHERE id=? AND app_id=?`,
        str(b.id, "id", 64),
        app.id
      ).first<AttachmentRow & { object_key: string }>()
      if (!row) missing()
      if (row.kind !== "image" || row.size > 5 * 1024 * 1024)
        return textResult(new URL(attachment(row).url, a.origin).href)
      const object = await env.MEDIA.get(row.object_key)
      if (!object) missing()
      const bytes = new Uint8Array(await object.arrayBuffer()),
        chunks = []
      // A multiple of three means concatenated chunks only have padding at the end.
      for (let i = 0; i < bytes.length; i += 24576)
        chunks.push(btoa(String.fromCharCode(...bytes.subarray(i, i + 24576))))
      return { content: [{ type: "image", mimeType: row.mime, data: chunks.join("") }] }
    }
    case "comment":
      return textResult(await addComment(a, n(), { body: b.body }))
    case "claim_issue":
      return textResult(await updateIssue(a, n(), {}, true))
    case "update_issue": {
      const { number: _, labels: names, ...patch } = b
      if (names !== undefined) {
        const available = await labels(env, app.id)
        patch.label_ids = labelIds(available, names)
      }
      if (patch.status === null || patch.close_reason === null) bad("Status and close reason must be strings")
      return textResult(await updateIssue(a, n(), patch))
    }
    case "relate_issues":
      return textResult(
        await relate(a, n(), integer(b.other_number, "other_number"), choice(b.type, relations, "type"))
      )
    case "set_activity": {
      if (b.clear !== undefined && typeof b.clear !== "boolean") bad("Invalid clear flag")
      const issue = await issueSummary(env, app.id, n())
      await setActivity(env, app.id, issue.id, actor, b.text == null ? null : str(b.text, "text", 240, true), b.clear)
      return textResult({ ok: true })
    }
    default:
      return bad("Unknown tool")
  }
}

async function authenticate(c: Ctx): Promise<Caller | null> {
  const token = /^Bearer (bh_(?:a_)?[a-f0-9]{64})$/i.exec(c.req.header("Authorization") ?? "")?.[1]
  if (!token) return null
  const hash = await sha256(token)
  const credential = token.startsWith("bh_a_")
    ? "kind='oauth' AND id IN (SELECT grant_id FROM oauth_tokens WHERE hash=? AND kind='access' AND expires_at>unixepoch())"
    : "kind='token' AND token_hash=?"
  const active = `FROM agents WHERE revoked_at IS NULL AND ${credential}`
  const [identity, scopes] = await c.env.DB.batch<unknown>([
    sql(
      c.env,
      `SELECT id,user_id,name,create_workspaces,last_used_at IS NULL OR last_used_at<unixepoch()-300 stale ${active}`,
      hash
    ),
    sql(
      c.env,
      `SELECT ${appCols},acl.role FROM (${agentAccessSQL}) acl JOIN apps a ON a.id=acl.app_id
      WHERE acl.agent_id=(SELECT id ${active}) AND acl.role IS NOT NULL ORDER BY a.slug`,
      hash
    )
  ])
  const agent = identity!.results[0] as
    | { id: string; user_id: string; name: string; create_workspaces: number; stale: number }
    | undefined
  if (!agent) return null
  // One activity timestamp covers both bearer types. The second check avoids redundant writes
  // if several calls authenticated before the first background update committed.
  if (agent.stale)
    c.executionCtx.waitUntil(
      sql(
        c.env,
        `UPDATE agents SET last_used_at=unixepoch() WHERE id=?
    AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at<unixepoch()-300)`,
        agent.id
      ).run()
    )
  const apps = scopes!.results as Workspace[]
  return {
    apps,
    user: agent.user_id,
    create: !!agent.create_workspaces,
    actor: { type: "agent", id: agent.id, name: agent.name }
  }
}

function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}
export const mcp = new Hono<Bindings>()
function challenge(c: Ctx) {
  c.header("WWW-Authenticate", `Bearer resource_metadata="${oauthOrigin(c)}/.well-known/oauth-protected-resource"`)
}
mcp.on(["GET", "DELETE"], "/mcp", async (c) => {
  if (!(await authenticate(c))) {
    challenge(c)
    return c.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Invalid or missing agent token" } }, 401)
  }
  c.header("Allow", "POST")
  return c.body(null, 405)
})
mcp.post("/mcp", async (c) => {
  let id: string | number | null = null
  const error = (code: number, message: string, status: 200 | 400 | 401 | 403 | 500 = 200) =>
    c.json({ jsonrpc: "2.0", id, error: { code, message } }, status)
  const result = (value: unknown) => c.json({ jsonrpc: "2.0", id, result: value })
  const a = await authenticate(c)
  if (!a) {
    challenge(c)
    return error(-32001, "Invalid or missing agent token", 401)
  }
  let req: unknown
  try {
    req = await c.req.json()
  } catch {
    return error(-32700, "Parse error", 400)
  }
  if (!object(req) || req.jsonrpc !== "2.0" || typeof req.method !== "string")
    return error(-32600, "Invalid request", 400)
  if (req.id === undefined && req.method.startsWith("notifications/")) return c.body(null, 202)
  if (typeof req.id !== "number" && typeof req.id !== "string") return error(-32600, "Invalid request id", 400)
  id = req.id
  if (req.params !== undefined && !object(req.params)) return error(-32602, "Invalid params")
  const p = req.params ?? {}
  switch (req.method) {
    case "initialize":
      if (p.protocolVersion !== undefined && typeof p.protocolVersion !== "string")
        return error(-32602, "Invalid protocolVersion")
      return result({
        protocolVersion: p.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "bellhop", version: "1.0.0" }
      })
    case "ping":
      return result({})
    case "tools/list":
      return result({ tools })
    case "tools/call": {
      if (typeof p.name !== "string") return error(-32602, "Tool name required")
      try {
        return result(await call(c, a, p.name, p.arguments === undefined ? {} : input(p.arguments)))
      } catch (e) {
        const failure = e instanceof ApiFailure ? e : e instanceof Error ? dbError(e) : null
        if (failure?.status === 403) return error(-32003, failure.message, 403)
        if (!failure) console.error("bellhop.tool_failed", { tool: p.name })
        return result({ ...textResult(failure?.message ?? "Internal tool error"), isError: true })
      }
    }
    default:
      return error(-32601, "Method not found")
  }
})
