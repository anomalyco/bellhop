import type {
  AgentAccess,
  Analytics,
  AuditPage,
  ApiError,
  App,
  AppAgent,
  AppDetail,
  AppSettings,
  AppVisibility,
  Block,
  Comment,
  Config,
  ConnectedAgent,
  ContactDetail,
  ContactPage,
  HelpdeskSettings,
  AppMode,
  IdentityKey,
  NewIdentityKey,
  Verification,
  FeedApp,
  FeedList,
  ImportJob,
  Invitation,
  Issue,
  IssueList,
  IssuePatch,
  IssueRef,
  IssueSubscription,
  LabelInput,
  Label,
  IssueSort,
  Me,
  Mentionable,
  ModerationReason,
  NewApp,
  NewComment,
  NewAgentToken,
  NewIssue,
  NewReportKey,
  NotificationSettings,
  OAuthApproval,
  OAuthRequest,
  Role,
  RelationType,
  ReportKey,
  ReportMetadata,
  Revision,
  SavedReply,
  SavedReplyInput,
  Person,
  Template,
  TemplateInput,
  Tier,
  TierInput,
  WebhookEventType,
} from "../../shared/api"
import { load, peek } from "./cache"
import { runHumanCheck } from "./human"
import { t } from "../i18n/core"

export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Where a transferred issue went (code "moved"). */
    readonly movedTo?: { slug: string; number: number; url: string },
    /** Seconds until a rate-limited request may be tried again (429 Retry-After). */
    readonly retryAfter?: number,
  ) {
    super(message)
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiFailure) {
    if (error.status === 501) return t("error.unavailable")
    return error.message
  }
  if (error instanceof Error && error.name === "TypeError") return t("error.offline")
  return error instanceof Error ? error.message : t("error.unknown")
}

