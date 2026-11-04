// The contract between the Worker (worker/) and the web app (src/). JSON over HTTP; times are ISO 8601 strings.
//
// Roles
// - guest: anyone, no account. Identified by an HttpOnly `bh_guest` cookie the Worker sets on first contact, so
//   one browser (one machine) is one guest. A guest picks a display name before their first post; it's kept per
//   browser and stamped on what they write.
//   Writing (uploads, new issues, comments) also needs the `bh_human` cookie, set by POST /api/human after Turnstile.
// - account: signed in with Google. Posts as their account on every app (no Turnstile), whether or not they're on
//   that app's team. Signing in claims everything this browser wrote as a guest: those posts move to the account
//   and open pages update live (`actor.updated`).
// - team: an account with a Role in the application. Each role includes the ones below it:
//     viewer  reads everything in the app (system info; later private issues and internal notes) and posts like any
//             account
//     member  + triage: status, labels on issues, assignee, relations, claim
//     admin   + workspace setup: name, description, icon, labels, templates, webhooks, agents and tokens, members up
//             to admin
//     owner   + owners and admins, ownership transfer, deleting the app; an app always keeps at least one owner
// - agent: belongs to an account, not a workspace. Either an OAuth connection (an MCP client signed in through
//   /oauth) or a token agent the account created (a static secret). Either way it lists the workspaces it may use
//   (only ones where the account has a role) with an AgentRole per app, or covers all of them ("all workspaces",
//   which includes ones the account creates or joins later) at one role, with per-app overrides or exclusions:
//     viewer (read only) < responder (+ comment, activity, votes) < member (+ triage) < admin (+ workspace setup).
//     An OAuth agent never exceeds the approving user's current role (an owner's agent is at most admin). Grants may
//     also allow creating workspaces: the approving user owns them and the agent gets admin. Agent posts carry the AI
//     badge.
//
// Routes (all under the Worker; everything else is the single-page app)
//   GET    /api/config                                   -> Config
//   GET    /api/me                                       -> Me
//   POST   /api/human              { token }             -> { ok: true }       Turnstile check, sets bh_human (1 hour)
//   PUT    /api/me/guest           { name }              -> Me                 guest + human; sets the display name
//   GET    /api/apps                                     -> App[]              signed in: workspaces I'm on
//   GET    /api/feed?state=open|closed&q=<text>&cursor=  -> FeedList           public: issues in public workspaces,
//                                                                             most recently active first (blhp.app home)
//   GET    /api/feed/apps                                -> FeedApp[]          public: the public workspaces
//   POST   /api/apps               NewApp                -> AppDetail          member; seeds default labels and templates
//   GET    /api/apps/:slug                               -> AppDetail          public
//   PATCH  /api/apps/:slug         { name?, description?, public?, visibility? } -> AppDetail   admin
//   POST   /api/apps/:slug/transfer { member_id }        -> AppSettings        owner; that member becomes an owner too
//   PUT    /api/apps/:slug/icon    body: raw image bytes, Content-Type png/jpeg/webp, ≤ 1 MB -> AppDetail  admin
//   DELETE /api/apps/:slug/icon                          -> AppDetail          admin; back to the Bellhop mark
//   GET    /icon/:slug/:version                          -> the app's icon (public, immutable; SVG is not accepted)
//   GET    /api/apps/:slug/settings                      -> AppSettings        member
//   PUT    /api/apps/:slug/webhook { url: string|null }  -> AppSettings        admin
//   POST   /api/apps/:slug/webhook/rotate                -> AppSettings        admin; new signing secret
//   POST   /api/apps/:slug/webhook/test                  -> { delivery_id }    admin; sends a `ping` event
//   GET    /api/apps/:slug/agents                        -> AppAgent[]         admin; every agent with access here
//   PATCH  /api/apps/:slug/agents/:id { role }           -> AppAgent           admin; capped at the approver's role
//   DELETE /api/apps/:slug/agents/:id                    -> { ok: true }       admin; removes this app from the agent
//                                                                             (an exclusion if it has all workspaces)
//   POST   /api/apps/:slug/members { email, role? }      -> AppSettings        admin; role defaults to "member"
//   PATCH  /api/apps/:slug/members/:id { role }          -> AppSettings        admin
//   DELETE /api/apps/:slug/members/:id                   -> AppSettings        admin
//          Granting, changing or removing admin/owner needs an owner; the last owner can't be removed or demoted.
//   POST   /api/apps/:slug/labels  LabelInput            -> Label              admin
//   PATCH  /api/apps/:slug/labels/:id LabelInput         -> Label              admin
//   DELETE /api/apps/:slug/labels/:id                    -> { ok: true }       admin
//   POST   /api/apps/:slug/templates TemplateInput       -> Template           admin
//   PATCH  /api/apps/:slug/templates/:id TemplateInput   -> Template           admin
//   DELETE /api/apps/:slug/templates/:id                 -> { ok: true }       admin
//   GET    /api/apps/:slug/issues?state=open|closed&label=<name>&q=<text>&sort=<IssueSort>&cursor=  -> IssueList
//          public; private
//          issues only for the team and their reporter; hidden issues only for the team (q "is:hidden" lists them)
//   POST   /api/apps/:slug/issues  NewIssue              -> Issue              guest + human, or member
//   GET    /api/apps/:slug/issues/:number                -> Issue              public (system_info only for the team)
//   PATCH  /api/apps/:slug/issues/:number IssuePatch     -> Issue              member; the author (guest + human, or
//          account) may edit title/body, close it (completed or not_planned) or reopen it, and set `private` when the
//          app lets reporters choose
//   DELETE /api/apps/:slug/issues/:number                -> { ok: true }       admin; permanent (comments, attachments,
//          events, relations). The number stays taken: GET then answers 410 with code "deleted".
//   POST   /api/apps/:slug/issues/:number/hide { reason: ModerationReason } -> Issue   member
//   DELETE /api/apps/:slug/issues/:number/hide           -> Issue              member; unhide
//   GET    /api/apps/:slug/issues/:number/history        -> Revision[]         whoever can see the issue; title/body
//   POST   /api/apps/:slug/issues/:number/vote           -> { votes, viewer_voted }   guest + human, or account ("Me too")
//   DELETE /api/apps/:slug/issues/:number/vote           -> { votes, viewer_voted }
//   POST   /api/apps/:slug/issues/:number/transfer { app } -> Issue           member in both apps; moves it to `app`
//          (slug) with a new number. Labels carry over by name, the assignee only if on that team; relations drop.
//          The old URL then answers 404 with code "moved" and `moved_to`.
//   GET    /api/apps/:slug/mentionables                  -> Mentionable[]      team (viewer and up): @ autocomplete
//   PATCH  /api/apps/:slug/issues/:number/comments/:id { body } -> Comment     the author (guest + human, or account)
//   DELETE /api/apps/:slug/issues/:number/comments/:id   -> { ok: true }       the author, or member
//   POST   /api/apps/:slug/issues/:number/comments/:id/hide { reason } -> Comment   member
//   DELETE /api/apps/:slug/issues/:number/comments/:id/hide -> Comment         member
//   GET    /api/apps/:slug/issues/:number/comments/:id/history -> Revision[]   whoever can see the comment
//   POST   /api/apps/:slug/issues/:number/comments/:id/helpful -> { helpful, viewer_helpful }   guest + human, or
//          account; not the comment's author ("This helped")
//   DELETE /api/apps/:slug/issues/:number/comments/:id/helpful -> { helpful, viewer_helpful }
//   GET    /api/apps/:slug/blocks                        -> Block[]            member
//   POST   /api/apps/:slug/blocks { actor_id, hide_content? } -> Block         member; a guest (per-app id) or account
//          that isn't on the team. Blocked actors get 403 code "blocked" on posting, editing and uploading here.
//          hide_content hides everything they wrote here (reason "spam").
//   DELETE /api/apps/:slug/blocks/:id                    -> { ok: true }       member; doesn't unhide content
//   POST   /api/apps/:slug/issues/:number/comments NewComment -> Comment        guest + human, or member
//   POST   /api/apps/:slug/issues/:number/relations { type, number } -> Issue   member
//   DELETE /api/apps/:slug/issues/:number/relations/:relation_id   -> Issue     member
//   POST   /api/apps/:slug/uploads?name=<file name>  body: raw bytes, Content-Type: the file's type -> Attachment
//                                                                             guest + human, or member. Images ≤ 10 MB,
//                                                                             video ≤ 100 MB, other files ≤ 25 MB
//   GET    /media/:attachment_id/:file_name              -> the file, with Range support (video seeking). Attachments
//          of public issues are public and edge-cacheable; of private or hidden issues, and of hidden comments, only
//          for whoever can see them (404 otherwise, never cached publicly).
//   GET    /api/live/apps/:slug                          WebSocket, list page: LiveEvent
//   GET    /api/live/apps/:slug/issues/:number           WebSocket, issue page: LiveEvent
//   GET    /api/live/feed                                WebSocket, home feed: LiveEvent (feed.issue, activity)
// Search engines, answered by the Worker per host:
//   GET    /robots.txt    home and public workspaces: allow all, with a Sitemap line; private workspaces: Disallow: /
//   GET    /sitemap.xml   home: a sitemap index of the public workspaces; a public workspace: its issue URLs (lastmod)
//   Page requests (HTML) go through the Worker, which serves the SPA's index.html unchanged except for status and
//   headers: private workspaces get X-Robots-Tag: noindex, and an unknown workspace subdomain answers 404.
//   GET    /auth/google  ->  Google OAuth  ->  /auth/google/callback  (then redirect to ?next= or /)
//   GET    /auth/dev?email=<email>&next=<path>           only when DEV_LOGIN=1
//   POST   /auth/logout
//   POST   /mcp                                          MCP, Streamable HTTP, Authorization: Bearer <token>
//                                                         (an app's agent token, or an OAuth access token; see below)
//
// OAuth for agents (MCP clients). blhp.app is both the authorization server and the protected resource; OAuth 2.1
// public clients with PKCE (S256) only. A grant names the workspaces (apps) the agent may use; on each one it acts
// with at most the approving user's role there, and posts as an agent (AI badge) named by the client.
//   GET    /.well-known/oauth-protected-resource        RFC 9728 metadata for https://blhp.app/mcp
//   GET    /.well-known/oauth-authorization-server      RFC 8414 metadata (issuer https://blhp.app)
//          /mcp without a valid token -> 401, WWW-Authenticate: Bearer resource_metadata="<protected-resource URL>"
//   POST   /oauth/register         RFC 7591 dynamic registration { client_name, redirect_uris } -> { client_id, ... }
//   GET    /oauth/authorize        authorization code + PKCE; signs the user in if needed, then -> /oauth/consent?request=<id>
//   POST   /oauth/device           RFC 8628 { client_id } -> { device_code, user_code, verification_uri (/device),
//                                   verification_uri_complete, expires_in, interval }   ("polling" sign-in for headless agents)
//   POST   /oauth/token            grant_type authorization_code | refresh_token | urn:ietf:params:oauth:grant-type:device_code
//                                   -> { access_token (1 h), refresh_token (rotating), token_type: "Bearer", expires_in, scope }
//                                   device polling errors: authorization_pending, slow_down, access_denied, expired_token
//   POST   /oauth/revoke           RFC 7009
// Pages on blhp.app (the web app): /oauth/consent?request=<id> and /device (enter or confirm a user code).
//   GET    /api/oauth/requests/:id                      -> OAuthRequest       member (the signed-in user)
//   POST   /api/oauth/device/lookup { user_code }       -> { request_id }     signed in
//   POST   /api/oauth/requests/:id/approve OAuthApproval -> { redirect_to: string | null }  null for device requests
//   POST   /api/oauth/requests/:id/deny                 -> { redirect_to: string | null }
// Agents on the account (OAuth connections and token agents):
//   GET    /api/me/agents                               -> ConnectedAgent[]
//   POST   /api/me/agents AgentAccess & { name }         -> NewAgentToken      a token agent; the secret is only
//                                                                             returned here
//   PATCH  /api/me/agents/:id Partial<AgentAccess> & { name? } -> ConnectedAgent   `apps` replaces the overrides
//   POST   /api/me/agents/:id/rotate                    -> NewAgentToken      token agents: new secret, old one stops
//   DELETE /api/me/agents/:id                           -> { ok: true }       revokes it and all its tokens
//
// Errors: non-2xx responses carry ApiError. 401 = sign in, 403 = not allowed, 404, 409 (slug taken), 413 (too
// large), 428 = Turnstile needed (no or expired bh_human cookie), 429 = rate limited. A guest posting without a
// display name (none saved and no guest_name sent) gets 400 with code "name_required".

