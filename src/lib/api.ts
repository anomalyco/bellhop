import type {
  App,
  AppDetail,
  AppSettings,
  Comment,
  Config,
  Issue,
  IssueList,
  IssuePatch,
  LabelInput,
  Label,
  Me,
  NewApp,
  NewComment,
  NewIssue,
  NewToken,
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

async function request<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
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
  apps: () => get<App[]>("/api/apps"),
  createApp: (input: NewApp) => request<AppDetail>("POST", "/api/apps", input),
  app: (slug: string) => get<AppDetail>(app(slug)),
  patchApp: (slug: string, input: { name?: string; description?: string }) => request<AppDetail>("PATCH", app(slug), input),
  settings: (slug: string) => get<AppSettings>(`${app(slug)}/settings`),
  putWebhook: (slug: string, url: string | null) => request<AppSettings>("PUT", `${app(slug)}/webhook`, { url }),
  rotateWebhook: (slug: string) => request<AppSettings>("POST", `${app(slug)}/webhook/rotate`),
  testWebhook: (slug: string) => request<{ delivery_id: string }>("POST", `${app(slug)}/webhook/test`),
  createToken: (slug: string, name: string) => request<NewToken>("POST", `${app(slug)}/tokens`, { name }),
  deleteToken: (slug: string, id: string) => request<{ ok: true }>("DELETE", `${app(slug)}/tokens/${enc(id)}`),
  addMember: (slug: string, email: string) => request<AppSettings>("POST", `${app(slug)}/members`, { email }),
  removeMember: (slug: string, id: string) => request<AppSettings>("DELETE", `${app(slug)}/members/${enc(id)}`),
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
}

// Cache keys, so every page agrees on where a resource lives.
export const keys = {
  config: "config",
  me: "me",
  apps: "apps",
  app: (slug: string) => `app:${slug}`,
  settings: (slug: string) => `settings:${slug}`,
  issue: (slug: string, number: number) => `issue:${slug}:${number}`,
  /** All list pages of one app share this prefix; the rest of the key is the filter. */
  lists: (slug: string) => `issues:${slug}:`,
}

export const loadConfig = () => load(keys.config, api.config)
export const loadMe = () => load(keys.me, api.me)
export const currentMe = () => peek<Me>(keys.me)
