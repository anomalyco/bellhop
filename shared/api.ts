// The contract between the Worker (worker/) and the web app (src/). JSON over HTTP; times are ISO 8601 strings.
//
// Roles
// - guest: anyone, no account. Identified by an HttpOnly `bh_guest` cookie the Worker sets on first contact.
//   Writing (uploads, new issues, comments) also needs the `bh_human` cookie, set by POST /api/human after Turnstile.
// - member: signed in with Google, owner or member of the application.
// - agent: an MCP token scoped to one application (POST /mcp). Its posts carry the AI badge.
//
// Routes (all under the Worker; everything else is the single-page app)
//   GET    /api/config                                   -> Config
//   GET    /api/me                                       -> Me
//   POST   /api/human              { token }             -> { ok: true }       Turnstile check, sets bh_human (1 hour)
//   GET    /api/apps                                     -> App[]              member: applications I own or belong to
//   POST   /api/apps               NewApp                -> AppDetail          member; seeds default labels and templates
//   GET    /api/apps/:slug                               -> AppDetail          public
//   PATCH  /api/apps/:slug         { name?, description? } -> AppDetail        owner
//   GET    /api/apps/:slug/settings                      -> AppSettings        member
//   PUT    /api/apps/:slug/webhook { url: string|null }  -> AppSettings        owner
//   POST   /api/apps/:slug/webhook/rotate                -> AppSettings        owner; new signing secret
//   POST   /api/apps/:slug/webhook/test                  -> { delivery_id }    owner; sends a `ping` event
//   POST   /api/apps/:slug/tokens  { name }              -> NewToken           owner; the secret is only returned here
//   DELETE /api/apps/:slug/tokens/:id                    -> { ok: true }       owner
//   POST   /api/apps/:slug/members { email }             -> AppSettings        owner
//   DELETE /api/apps/:slug/members/:id                   -> AppSettings        owner
//   POST   /api/apps/:slug/labels  LabelInput            -> Label              member
//   PATCH  /api/apps/:slug/labels/:id LabelInput         -> Label              member
//   DELETE /api/apps/:slug/labels/:id                    -> { ok: true }       member
//   POST   /api/apps/:slug/templates TemplateInput       -> Template           member
//   PATCH  /api/apps/:slug/templates/:id TemplateInput   -> Template           member
//   DELETE /api/apps/:slug/templates/:id                 -> { ok: true }       member
//   GET    /api/apps/:slug/issues?state=open|closed&label=<name>&q=<text>&cursor=  -> IssueList   public
//   POST   /api/apps/:slug/issues  NewIssue              -> Issue              guest + human, or member
//   GET    /api/apps/:slug/issues/:number                -> Issue              public (system_info only for members)
//   PATCH  /api/apps/:slug/issues/:number IssuePatch     -> Issue              member; the guest author may edit title/body
//   POST   /api/apps/:slug/issues/:number/comments NewComment -> Comment        guest + human, or member
//   POST   /api/apps/:slug/issues/:number/relations { type, number } -> Issue   member
//   DELETE /api/apps/:slug/issues/:number/relations/:relation_id   -> Issue     member
//   POST   /api/apps/:slug/uploads?name=<file name>  body: raw bytes, Content-Type: the file's type -> Attachment
//                                                                             guest + human, or member. Images ≤ 10 MB,
//                                                                             video ≤ 100 MB, other files ≤ 25 MB
//   GET    /media/:attachment_id/:file_name              -> the file, with Range support (video seeking)
//   GET    /api/live/apps/:slug                          WebSocket, list page: LiveEvent
//   GET    /api/live/apps/:slug/issues/:number           WebSocket, issue page: LiveEvent
//   GET    /auth/google  ->  Google OAuth  ->  /auth/google/callback  (then redirect to ?next= or /)
//   GET    /auth/dev?email=<email>&next=<path>           only when DEV_LOGIN=1
//   POST   /auth/logout
//   POST   /mcp                                          MCP, Streamable HTTP, Authorization: Bearer <token>
//
// Errors: non-2xx responses carry ApiError. 401 = sign in, 403 = not allowed, 404, 409 (slug taken), 413 (too
// large), 428 = Turnstile needed (no or expired bh_human cookie), 429 = rate limited.