export type IssueStatus = "open" | "in_progress" | "waiting" | "closed"
/** Only set when status is "closed". */
export type CloseReason = "completed" | "not_planned" | "duplicate"
/** Stored one way. `blocks` reads as "blocked by" from the other side; `duplicate_of` as "duplicates". */
export type RelationType = "duplicate_of" | "related" | "blocks"

/** Who wrote or did something. Guests have a handle like `guest-7f3a` and, once chosen, a display name. */
export type Actor =
  | { type: "guest"; id: string; handle: string; name: string | null }
  // A signed-in account (the type name predates non-team accounts). `role` is its current role in this app, filled
  // in on read; null or absent means signed in but not on the team.
  | { type: "member"; id: string; name: string; avatar_url: string | null; role?: Role | null }
  | { type: "agent"; id: string; name: string }

export interface ApiError {
  /** `moved_to` comes with code "moved" (the issue was transferred). */
  error: { code: string; message: string; moved_to?: { slug: string; number: number; url: string } }
}

export interface Config {
  turnstile_site_key: string
  google_enabled: boolean
  dev_login: boolean
}

export interface Me {
  user: { id: string; email: string; name: string; avatar_url: string | null } | null
  /** `name` is the display name this browser chose (null until set); the same across apps. */
  guest: { id: string; handle: string; name: string | null }
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
  /** The app's own icon (favicon and top-left logo on its pages), or null for the Bellhop mark. Versioned URL. */
  icon_url: string | null
  /** The viewer's role in this application; null for guests and accounts not on the team. */
  role: Role | null
  /**
   * Public workspaces are listed in the blhp.app feed and indexed by search engines. Private ones still work for
   * anyone with the link, but are never listed, in the feed, in sitemaps or indexed.
   */
  public: boolean
}