/** An error response as an ApiFailure (for callers that read the response themselves, like /api/page). */
export async function failure(res: Response) {
  const body = (await res.json().catch(() => null)) as ApiError | null
  const wait = Number(res.headers.get("Retry-After"))
  return new ApiFailure(
    res.status,
    body?.error?.code ?? `http_${res.status}`,
    body?.error?.message ?? res.statusText,
    body?.error?.moved_to,
    Number.isFinite(wait) && wait > 0 ? wait : undefined,
  )
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

/** The page's own response already gave this browser its guest cookie (boot data): requests needn't queue. */
export function bootGuestReady() {
  markGuestReady()
}

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
  feed: (params: { state: "open" | "closed"; q?: string; cursor?: string }) => {
    const qs = new URLSearchParams({ state: params.state })
    if (params.q) qs.set("q", params.q)
    if (params.cursor) qs.set("cursor", params.cursor)
    return get<FeedList>(`/api/feed?${qs}`)
  },
  feedApps: () => get<FeedApp[]>("/api/feed/apps"),
  createApp: (input: NewApp) => request<AppDetail>("POST", "/api/apps", input),
  app: (slug: string) => get<AppDetail>(app(slug)),
  patchApp: (
    slug: string,
    input: { name?: string; description?: string; public?: boolean; visibility?: AppVisibility; nudge_days?: number | null; mode?: AppMode; helpdesk?: Partial<HelpdeskSettings> },
  ) => request<AppDetail>("PATCH", app(slug), input),
  settings: (slug: string) => get<AppSettings>(`${app(slug)}/settings`),
  putWebhook: (slug: string, url: string | null, events?: WebhookEventType[]) => request<AppSettings>("PUT", `${app(slug)}/webhook`, { url, events }),
  redeliver: (slug: string, id: string) => request<{ delivery_id: string }>("POST", `${app(slug)}/webhook/deliveries/${enc(id)}/redeliver`),
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
  issues: (slug: string, params: { state: "open" | "closed"; label?: string; q?: string; sort?: IssueSort; cursor?: string }) => {
    const qs = new URLSearchParams({ state: params.state })
    if (params.label) qs.set("label", params.label)
    if (params.q) qs.set("q", params.q)
    if (params.sort && params.sort !== "newest") qs.set("sort", params.sort)
    if (params.cursor) qs.set("cursor", params.cursor)
    return get<IssueList>(`${app(slug)}/issues?${qs}`)
  },
  createIssue: (slug: string, input: NewIssue) => request<Issue>("POST", `${app(slug)}/issues`, input),
  issue: (slug: string, number: number) => get<Issue>(`${app(slug)}/issues/${number}`),
  patchIssue: (slug: string, number: number, patch: IssuePatch) => request<Issue>("PATCH", `${app(slug)}/issues/${number}`, patch),
  deleteIssue: (slug: string, number: number) => request<{ ok: true }>("DELETE", `${app(slug)}/issues/${number}`),
  hideIssue: (slug: string, number: number, reason: ModerationReason) => request<Issue>("POST", `${app(slug)}/issues/${number}/hide`, { reason }),
  unhideIssue: (slug: string, number: number) => request<Issue>("DELETE", `${app(slug)}/issues/${number}/hide`),
  vote: (slug: string, number: number, on: boolean) =>
    request<{ votes: number; viewer_voted: boolean }>(on ? "POST" : "DELETE", `${app(slug)}/issues/${number}/vote`),
  helpful: (slug: string, number: number, id: string, on: boolean) =>
    request<{ helpful: number; viewer_helpful: boolean }>(on ? "POST" : "DELETE", `${app(slug)}/issues/${number}/comments/${enc(id)}/helpful`),
  transferIssue: (slug: string, number: number, to: string) => request<Issue>("POST", `${app(slug)}/issues/${number}/transfer`, { app: to }),
  mentionables: (slug: string) => get<Mentionable[]>(`${app(slug)}/mentionables`),
  issueHistory: (slug: string, number: number) => get<Revision[]>(`${app(slug)}/issues/${number}/history`),
  patchComment: (slug: string, number: number, id: string, body: string) =>
    request<Comment>("PATCH", `${app(slug)}/issues/${number}/comments/${enc(id)}`, { body }),
  deleteComment: (slug: string, number: number, id: string) => request<{ ok: true }>("DELETE", `${app(slug)}/issues/${number}/comments/${enc(id)}`),
  hideComment: (slug: string, number: number, id: string, reason: ModerationReason) =>
    request<Comment>("POST", `${app(slug)}/issues/${number}/comments/${enc(id)}/hide`, { reason }),
  unhideComment: (slug: string, number: number, id: string) => request<Comment>("DELETE", `${app(slug)}/issues/${number}/comments/${enc(id)}/hide`),
  commentHistory: (slug: string, number: number, id: string) => get<Revision[]>(`${app(slug)}/issues/${number}/comments/${enc(id)}/history`),
  tiers: (slug: string) => get<Tier[]>(`${app(slug)}/tiers`),
  createTier: (slug: string, input: TierInput) => request<Tier>("POST", `${app(slug)}/tiers`, input),
  patchTier: (slug: string, id: string, input: TierInput) => request<Tier>("PATCH", `${app(slug)}/tiers/${enc(id)}`, input),
  deleteTier: (slug: string, id: string) => request<{ ok: true }>("DELETE", `${app(slug)}/tiers/${enc(id)}`),
  people: (slug: string, params: { tier?: string; q?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.tier) qs.set("tier", params.tier)
    if (params.q) qs.set("q", params.q)
    return get<Person[]>(`${app(slug)}/people${qs.size ? `?${qs}` : ""}`)
  },
  /** By email (applies when they sign in) or by actor id; tier_id null removes it. */
  setTier: (slug: string, who: { email: string } | { actor_id: string }, tierId: string | null) =>
    request<Person>("PUT", `${app(slug)}/people/tier`, { ...who, tier_id: tierId }),
  blocks: (slug: string) => get<Block[]>(`${app(slug)}/blocks`),
  block: (slug: string, actorId: string, hideContent: boolean) => request<Block>("POST", `${app(slug)}/blocks`, { actor_id: actorId, hide_content: hideContent }),
  unblock: (slug: string, id: string) => request<{ ok: true }>("DELETE", `${app(slug)}/blocks/${enc(id)}`),
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
  myReports: (params: { state: "open" | "closed"; cursor?: string }) => {
    const qs = new URLSearchParams({ state: params.state })
    if (params.cursor) qs.set("cursor", params.cursor)
    return get<FeedList>(`/api/me/reports?${qs}`)
  },
  notifications: () => get<NotificationSettings>("/api/me/notifications"),
  patchNotifications: (patch: Partial<Omit<NotificationSettings, "email">>) => request<NotificationSettings>("PATCH", "/api/me/notifications", patch),
  subscription: (slug: string, number: number) => get<IssueSubscription>(`${app(slug)}/issues/${number}/subscription`),
  /** Guests send `email` the first time; it stays pending until they confirm the link. */
  subscribe: (slug: string, number: number, subscribed: boolean, email?: string) =>
    request<IssueSubscription>("PUT", `${app(slug)}/issues/${number}/subscription`, { subscribed, email }),
  similar: (slug: string, title: string) => get<IssueRef[]>(`${app(slug)}/issues/similar?title=${enc(title)}`),
  metadata: (slug: string, id: string) => get<ReportMetadata>(`${app(slug)}/metadata/${enc(id)}`),
  removeMetadataItems: (slug: string, id: string, items: { logs?: string[]; system?: string[]; context?: string[] }) =>
    request<ReportMetadata>("DELETE", `${app(slug)}/metadata/${enc(id)}/items`, items),
  reportKeys: (slug: string) => get<ReportKey[]>(`${app(slug)}/report-keys`),
  createReportKey: (slug: string, name: string) => request<NewReportKey>("POST", `${app(slug)}/report-keys`, { name }),
  deleteReportKey: (slug: string, id: string) => request<{ ok: true }>("DELETE", `${app(slug)}/report-keys/${enc(id)}`),
  invitations: () => get<Invitation[]>("/api/me/invitations"),
  acceptInvitation: (id: string) => request<App>("POST", `/api/me/invitations/${enc(id)}/accept`),
  declineInvitation: (id: string) => request<{ ok: true }>("POST", `/api/me/invitations/${enc(id)}/decline`),
  /** Leave a workspace you're on (not as its last owner). */
  leaveApp: (slug: string) => request<{ ok: true }>("DELETE", `${app(slug)}/members/me`),
  analytics: (slug: string, days: 7 | 30 | 90) => get<Analytics>(`${app(slug)}/analytics?days=${days}`),
  audit: (slug: string, params: { actor?: string; action?: string; cursor?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.actor) qs.set("actor", params.actor)
    if (params.action) qs.set("action", params.action)
    if (params.cursor) qs.set("cursor", params.cursor)
    return get<AuditPage>(`${app(slug)}/audit${qs.size ? `?${qs}` : ""}`)
  },
  /** The workspace as NDJSON; a plain link downloads it (same-origin cookies), this is the URL. */
  exportUrl: (slug: string) => `${app(slug)}/export`,
  importGitHub: (slug: string, input: { repo: string; token: string; state?: "open" | "all" }) => request<ImportJob>("POST", `${app(slug)}/import/github`, input),
  importJob: (slug: string, id: string) => get<ImportJob>(`${app(slug)}/import/${enc(id)}`),
  savedReplies: (slug: string) => get<SavedReply[]>(`${app(slug)}/saved-replies`),
  createSavedReply: (slug: string, input: SavedReplyInput) => request<SavedReply>("POST", `${app(slug)}/saved-replies`, input),
  patchSavedReply: (slug: string, id: string, input: SavedReplyInput) => request<SavedReply>("PATCH", `${app(slug)}/saved-replies/${enc(id)}`, input),
  deleteSavedReply: (slug: string, id: string) => request<{ ok: true }>("DELETE", `${app(slug)}/saved-replies/${enc(id)}`),
  // Help desk: contacts sign in on the workspace's host with an email code
  contactStart: (slug: string, email: string) => request<{ ok: true }>("POST", `${app(slug)}/contact/start`, { email }),
  contactVerify: (slug: string, email: string, code: string) => request<Me>("POST", `${app(slug)}/contact/verify`, { email, code }),
  contactSignOut: (slug: string) => request<Me>("POST", `${app(slug)}/contact/sign-out`),
  contacts: (slug: string, params: { q?: string; cursor?: string } = {}) => {
    const qs = new URLSearchParams()
    if (params.q) qs.set("q", params.q)
    if (params.cursor) qs.set("cursor", params.cursor)
    return get<ContactPage>(`${app(slug)}/contacts${qs.size ? `?${qs}` : ""}`)
  },
  contact: (slug: string, id: string) => get<ContactDetail>(`${app(slug)}/contacts/${enc(id)}`),
  identityKeys: (slug: string) => get<IdentityKey[]>(`${app(slug)}/identity-keys`),
  createIdentityKey: (slug: string, name: string) => request<NewIdentityKey>("POST", `${app(slug)}/identity-keys`, { name }),
  deleteIdentityKey: (slug: string, id: string) => request<{ ok: true }>("DELETE", `${app(slug)}/identity-keys/${enc(id)}`),
  requestVerification: (slug: string, number: number, email: string) =>
    request<Verification>("POST", `${app(slug)}/issues/${number}/verifications`, { email }),
  confirmVerification: (slug: string, number: number, id: string, code: string) =>
    request<Verification>("POST", `${app(slug)}/issues/${number}/verifications/${enc(id)}/confirm`, { code }),
  // Account sign-in by email code (blhp.app)
  emailStart: (email: string) => request<{ ok: true }>("POST", "/auth/email/start", { email }),
  emailVerify: (email: string, code: string) => request<{ ok: true }>("POST", "/auth/email/verify", { email, code }),
}