export type IssueStatus = "open" | "in_progress" | "waiting" | "closed"
/** Only set when status is "closed". */
export type CloseReason = "completed" | "not_planned" | "duplicate"
/** Stored one way. `blocks` reads as "blocked by" from the other side; `duplicate_of` as "duplicates". */
export type RelationType = "duplicate_of" | "related" | "blocks"

/** Who wrote or did something. Guests get an identicon seeded by `id` and a handle like `guest-7f3a`. */
export type Actor =
  | { type: "guest"; id: string; handle: string }
  | { type: "member"; id: string; name: string; avatar_url: string | null }
  | { type: "agent"; id: string; name: string }

export interface ApiError {
  error: { code: string; message: string }
}

export interface Config {
  turnstile_site_key: string
  google_enabled: boolean
  dev_login: boolean
}

export interface Me {
  user: { id: string; email: string; name: string; avatar_url: string | null } | null
  guest: { id: string; handle: string }
  /** True while the bh_human cookie is valid; otherwise run Turnstile and POST /api/human before writing. */
  human: boolean
}

export interface App {
  id: string
  /** URL slug: lowercase letters, digits and hyphens, 2–40 chars; reserved: api, auth, media, mcp, new, settings. */
  slug: string
  name: string
  description: string
  created_at: string
  /** The viewer's role in this application, null for guests. */
  role: "owner" | "member" | null
}

export interface NewApp {
  name: string
  slug: string
  description?: string
}

export interface AppDetail extends App {
  labels: Label[]
  templates: Template[]
  counts: { open: number; closed: number }
}

export interface AppSettings {
  webhook: { url: string | null; secret: string; deliveries: WebhookDelivery[] }
  tokens: AgentToken[]
  members: Member[]
  /** Absolute URL of the MCP endpoint, for the OpenCode config snippet. */
  mcp_url: string
}

export interface Member {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  role: "owner" | "member"
  /** False until that email has signed in once. */
  joined: boolean
}

export interface AgentToken {
  id: string
  /** Shown as the agent's name on its posts, e.g. "OpenCode". */
  name: string
  /** First characters of the secret, e.g. "bh_7f3a…", for recognising it. */
  preview: string
  created_at: string
  last_used_at: string | null
}

export interface NewToken extends AgentToken {
  /** The full secret, shown once. */
  token: string
}

export interface WebhookDelivery {
  id: string
  event: WebhookEventType
  status: "pending" | "delivered" | "failed"
  response_status: number | null
  attempts: number
  created_at: string
}

export interface Label {
  id: string
  name: string
  /** Hex without '#', e.g. "d73a4a". */
  color: string
  description: string
}

export interface LabelInput {
  name?: string
  color?: string
  description?: string
}

/** Issue templates. `title` and `body` prefill the new-issue form; `label_ids` are applied on submit. */
export interface Template {
  id: string
  name: string
  description: string
  title: string
  body: string
  label_ids: string[]
  /** Offer the "Attach system info" toggle, on by default. */
  ask_system_info: boolean
  position: number
}

export interface TemplateInput {
  name?: string
  description?: string
  title?: string
  body?: string
  label_ids?: string[]
  ask_system_info?: boolean
  position?: number
}

export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  kind: "image" | "video" | "file"
  /** Path under /media. Markdown in bodies references it as ![name](url); the web app renders video URLs as players. */
  url: string
}

/** Collected in the browser with the reporter's consent. Keys are human-readable ("OS", "Browser", "Screen", "GPU"). */
export type SystemInfo = Record<string, string>

/** The agent's live presence on an issue: the typing dots plus an optional short status line. */
export interface Activity {
  actor: Actor
  text: string | null
  expires_at: string
}

export interface IssueRef {
  id: string
  number: number
  title: string
  status: IssueStatus
  close_reason: CloseReason | null
}

export interface IssueSummary extends IssueRef {
  labels: Label[]
  author: Actor
  assignee: Actor | null
  comment_count: number
  created_at: string
  updated_at: string
  /** Set while an agent or member shows activity (typing/status). */
  activity: Activity | null
}

export interface Relation {
  id: string
  type: RelationType
  /** outgoing: this issue → other (e.g. this duplicates other); incoming: other → this. */
  direction: "outgoing" | "incoming"
  issue: IssueRef
}

