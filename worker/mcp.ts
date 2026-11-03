import { Hono } from "hono"
import { labels } from "./apps"
import { ApiFailure, bad, choice, dbError, ids, input, missing, now, sha256, sql, str } from "./core"
import type { Bindings, Ctx } from "./core"
import { setActivity } from "./events"
import { attachment, getIssue, issueSummary, listIssues } from "./issues"
import type { AttachmentRow } from "./issues"
import { addComment, relate, updateIssue } from "./mutations"
import type { Access } from "./mutations"

const number = { type: "integer", minimum: 1 },
  text = { type: "string" },
  limit = { ...number, maximum: 100 }
const states = ["open", "closed"] as const,
  relations = ["duplicate_of", "related", "blocks"] as const
function tool(name: string, description: string, properties: Record<string, object>, required: string[] = []) {
  return { name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } }
}
const tools = [
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
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }]
})
function integer(v: unknown, field: string, max = Number.MAX_SAFE_INTEGER) {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > max) bad(`Invalid ${field}`)
  return v
}
async function call(a: Access, name: string, b: Record<string, unknown>) {
  const schema = tools.find((t) => t.name === name)?.inputSchema ?? bad("Unknown tool")
  if (
    Object.keys(b).some((k) => !Object.hasOwn(schema.properties, k)) ||
    schema.required.some((k) => !Object.hasOwn(b, k))
  )
    bad("Unexpected or missing tool argument")
  const { env, app, actor } = a,
    n = () => integer(b.number, "number")
  switch (name) {
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
      return textResult(await getIssue(env, app.id, n(), actor, true))
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
        patch.label_ids = ids(names, "labels").map(
          (name) =>
            available.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id ?? bad(`Unknown label: ${name}`)
        )
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

async function authenticate(c: Ctx): Promise<Access | null> {
  const token = /^Bearer (bh_[a-f0-9]{64})$/i.exec(c.req.header("Authorization") ?? "")?.[1]
  if (!token) return null
  const agent = await sql(
    c.env,
    "UPDATE agent_tokens SET last_used_at=? WHERE token_hash=? RETURNING id,name,app_id",
    now(),
    await sha256(token)
  ).first<{ id: string; name: string; app_id: string }>()
  if (!agent) return null
  const app = await sql(c.env, "SELECT id,slug,name FROM apps WHERE id=?", agent.app_id).first<Access["app"]>()
  if (!app) return null
  return {
    app,
    env: c.env,
    ctx: c.executionCtx,
    origin: c.env.PUBLIC_ORIGIN || new URL(c.req.url).origin,
    privileged: true,
    actor: { type: "agent", id: agent.id, name: agent.name }
  }
}

function object(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}
export const mcp = new Hono<Bindings>()
mcp.on(["GET", "DELETE"], "/mcp", (c) => {
  c.header("Allow", "POST")
  return c.body(null, 405)
})
mcp.post("/mcp", async (c) => {
  let id: string | number | null = null
  const error = (code: number, message: string, status: 200 | 400 | 401 | 500 = 200) =>
    c.json({ jsonrpc: "2.0", id, error: { code, message } }, status)
  const result = (value: unknown) => c.json({ jsonrpc: "2.0", id, result: value })
  const a = await authenticate(c)
  if (!a) {
    c.header("WWW-Authenticate", "Bearer")
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
        return result(await call(a, p.name, p.arguments === undefined ? {} : input(p.arguments)))
      } catch (e) {
        const failure = e instanceof ApiFailure ? e : e instanceof Error ? dbError(e) : null
        if (!failure) console.error("bellhop.tool_failed", { tool: p.name })
        return result({ ...textResult(failure?.message ?? "Internal tool error"), isError: true })
      }
    }
    default:
      return error(-32601, "Method not found")
  }
})
