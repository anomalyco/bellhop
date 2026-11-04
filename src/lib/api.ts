import type {
  AgentAccess,
  App,
  AppAgent,
  AppDetail,
  AppSettings,
  Comment,
  Config,
  ConnectedAgent,
  Issue,
  IssueList,
  IssuePatch,
  LabelInput,
  Label,
  Me,
  NewApp,
  NewComment,
  NewAgentToken,
  NewIssue,
  OAuthApproval,
  OAuthRequest,
  Role,
  RelationType,
  Template,
  TemplateInput,
} from "../../shared/api"
import { load, peek } from "./cache"
import { runHumanCheck } from "./human"

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.status === 501) return "This isn't available yet."
    return error.message
  }
  if (error instanceof Error && error.name === "TypeError") return "Can't reach Bellhop. Check your connection."
  return error instanceof Error ? error.message : "Something went wrong."
}

async function failure(res: Response) {
  const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
  return new ApiFailure(res.status, body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? res.statusText)
}

const seenKey = "bh_seen"
let guestReady = (() => {
  try {
    return localStorage.getItem(seenKey) === "1"
  } catch {
    return false
  }
})()
let firstFlight: Promise<void> | null = null

function markGuestReady() {
  guestReady = true
  try {
    localStorage.setItem(seenKey, "1")
  } catch {
    // Storage disabled; this tab's in-memory flag still serializes only once.
  }
}

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
  if (!guestReady) {
    if (firstFlight) await firstFlight
    if (!guestReady) {
      let release!: () => void
      firstFlight = new Promise<void>((r) => (release = r))
      try {
        const res = await fetch(path, {
          method,
          credentials: "same-origin",
          headers: body === undefined ? undefined : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        markGuestReady()
        release()
        if (res.status === 428 && !retried) {
          await runHumanCheck()
          return request(method, path, body, true)
        }
        if (!res.ok) throw await failure(res)
        return (await res.json()) as T
      } catch (e) {
        release()
        throw e
      } finally {
        firstFlight = null
      }
    }
  }
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 428 && !retried) {
    await runHumanCheck()
    return request(method, path, body, true)
  }
  if (!res.ok) throw await failure(res)
  return (await res.json()) as T
}

const get = <T>(path: string) => request<T>("GET", path)
const enc = encodeURIComponent
const app = (slug: string) => `/api/apps/${enc(slug)}`