// Cache keys, so every page agrees on where a resource lives.
export const keys = {
  config: "config",
  me: "me",
  apps: "apps",
  agents: "agents",
  /** Every page of the home feed shares this prefix; the rest is the state and search. */
  feed: "feed:",
  feedApps: "feed-apps",
  app: (slug: string) => `app:${slug}`,
  settings: (slug: string) => `settings:${slug}`,
  appAgents: (slug: string) => `app-agents:${slug}`,
  issue: (slug: string, number: number) => `issue:${slug}:${number}`,
  /** Earlier versions of an issue (commentId omitted) or of one comment. */
  history: (slug: string, number: number, commentId?: string) => `history:${slug}:${number}:${commentId ?? "issue"}`,
  blocks: (slug: string) => `blocks:${slug}`,
  mentionables: (slug: string) => `mentionables:${slug}`,
  tiers: (slug: string) => `tiers:${slug}`,
  /** Every people list of an app shares this prefix; then the tier id ("" for all). */
  people: (slug: string, tier = "") => `people:${slug}:${tier}`,
  /** All list pages of one app share this prefix; the rest of the key is the filter. */
  lists: (slug: string) => `issues:${slug}:`,
  /** "Your reports" pages share this prefix; then the state. */
  reports: "reports:",
  notifications: "notifications",
  subscription: (slug: string, number: number) => `subscription:${slug}:${number}`,
  metadata: (slug: string, id: string) => `metadata:${slug}:${id}`,
  reportKeys: (slug: string) => `report-keys:${slug}`,
  similar: (slug: string, title: string) => `similar:${slug}:${title}`,
  invitations: "invitations",
  analytics: (slug: string, days: number) => `analytics:${slug}:${days}`,
  /** Every audit page of an app shares this prefix; then the actor and action filters. */
  audit: (slug: string, actor = "", action = "") => `audit:${slug}:${actor}|${action}`,
  savedReplies: (slug: string) => `saved-replies:${slug}`,
  importJob: (slug: string, id: string) => `import:${slug}:${id}`,
  /** Every contacts page of an app shares this prefix; then the search. */
  contacts: (slug: string, q = "") => `contacts:${slug}:${q}`,
  contact: (slug: string, id: string) => `contact:${slug}:${id}`,
  identityKeys: (slug: string) => `identity-keys:${slug}`,
}

export const loadConfig = () => load(keys.config, api.config)
export const loadMe = () => load(keys.me, api.me)
export const currentMe = () => peek<Me>(keys.me)