export interface NewApp {
  name: string
  slug: string
  description?: string
  /** Defaults to false (private). */
  public?: boolean
}

/** A public workspace, for the home feed. */
export interface FeedApp {
  slug: string
  name: string
  description: string
  icon_url: string | null
  open_count: number
}

/** An issue in the home feed, with the workspace it belongs to. */
export interface FeedIssue extends IssueSummary {
  app: { slug: string; name: string; icon_url: string | null }
}

export interface FeedList {
  issues: FeedIssue[]
  counts: { open: number; closed: number }
  next_cursor: string | null
}

export interface AppDetail extends App {
  labels: Label[]
  templates: Template[]
  /** What the viewer can see: includes private issues only for the team. */
  counts: { open: number; closed: number }
  visibility: AppVisibility
}

/** Whether new issues are public, and whether reporters may choose. The team can always change an issue's privacy. */
export interface AppVisibility {
  default: "public" | "private"
  reporter_can_choose: boolean
}

/** Why a moderator hid an issue or comment. */
export type ModerationReason = "spam" | "abuse" | "off_topic"

export interface Moderation {
  reason: ModerationReason
  by: Actor
  at: string
}

/** A blocked guest or account in one app. */
export interface Block {
  id: string
  actor: Actor
  by: Actor
  created_at: string
}