export const api = {
  config: () => get<Config>("/api/config"),
  me: () => get<Me>("/api/me"),
  setGuestName: (name: string) => request<Me>("PUT", "/api/me/guest", { name }),
  apps: () => get<App[]>("/api/apps"),
  createApp: (input: NewApp) => request<AppDetail>("POST", "/api/apps", input),
  app: (slug: string) => get<AppDetail>(app(slug)),
  patchApp: (slug: string, input: { name?: string; description?: string }) => request<AppDetail>("PATCH", app(slug), input),
  settings: (slug: string) => get<AppSettings>(`${app(slug)}/settings`),
  putWebhook: (slug: string, url: string | null) => request<AppSettings>("PUT", `${app(slug)}/webhook`, { url }),
  rotateWebhook: (slug: string) => request<AppSettings>("POST", `${app(slug)}/webhook/rotate`),
  testWebhook: (slug: string) => request<{ delivery_id: string }>("POST", `${app(slug)}/webhook/test`),
  addMember: (slug: string, email: string, role?: Role) => request<AppSettings>("POST", `${app(slug)}/members`, { email, role }),
  patchMember: (slug: string, id: string, role: Role) => request<AppSettings>("PATCH", `${app(slug)}/members/${enc(id)}`, { role }),
  removeMember: (slug: string, id: string) => request<AppSettings>("DELETE", `${app(slug)}/members/${enc(id)}`),
  transfer: (slug: string, memberId: string) => request<AppSettings>("POST", `${app(slug)}/transfer`, { member_id: memberId }),
  appAgents: (slug: string) => get<AppAgent[]>(`${app(slug)}/agents`),
  patchAppAgent: (slug: string, id: string, role: AppAgent["role"]) => request<AppAgent>("PATCH", `${app(slug)}/agents/${enc(id)}`, { role }),
  removeAppAgent: (slug: string, id: string) => request<{ ok: true }>("DELETE", `${app(slug)}/agents/${enc(id)}`),
  createLabel: (slug: string, input: LabelInput) => request<Label>("POST", `${app(slug)}/labels`, input),
  patchLabel: (slug: string, id: string, input: LabelInput) => request<Label>("PATCH", `${app(slug)}/labels/${enc(id)}`, input),
  deleteLabel: (slug: string, id: string) => request<{ ok: true }>("DELETE", `${app(slug)}/labels/${enc(id)}`),
  createTemplate: (slug: string, input: TemplateInput) => request<Template>("POST", `${app(slug)}/templates`, input),
  patchTemplate: (slug: string, id: string, input: TemplateInput) =>
    request<Template>("PATCH", `${app(slug)}/templates/${enc(id)}`, input),
  deleteTemplate: (slug: string, id: string) => request<{ ok: true }>("DELETE", `${app(slug)}/templates/${enc(id)}`),
  issues: (slug: string, params: { state: "open" | "closed"; label?: string; q?: string; cursor?: string }) => {
    const qs = new URLSearchParams({ state: params.state })
    if (params.label) qs.set("label", params.label)
    if (params.q) qs.set("q", params.q)
    if (params.cursor) qs.set("cursor", params.cursor)
    return get<IssueList>(`${app(slug)}/issues?${qs}`)
  },
  createIssue: (slug: string, input: NewIssue) => request<Issue>("POST", `${app(slug)}/issues`, input),
  issue: (slug: string, number: number) => get<Issue>(`${app(slug)}/issues/${number}`),
  patchIssue: (slug: string, number: number, patch: IssuePatch) => request<Issue>("PATCH", `${app(slug)}/issues/${number}`, patch),
  comment: (slug: string, number: number, input: NewComment) =>
    request<Comment>("POST", `${app(slug)}/issues/${number}/comments`, input),
  addRelation: (slug: string, number: number, type: RelationType, other: number) =>
    request<Issue>("POST", `${app(slug)}/issues/${number}/relations`, { type, number: other }),
  removeRelation: (slug: string, number: number, id: string) =>
    request<Issue>("DELETE", `${app(slug)}/issues/${number}/relations/${enc(id)}`),
  logout: () => fetch("/auth/logout", { method: "POST", credentials: "same-origin" }),
  /** The raw image goes up as the body with its own Content-Type. */
  putIcon: async (slug: string, file: File) => {
    const res = await fetch(`${app(slug)}/icon`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": file.type }, body: file })
    if (!res.ok) throw await failure(res)
    return (await res.json()) as AppDetail
  },
  deleteIcon: (slug: string) => request<AppDetail>("DELETE", `${app(slug)}/icon`),
  oauthRequest: (id: string) => get<OAuthRequest>(`/api/oauth/requests/${enc(id)}`),
  deviceLookup: (userCode: string) => request<{ request_id: string }>("POST", "/api/oauth/device/lookup", { user_code: userCode }),
  approve: (id: string, approval: OAuthApproval) =>
    request<{ redirect_to: string | null }>("POST", `/api/oauth/requests/${enc(id)}/approve`, approval),
  deny: (id: string) => request<{ redirect_to: string | null }>("POST", `/api/oauth/requests/${enc(id)}/deny`),
  agents: () => get<ConnectedAgent[]>("/api/me/agents"),
  createAgent: (input: AgentAccess & { name: string }) => request<NewAgentToken>("POST", "/api/me/agents", input),
  patchAgent: (id: string, input: Partial<AgentAccess> & { name?: string }) => request<ConnectedAgent>("PATCH", `/api/me/agents/${enc(id)}`, input),
  rotateAgent: (id: string) => request<NewAgentToken>("POST", `/api/me/agents/${enc(id)}/rotate`),
  disconnectAgent: (id: string) => request<{ ok: true }>("DELETE", `/api/me/agents/${enc(id)}`),
}

// Cache keys, so every page agrees on where a resource lives.
export const keys = {
  config: "config",
  me: "me",
  apps: "apps",
  agents: "agents",
  app: (slug: string) => `app:${slug}`,
  settings: (slug: string) => `settings:${slug}`,
  appAgents: (slug: string) => `app-agents:${slug}`,
  issue: (slug: string, number: number) => `issue:${slug}:${number}`,
  /** All list pages of one app share this prefix; the rest of the key is the filter. */
  lists: (slug: string) => `issues:${slug}:`,
}

export const loadConfig = () => load(keys.config, api.config)
export const loadMe = () => load(keys.me, api.me)
export const currentMe = () => peek<Me>(keys.me)