export interface Issue extends IssueSummary {
  body: string
  attachments: Attachment[]
  relations: Relation[]
  /** null when none was attached; "hidden" when attached but the viewer isn't a member. */
  system_info: SystemInfo | "hidden" | null
  template_id: string | null
  /** True when the viewer wrote this issue (guest cookie or member). */
  viewer_is_author: boolean
  timeline: TimelineItem[]
}

export interface IssueList {
  issues: IssueSummary[]
  counts: { open: number; closed: number }
  next_cursor: string | null
}

export interface NewIssue {
  title: string
  body: string
  template_id?: string
  /** Uploads from POST /uploads by the same guest/member, not yet attached. */
  attachment_ids?: string[]
  system_info?: SystemInfo
}

export interface IssuePatch {
  title?: string
  body?: string
  status?: IssueStatus
  /** Required when status is "closed"; defaults to "completed". */
  close_reason?: CloseReason
  label_ids?: string[]
  /** Member id, or null to clear. */
  assignee_id?: string | null
}

export interface NewComment {
  body: string
  attachment_ids?: string[]
}

export interface Comment {
  id: string
  author: Actor
  body: string
  attachments: Attachment[]
  /** True when this comment was written by the issue's author (GitHub's "Author" tag). */
  by_issue_author: boolean
  created_at: string
  updated_at: string
}

export type IssueEventType =
  | "status_changed" // data: { from: IssueStatus, to: IssueStatus, close_reason: CloseReason | null }
  | "labeled" // data: { label: Label }
  | "unlabeled" // data: { label: Label }
  | "claimed" // data: {}  (actor took the issue; it becomes the assignee)
  | "assigned" // data: { assignee: Actor | null }
  | "related" // data: { relation: Relation }
  | "unrelated" // data: { relation: Relation }
  | "renamed" // data: { from: string, to: string }

export interface IssueEvent {
  id: string
  type: IssueEventType
  actor: Actor
  data: Record<string, unknown>
  created_at: string
}

export type TimelineItem =
  | { kind: "comment"; comment: Comment }
  | { kind: "event"; event: IssueEvent }

/** Server → client messages on the live WebSockets. Clients send nothing but pings ("ping" → "pong"). */
export type LiveEvent =
  | { type: "hello"; viewers: number; activity: Activity | null }
  | { type: "viewers"; count: number }
  | { type: "issue.created"; issue: IssueSummary } // list room
  | { type: "issue.updated"; issue: IssueSummary } // list and issue rooms
  | { type: "timeline.added"; issue_id: string; item: TimelineItem } // issue room
  | { type: "activity"; issue_id: string; activity: Activity | null } // list and issue rooms

// Webhooks. POST to the application's URL with JSON WebhookPayload and headers:
//   Bellhop-Event: <type>          Bellhop-Delivery: <delivery id>
//   Bellhop-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the webhook secret>
// Retried with backoff on non-2xx or timeout (10 s). Comments written by an agent token are not sent, so an agent
// never wakes itself.
export type WebhookEventType = "ping" | "issue.opened" | "issue.updated" | "comment.created"

export interface WebhookPayload {
  id: string
  type: WebhookEventType
  created_at: string
  app: { id: string; slug: string; name: string }
  /** Absent for ping. */
  issue?: IssueSummary & { url: string }
  comment?: Comment
  actor?: Actor
  /** For issue.updated: which fields changed. */
  changes?: string[]
  mcp_url: string
}

// MCP tools (POST /mcp, scoped to the token's application). Names and inputs:
//   list_issues    { state?: "open"|"closed", label?: string, query?: string, limit?: number }
//   get_issue      { number }                    full issue: body, timeline, attachments, relations, system info
//   search_issues  { query, limit? }             full-text over titles, bodies and comments; finds duplicates
//   get_attachment { id }                        images as MCP image content; video and files as an absolute URL
//   list_labels    {}
//   comment        { number, body }              posts with the AI badge; clears the token's activity
//   update_issue   { number, status?, close_reason?, labels?: string[] (names), title? }
//   relate_issues  { number, other_number, type: RelationType }
//   claim_issue    { number }                    assigns the agent, adds a "claimed" event
//   set_activity   { number, text?: string|null, clear?: boolean }   typing dots + short status; expires after 60 s