/** Someone who can be @mentioned in an app: team members and agents with access. */
export interface Mentionable {
  type: "member" | "agent"
  id: string
  name: string
  /** What follows the @: [a-z0-9-], unique in the app, stable while the name doesn't change (e.g. "ryan", "opencode"). */
  handle: string
  avatar_url: string | null
}

/** A resolved @handle in a body. Only posts by the team and agents create mentions; guests' @text stays text. */
export interface Mention {
  handle: string
  actor: Actor
}

export type IssueSort = "newest" | "oldest" | "votes" | "updated" | "comments"

/** An earlier version of an issue's title/body or a comment's body (newest first; the current one isn't included). */
export interface Revision {
  id: string
  actor: Actor
  title: string | null
  body: string
  created_at: string
}

export interface AppSettings {
  webhook: { url: string | null; secret: string; deliveries: WebhookDelivery[] }
  members: Member[]
  /** Absolute URL of the MCP endpoint, for the OpenCode config snippet. */
  mcp_url: string
}

export interface Member {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  role: Role
  /** False until that email has signed in once. */
  joined: boolean
}

/** A token agent just created or rotated: the full secret is shown once. */
export interface NewAgentToken extends ConnectedAgent {
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

/** A team role in one application; see the Roles notes at the top. */
export type Role = "owner" | "admin" | "member" | "viewer"
/** What an agent may do in one application; see the Roles notes at the top. */
export type AgentRole = "admin" | "member" | "responder" | "viewer"

/** An agent with access to this application (settings, admins only); it belongs to `approved_by`'s account. */
export interface AppAgent {
  /** The agent's id. */
  id: string
  kind: "oauth" | "token"
  client_name: string
  approved_by: { name: string; avatar_url: string | null }
  role: AgentRole
  /** The most this agent can be here: the approving user's current role, capped at admin. */
  max_role: AgentRole
  created_at: string
  last_used_at: string | null
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
  /** Visible only to the team, agents and the reporter. */
  private: boolean
  /** Set when a moderator hid it; only the team and agents see hidden issues. */
  hidden: Moderation | null
  /** "Me too" votes: distinct voters on this issue and on issues marked duplicate_of it. */
  votes: number
  viewer_voted: boolean
  /** Only the team and agents can comment on a locked issue (votes still work). */
  locked: boolean
  /** Pinned issues lead the list (at most 3 per app). */
  pinned: boolean
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
  /** When the title or body last changed after posting; GET .../history has the earlier versions. */
  edited_at: string | null
  /** @mentions in the body. */
  mentions: Mention[]
  timeline: TimelineItem[]
}

export interface IssueList {
  issues: IssueSummary[]
  /** The app's pinned issues the viewer may see; on the first page only (no cursor), whatever the filters. */
  pinned: IssueSummary[]
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
  /** Guests only: sets the display name (1–40 characters) before posting, same as PUT /api/me/guest. */
  guest_name?: string
  /** Only honoured when the app lets reporters choose (or for the team); otherwise the app's default applies. */
  private?: boolean
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
  private?: boolean
  /** Member. */
  locked?: boolean
  /** Member; 409 code "pin_limit" past 3. */
  pinned?: boolean
}

export interface NewComment {
  body: string
  /** Team only: an internal note, seen by the team and agents, never by guests or the reporter. */
  internal?: boolean
  attachment_ids?: string[]
  /** Guests only: sets the display name (1–40 characters) before posting, same as PUT /api/me/guest. */
  guest_name?: string
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
  /** When the body last changed after posting; GET .../history has the earlier versions. */
  edited_at: string | null
  /** Set when a moderator hid it. Outside the team, a hidden comment comes with an empty body and no attachments. */
  hidden: Moderation | null
  /** True when the viewer wrote it (may edit and delete it). */
  viewer_is_author: boolean
  /** An internal note: only the team and agents ever receive it (API, live, search, counts, feeds). */
  internal: boolean
  /** "This helped" marks. */
  helpful: number
  viewer_helpful: boolean
  mentions: Mention[]
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
  | "hidden" // data: { reason: ModerationReason }   (team-only timeline item)
  | "unhidden" // data: {}                           (team-only timeline item)
  | "made_private" // data: {}
  | "made_public" // data: {}
  | "locked" // data: {}
  | "unlocked" // data: {}
  | "pinned" // data: {}
  | "unpinned" // data: {}
  | "transferred" // data: { from: { slug: string, number: number } }

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
  // An actor changed identity: a guest renamed, or a guest's posts moved to their account on sign-in. Sent to the
  // app room and every issue room where `previous_id` appears; clients replace that actor everywhere they show it.
  | { type: "actor.updated"; previous_id: string; actor: Actor }
  // Edited, hidden or unhidden. Each socket gets the view its viewer is allowed (e.g. no body when hidden).
  | { type: "comment.updated"; issue_id: string; comment: Comment }
  | { type: "comment.deleted"; issue_id: string; comment_id: string } // issue room
  | { type: "issue.deleted"; issue_id: string; number: number } // list and issue rooms
  | { type: "issue.moved"; issue_id: string; to: { slug: string; number: number; url: string } } // source app's rooms
// Rooms filter per socket: private issues and hidden issues/comments only reach sockets whose viewer may see them
// (the team; for private issues also the reporter); internal notes only reach team sockets, and counts
// (comment_count) are per viewer. `viewer_*` fields in live payloads describe that socket's viewer.
  | { type: "feed.issue"; issue: FeedIssue } // feed room: an issue in a public workspace was opened or changed

// Webhooks. POST to the application's URL with JSON WebhookPayload and headers:
//   Bellhop-Event: <type>          Bellhop-Delivery: <delivery id>
//   Bellhop-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the webhook secret>
// Retried with backoff on non-2xx or timeout (10 s). Comments written by an agent token are not sent, so an agent
// never wakes itself.
// mention.created: once per newly @mentioned team member or agent per write (posting or editing), never for
// self-mentions; an agent mentioned by another agent does get it (that's how one hands work to another).
// Internal notes are delivered too, with comment.internal true.
export type WebhookEventType = "ping" | "issue.opened" | "issue.updated" | "comment.created" | "mention.created"

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
  /** For mention.created: who was mentioned (the comment, or the issue body when there is no comment). */
  mentioned?: Actor
  mcp_url: string
}

// MCP tools (POST /mcp). An app token is scoped to its app; an OAuth token to the apps in its grant. Every issue tool
// takes an optional `app` (slug), required when the token covers more than one app. Names and inputs:
//   list_apps      {}                            the apps this agent can use now (all_workspaces included), with
//                                                  its effective AgentRole in each
//   create_app     { name, slug, description? }  grants allowed to create workspaces; the approving user owns it, the
//                                                  agent joins it as admin
//   Tool roles: read tools viewer; comment and set_activity responder; triage tools member; workspace setup admin.
//   list_issues    { state?: "open"|"closed", label?: string, query?: string, sort?: IssueSort, limit?: number }
//   get_issue      { number }                    full issue: body, timeline, attachments, relations, system info
//   search_issues  { query, limit? }             full-text over titles, bodies and comments; finds duplicates
//   get_attachment { id }                        images as MCP image content; video and files as an absolute URL
//   list_labels    {}
//   comment        { number, body, internal? }   posts with the AI badge; clears the agent's activity; internal
//                                                  makes it a team-only note; @handle mentions (list_mentionables)
//   list_mentionables {}                         team members and agents with their @handles
//   transfer_issue { number, to_app }            member in both apps
//   edit_comment   { comment_id, body }          the agent's own comments
//   moderate       { number, comment_id?, action: "hide"|"unhide", reason? }   member; hides or unhides the issue,
//                                                  or one comment; reason required for hide
//   update_issue   { number, status?, close_reason?, labels?: string[] (names), title?, private?, locked?, pinned? }
//   relate_issues  { number, other_number, type: RelationType }
//   claim_issue    { number }                    assigns the agent, adds a "claimed" event
//   set_activity   { number, text?: string|null, clear?: boolean }   typing dots + short status; expires after 60 s
//   Workspace setup (same roles as the REST routes: owner for the app itself and webhooks; member for labels and
//   templates). Labels and templates are named by name, matched case-insensitively.
//   get_app        {}                            name, description, icon, counts, labels, templates
//   update_app     { name?, description? }       owner
//   get_webhook    {}                            URL, whether a secret is set, recent deliveries
//   set_webhook    { url: string|null }          https only; null removes it
//   rotate_webhook_secret {}                     returns the new secret once
//   test_webhook   {}                            sends a ping, returns the delivery id
//   create_label   { name, color?, description? }
//   update_label   { name, new_name?, color?, description? }
//   delete_label   { name }                      removes it from issues too
//   list_templates {}
//   create_template { name, description?, title?, body?, labels?: string[] (names), ask_system_info?, position? }
//   update_template { name, new_name?, description?, title?, body?, labels?, ask_system_info?, position? }
//   delete_template { name }
//   list_members   {}
//   invite_member  { email, role? }              admin; admin/owner roles need the approving user to be an owner
//   set_member_role { email, role }              same caps; the last owner stays
//   remove_member  { email }

/** The consent page's request: who is asking and which of the user's apps they can grant. */
export interface OAuthRequest {
  id: string
  kind: "authorization_code" | "device"
  client_name: string
  /** For authorization_code: the host the user will be sent back to. */
  redirect_host: string | null
  /** The user's apps, with their role; an agent may be given up to that role (owner -> admin). */
  apps: { id: string; slug: string; name: string; icon_url: string | null; role: Role }[]
  expires_at: string
}

/**
 * Which workspaces an agent may use. Its role in an app is the override for that app if there is one, else
 * `all_workspaces` (when set and the account has a role there); either way capped by the account's current role
 * there (owner/admin -> admin, member -> member, viewer -> responder). A `null` override role excludes that app.
 */
export interface AgentAccess {
  /** Every workspace the account has a role in, now and later, at this role; null for only the listed apps. */
  all_workspaces: AgentRole | null
  /** Per-app roles (or exclusions with null). Only apps where the account has a role. */
  apps: { id: string; role: AgentRole | null }[]
  /** May create workspaces over MCP; the account owns them and the agent gets admin there. */
  create_workspaces: boolean
}

/** The consent page's answer. At least one app, all workspaces, or create_workspaces. */
export type OAuthApproval = AgentAccess

/** An agent on the user's account: an OAuth connection or a token agent. */
export interface ConnectedAgent {
  id: string
  kind: "oauth" | "token"
  /** The agent's name on its posts (the OAuth client name, or the token agent's name). */
  client_name: string
  /** Token agents: the first characters of the secret, e.g. "bh_7f3a…". */
  preview: string | null
  all_workspaces: AgentRole | null
  /** Every app it can use now, with its effective role; `override` is true when that app has its own entry. */
  apps: { id: string; slug: string; name: string; role: AgentRole; override: boolean }[]
  /** Apps excluded from all_workspaces. */
  excluded: { id: string; slug: string; name: string }[]
  create_workspaces: boolean
  created_at: string
  last_used_at: string | null
}
