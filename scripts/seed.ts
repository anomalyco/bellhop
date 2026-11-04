import { crc32, deflateSync } from "node:zlib"
import type { App, AppDetail, AppSettings, Attachment, Config, ConnectedAgent, Issue, IssueList, IssueStatus, NewAgentToken } from "../shared/api"

const base = new URL(process.argv[2] || "http://127.0.0.1:5287").origin,
  path = "/api/apps/opencode"
const owner = new Map<string, string>(),
  guest = new Map<string, string>()
async function request<T>(
  jar: Map<string, string>,
  path: string,
  method = "GET",
  value?: unknown,
  mime = "application/json"
): Promise<T> {
  const r = await fetch(base + path, {
    method,
    redirect: "manual",
    headers: { "Content-Type": mime, Cookie: Array.from(jar, (pair) => pair.join("=")).join("; ") },
    body: value instanceof Uint8Array ? value : JSON.stringify(value)
  })
  for (const cookie of r.headers.getSetCookie()) {
    const pair = cookie.split(";", 1)[0]!,
      index = pair.indexOf("=")
    jar.set(pair.slice(0, index), pair.slice(index + 1))
  }
  if (r.status === 302 && path.startsWith("/auth/dev?")) return undefined as T
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`)
  return r.json() as Promise<T>
}

// The selected dark-theme row has a pale background, obscuring the text.
function selectionPng() {
  const width = 240,
    height = 100,
    stride = 1 + 3 * width,
    pixels = Buffer.alloc(height * stride)
  function box(x: number, y: number, w: number, h: number, rgb: number) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) pixels.writeUIntBE(rgb, j * stride + 1 + i * 3, 3)
  }
  box(0, 0, width, height, 0x191b22)
  box(0, 0, width, 14, 0x292d39)
  box(11, 5, 57, 3, 0xb7c2d5)
  box(8, 41, width - 16, 14, 0xd6dde9)
  for (let i = 0; i < 4; i++) {
    box(16, 27 + i * 18, 5, 5, i === 1 ? 0xb1becd : 0x7e96b5)
    box(27, 28 + i * 18, [52, 80, 44, 65][i]!, 3, 0xbcc7d8)
  }
  const u32 = (v: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(v)
    return b
  }
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.concat([Buffer.from(type), data])
    return Buffer.concat([u32(data.length), bytes, u32(crc32(bytes))])
  }
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])])),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0))
  ])
}

// Two seconds of a terminal pane flickering (VP9/WebM); no external assets or codec binaries needed.
function flickerVideo() {
  return Buffer.from(
    "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAATwEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggTa7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDJXQYxMYXZmNjMuMS4xMDJEiYhAn0AAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIjAIoRbt93/ucgQAitZyDdW5kiIEAhoVWX1ZQOYOBASPjg4QJ7yGq4JCwgcC6gWCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/5zc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAyc3PZY8CLY8WIjAIoRbt93/tnyKRFo4dFTkNPREVSRIeXTGF2YzYzLjEuMTAyIGxpYnZweC12cDlnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAyLjAwMDAwMDAwMAAfQ7Z1Qx/ngQCjQgKBAACAgkmDQgAL8AX2EDgkHBhKAADwf5GmD1tS9zV8ZcuvwAAAf7MS/wRoLvX5ewJT/S7Z/GyefsL9HFKfMNqc6ehT/e5r5J6r3XbwuD8Z3zEO1OptbxAyTTG3mxA8pqX0Fp0AAAAAN2pz/EDivMZ3i1baN0MDAr+L/oGbg5d//RME/p9g9CFtPONoxdxtZjENt6SfZjsO8k+jlZTT1mxH4Lemw3aBDqkUuCpZ7fB8qpQN32NSTg9NhjglaBWhuhbI/QJ+zna4StIvSu6KZgiiFHNOfqT3sgQU2wVTdl7hICE+EBf/dRULwMCKBoyAA0RlCTcWviPvp11EMIplAc5CJdmAO5uX4HyFB2aeWyxBI/U96+JLPiQ6jvbWZcCfUr/EgKYKjpjyEH+k2rwuPgsVGj7vlf+0xyjgIpjMBljsHT3edb/JIc3n8u5bmCQhWFfTgLUYQYTv7fgEwCqViPc4Y5Gpb2P158zHCbSTSWOGxhviLk1xysqs9NWPciV/yWcoNzwiqT+THUn/cj4IY4r8/aYTuTMyZ4TtPFOWOpqRhzZujdAEMqeXRbjlbH5RN6HhUnC1rPZlKCNYXigW76lfZCA4IXTJZdLL5Okg8dwbsoR6coi+IfWOqu5+I1a8WgL9/hMjhbLX+YbS0eIjLcBc9uFHaIvoNQYVKJ/5Cf7SFZgAo5WBAKcAhgBAkpwgUAAAAyAAAFonv/CjlYEBTQCGAECSnCBO4AADIAAAWie/8KOggQH0AIYAQJKcIFAAAANgAAB8wnUaBqAEtV86S9XNVwCjlYECmwCGAECSnCBNQAADIAAAWie/8KOVgQNBAIYAQJKcIFAAAAMgAABaJ7/wo5mBA+gAhgBAkpwgTuAAAyAAAHs3A1JtHMAAo5WBBI8AhgBAkpwgUAAAAyAAAFonv/CjoIEFNQCGAECSnCBKIAADYAAAfMJ1Ggcb0IyTXV/vHzMSo5WBBdwAhgBAkpwgUAAAAyAAAFonv/CjlYEGgwCGAMCSnCBKIAADIAAAZedetKOVgQcpAIYAQJKcIFAAAAMgAABaJ7/wHFO7a5G7j7OBALeK94EB8YIBtfCBAw==",
    "base64"
  )
}

interface Example {
  title: string
  body: string
  labels: ["bug" | "question" | "enhancement", ...string[]]
  status?: IssueStatus
  media?: "image" | "video"
  reply?: string
  ai?: string
}
const examples: Example[] = [
  {
    title: "Session list flashes blank during a streaming reply",
    body: "With two sessions open, switch away from the streaming one and back. The history pane disappears for a frame while the answer is still arriving.",
    labels: ["bug"],
    status: "in_progress",
    media: "video",
    reply: "It also happens with the sidebar collapsed. The input never loses focus.",
    ai: "I can reproduce the blank frame when a background stream reconnects. I’m checking whether the list is being remounted."
  },
  {
    title: "Selected model is hard to read in the dark theme",
    body: "Open the model picker and move down one row. The selected label turns pale gray on a nearly white background; the unselected rows look fine.",
    labels: ["bug"],
    media: "image"
  },
  {
    title: "Can a workspace share its MCP servers without sharing tokens?",
    body: "We commit our project configuration but keep each developer’s key outside git. Does the remote server header support an environment variable?",
    labels: ["question"],
    status: "waiting",
    ai: "Yes. Reference the key as `{env:MY_API_KEY}` in the header value. Does that work when you launch OpenCode from your terminal?"
  },
  {
    title: "Keep the active search when switching sessions",
    body: "I often search the transcript for a filename, check another session, and come straight back. It would help if the previous search and match position were still there.",
    labels: ["enhancement"]
  },
  {
    title: "History briefly disappears when returning to a busy session",
    body: "A session running in the background briefly shows no messages when I revisit it. They come back without a refresh.",
    labels: ["bug", "duplicate"],
    status: "closed"
  },
  {
    title: "Copying a code block adds a trailing blank line",
    body: "Use Copy on a one-line shell example, then paste into a plain-text editor. The clipboard includes a second newline that isn't in the example.",
    labels: ["bug"],
    status: "closed",
    reply: "Retested on the latest build. A single-line command now pastes as one line."
  },
  {
    title: "Show the project folder in the switcher",
    body: "Two of my worktrees use the same package name. Seeing the folder next to the project name would let me choose the right one without opening both.",
    labels: ["enhancement"]
  }
]

if (!(await request<Config>(owner, "/api/config")).dev_login)
  throw new Error("Seed requires a local development instance with DEV_LOGIN=1")
await request(owner, "/auth/dev?email=ryan%40anoma.ly")
const owned = await request<App[]>(owner, "/api/apps")
const app = owned.some((a) => a.slug === "opencode")
  ? await request<AppDetail>(owner, path)
  : await request<AppDetail>(owner, "/api/apps", "POST", {
      slug: "opencode",
      name: "OpenCode",
      description: "Bug reports, questions, and feature requests for OpenCode."
    })
const settings = await request<AppSettings>(owner, path + "/settings")
const token =
  process.env.BELLHOP_SEED_TOKEN ||
  (await request<NewAgentToken>(owner, "/api/me/agents", "POST", {
    name: "OpenCode", apps: [{ id: app.id, role: "member" }], all_workspaces: null, create_workspaces: false
  })).token
if (
  process.env.BELLHOP_SEED_TOKEN &&
  !(await request<ConnectedAgent[]>(owner, "/api/me/agents")).some((t) => t.kind === "token" && t.client_name === "OpenCode" &&
    t.preview === token.slice(0, 10) + "…" && t.apps.some(a => a.id === app.id && (a.role === "member" || a.role === "admin")))
)
  throw new Error("BELLHOP_SEED_TOKEN must be an OpenCode token for the opencode app")
async function tool(name: string, args: object) {
  const r = await fetch(base + "/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { ...args, app: app.slug } } })
  })
  const msg = await r.json()
  if (!r.ok || msg.error || msg.result?.isError)
    throw new Error(`${name}: ${msg.error?.message ?? msg.result?.content[0]?.text ?? r.status}`)
}

await request(guest, "/api/human", "POST", { token: "XXXX.DUMMY.TOKEN.XXXX" })
const existing = new Map<string, number>()
for (const state of ["open", "closed"]) {
  let cursor: string | null = null
  do {
    const page: IssueList = await request(guest, `${path}/issues?state=${state}${cursor ? `&cursor=${cursor}` : ""}`)
    for (const i of page.issues) existing.set(i.title, i.number)
    cursor = page.next_cursor
  } while (cursor)
}
const seeded: Issue[] = []
let created = 0
for (const [index, example] of examples.entries()) {
  const n = existing.get(example.title)
  let issue: Issue
  if (n) issue = await request(guest, `${path}/issues/${n}`)
  else {
    let media: Attachment | undefined
    if (example.media === "image")
      media = await request(guest, path + "/uploads?name=model-picker.png", "POST", selectionPng(), "image/png")
    if (example.media === "video")
      media = await request(guest, path + "/uploads?name=session-flash.webm", "POST", flickerVideo(), "video/webm")
    const template = { bug: "Bug report", question: "Question", enhancement: "Feature request" }[example.labels[0]!]
    issue = await request(guest, path + "/issues", "POST", {
      title: example.title,
      body: example.body + (media ? `\n\n![${media.name}](${media.url})` : ""),
      template_id: app.templates.find((t) => t.name === template)?.id,
      attachment_ids: media ? [media.id] : [],
      system_info: media ? { OS: "macOS", Terminal: "Ghostty", Screen: "1440 × 900" } : undefined
    })
    created++
  }
  const number = issue.number
  if (index === 0 && !issue.assignee) await tool("claim_issue", { number })
  const hasComment = (body: string) => issue.timeline.some((i) => i.kind === "comment" && i.comment.body === body)
  if (example.reply && !hasComment(example.reply))
    await request(guest, `${path}/issues/${number}/comments`, "POST", { body: example.reply })
  if (example.ai && !hasComment(example.ai)) await tool("comment", { number, body: example.ai })
  const status = example.status ?? "open",
    close_reason = status === "closed" ? (index === 4 ? "duplicate" : "completed") : undefined
  if (
    status !== issue.status ||
    (close_reason && close_reason !== issue.close_reason) ||
    issue.labels
      .map((l) => l.name)
      .sort()
      .join() !== [...example.labels].sort().join()
  )
    await tool("update_issue", { number, status, close_reason, labels: example.labels })
  seeded.push(issue)
}
const root = seeded[0]!,
  duplicate = seeded[4]!
if (!duplicate.relations.some((r) => r.type === "duplicate_of" && r.issue.id === root.id && r.direction === "outgoing"))
  await tool("relate_issues", { number: duplicate.number, other_number: root.number, type: "duplicate_of" })
await tool("set_activity", { number: root.number, text: "Checking the reconnect path…" })
const url = settings.mcp_url
console.log(`${new URL("/opencode", url).href} — ${seeded.length} issues (${created} new)`)
console.log(`export BELLHOP_SEED_TOKEN='${token}'`)
console.log(
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        servers: {
          bellhop: { type: "remote", url, oauth: false, headers: { Authorization: "Bearer {env:BELLHOP_SEED_TOKEN}" } }
        }
      }
    },
    null,
    2
  )
)
