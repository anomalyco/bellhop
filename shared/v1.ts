// Bellhop public API, v1: what a custom widget, a host app's frontend or its backend builds on. Bellhop's own help
// desk pages and chat widget use the same API, so anything they do, a custom integration can do.
//
// Stable: within v1, fields and routes are only added, never renamed or removed. Unknown fields must be ignored.
// Base URL: https://api.blhp.app/v1 (also /v1 on every workspace host and, later, custom domains).
// JSON; times are ISO 8601; lists are Page<T> with cursor pagination; errors are { error: { code, message } } with
// the usual statuses (400, 401, 403, 404, 409, 410, 413, 422, 428, 429 + Retry-After). POSTs accept an
// Idempotency-Key header (except fresh realtime tickets and session rotation): successes replay for 24 h, client errors for 5 minutes;
// 1000 active nonces per scope (publishable credentials budgeted per key/IP). Replayed uploads get fresh signed URLs.
// End users never see "Bellhop": team and agent participants are shown
// as the workspace presents them.
//
// Keys (created by workspace admins in Settings → API keys; secret keys shown only once):
//   publishable  bh_pk_…  safe to ship in browsers. Names the workspace. Only accepted from the key's allowed origins
//                         (exact origins; requests without a matching Origin are refused). Starts end-user sessions:
//                         https://<slug>.blhp.app (the dev path-mode origin locally) is implicitly allowed for its workspace.
//                         from a host identity token, by email code, or anonymously when the workspace allows it.
//   secret       bh_sk_…  server only: a request carrying an Origin header is refused (so a leaked key in a page
//                         doesn't work from browsers). Mints sessions for the host's own users and uses the server API.
//
// End-user sessions: `Authorization: Bearer bh_us_…`, one contact in one workspace, 24 h, no cookies (works in
// iframes and third-party embeds). CORS is open to the publishable key's allowed origins for these routes.
//   POST   /v1/sessions        secret key      { user: { id, email?, email_verified?, name?, locale? } } -> Session
//          The host vouches for its signed-in user directly. A verified mailbox does NOT link an existing contact
//          by default. user.link_existing:true explicitly grants access to the matching email-only contact's private
//          history; signed identity tokens use the same claim.
//   POST   /v1/sessions        publishable key { identity_token }                -> Session   an IdentityToken (api.ts)
//   POST   /v1/sessions        publishable key { anonymous: true, turnstile_token } -> Session   if allowed;
//          anonymous conversations are reachable for the 24-hour session unless the visitor verifies.
//   POST   /v1/sessions/email  publishable key { email, turnstile_token }        -> { ok: true }   sends a code
//   POST   /v1/sessions/email/verify publishable key { email, code }            -> Session
//          Email start returns Challenge-Token in a CORS-exposed response header. Keep it in this browser and send
//          it on verify (and repeat starts for the same challenge). A publishable key or Origin is not a browser ID.
//   DELETE /v1/session         session                                           -> { ok: true }
//   POST   /v1/session/refresh verified session -> Session; rotate before expiry, up to 24 h more, at most 30 days
//          from original mint. Old bearer and sockets stop working. Serialize refreshes; do not retry the old token.
//   GET    /v1/workspace       publishable key or user session -> Workspace. A null Turnstile site key means email
//          and anonymous sign-in are unavailable on that origin; use host identity or a hosted workspace frame.
//          An anonymous session may also call sessions/email and sessions/email/verify. On verify, pass the same
//          anonymous session bearer and Challenge-Token that started the challenge: its workspace history moves to the proved contact, and the old session ends.
// Limits per minute: session reads 300, writes 60, typing 300 separately (all follow the family on refresh);
// credential mints and code entries 60/key/IP, secret-key backstop 6000/key. Ingress 600/IP, entry routes 120/IP.
// Preflights are uncharged and cacheable for 86400 s; signed media has a separate 600/IP budget.
//
// As the end user (session):
//   GET    /v1/me                                         -> EndUser
//   PATCH  /v1/me              { name?, locale? }         -> EndUser
//   GET    /v1/conversations?status=open|closed&cursor=   -> Page<Conversation>   only their own, newest activity first
//   POST   /v1/conversations   ConversationInput          -> Conversation
//   GET    /v1/conversations/:id                          -> Conversation
//   GET    /v1/conversations/:id/items?cursor=&after=     -> Page<ConversationItem>   public messages and events, oldest
//          first; `after` (an item id) for catching up after a reconnect
//          `last=N` (1–100) opens at the newest N; `before=<id>` gets older items, optionally with last=N.
//          Backward pages are returned in display order; next_cursor continues toward older items. Do not mix with after.
//   POST   /v1/conversations/:id/messages MessageInput    -> Message
//   POST   /v1/conversations/:id/read { item_id }         -> { ok: true }
//   POST   /v1/conversations/:id/typing                   -> { ok: true }      shown to the team for 5 s
//   POST   /v1/conversations/:id/verifications/:vid/confirm { code } -> Verification (api.ts)
//   POST   /v1/uploads         multipart/form-data, one part named file -> Upload; attach once within 24 h
//   POST   /v1/realtime        -> { url, expires_at }     a single-use wss:// URL valid 60 s; the socket sends
//                                                         RealtimeEvent JSON frames for all of this user's conversations
//          Open the returned URL unchanged. Send the text ping every 25 s; pong is a heartbeat, not a JSON event.
//          In dev path mode the URL uses the origin called by the client (ws for http, wss for https).
//          On reconnect mint a fresh ticket, open the socket and buffer frames, then page items?after=<last item id>
//          per conversation and merge by item id. Refresh the conversation list for new requests or changed state.
//          If the anchor was deleted/hidden, reload that timeline. Close 4401 means the session is no longer authorized.
//          Typing a public team reply emits typing; editing an internal note does not. Status changes emit conversation.updated.
//
// As a workspace (secret bearer, Origin MUST be absent; help desks only). Agents keep using MCP.
// All server writes accept Idempotency-Key (24 h) and record the key name and preview in the workspace audit log.
//   GET    /v1/contacts?q=&cursor=                         -> Page<Contact> (persistent contacts, not anonymous sessions)
//   GET    /v1/contacts/:id                                -> Contact
//   GET    /v1/contacts/by-external-id/:external_id         -> Contact
//   PUT    /v1/contacts/by-external-id/:external_id  ContactInput -> Contact; same verified-email linking rules as mint
//   DELETE /v1/contacts/:id                                -> { ok: true }; removes the identity, proof records on their
//          requests, subscriptions and sessions. Request content/files remain; author snapshots say Deleted user.
//   GET    /v1/conversations?status=&contact_id=&q=&cursor= -> Page<Conversation>; shared list-search qualifiers
//   GET    /v1/conversations/:id                           -> Conversation
//   GET    /v1/conversations/:id/items?cursor=&after=       -> Page<ConversationItem>; includes notes and staff events
//   POST   /v1/conversations                               ConversationInput (contact required) -> Conversation
//   POST   /v1/conversations/:id/messages                  MessageInput (as.member required) -> Message
//   PATCH  /v1/conversations/:id                           ConversationPatch -> Conversation
//   POST   /v1/conversations/:id/verifications             { email } -> Verification; subject to workspace mail caps

import type { CloseReason, IssueStatus, Locale, RequestField, Verification as StoredVerification } from "./api"
export type Verification = Omit<StoredVerification, "requested_by"> & {
  requested_by: StoredVerification["requested_by"] | Extract<Participant, { type: "team" }>
}

export interface Page<T> {
  data: T[]
  next_cursor: string | null
}
export interface Workspace {
  name: string
  icon_url: string | null
  allow_anonymous: boolean
  require_verified_email: boolean
  turnstile_site_key: string | null
  brand: { accent: null }
  /** Active request types for the new-conversation form, in order (no routing or autonomy). */
  request_types: {
    id: string
    name: string
    description: string
    fields: RequestField[]
    require_verification: boolean
  }[]
}

export interface Session {
  token: string
  expires_at: string
  user: EndUser
}

/** The person using the widget: a help desk contact (or an anonymous one). */
export interface EndUser {
  id: string
  name: string | null
  /** Verified email only. */
  email: string | null
  /** The host app's user id, when the host vouched for them. */
  external_id: string | null
  verified_via: "email" | "host" | null
  anonymous: boolean
  locale: Locale
}

/** Workspace directory view. Unverified email is display-only, never a matching or delivery address. */
export interface Contact extends EndUser {
  unverified_email: string | null
  created_at: string
  last_seen_at: string | null
}
export interface ContactInput { email?: string; email_verified?: boolean; link_existing?:boolean; name?: string; locale?: Locale }
export type ContactSelector = { id: string } | { external_id: string }
export interface ConversationPatch {
  status?: IssueStatus
  close_reason?: CloseReason
  assignee?: { member: string } | { agent: string } | null
  labels?: string[]
}

/** Who wrote a message or did something, as end users see them. */
export type Participant =
  | { type: "user"; id: string; name: string | null }
  | { type: "team"; id: string; name: string; avatar_url: string | null }
  | { type: "agent"; id: string; name: string; avatar_url: string | null }

/** A conversation is a help desk request (an issue). */
export interface Conversation {
  request_type: { id: string; name: string } | null
  /** Request form answers. Internal answers are included only in the workspace view. */
  fields: Record<string, string>
  /** Workspace only. Suggest holds agent replies; action services enforce signed approvals. */
  effective_autonomy?: import("./api").Autonomy
  /** Workspace-only fields. created_via is set on requests opened on behalf of a contact by a server key. */
  contact_id?: string | null
  labels?: string[]
  hidden?: boolean
  created_via?: "api"
  id: string
  /** The request number the team sees (#12). */
  number: number
  subject: string
  status: IssueStatus
  close_reason: CloseReason | null
  created_at: string
  updated_at: string
  last_item: ConversationItem | null
  /** Messages from others plus verification requests after the user's read mark; not status or assignment events. */
  unread: number
  assignee: Participant | null
  /** Pending and completed email verifications on this conversation. */
  verifications: Verification[]
}

export interface ConversationInput {
  contact?: ContactSelector
  /** Defaults to the start of the first message. */
  subject?: string
  message: MessageInput
  /** Report metadata to attach (see the report metadata API). */
  metadata_id?: string
  /** A request type id from GET /v1/workspace, and answers to its fields. */
  request_type?: string
  fields?: Record<string, string>
}

export interface MessageInput {
  /** Workspace credential only. member is a currently joined team member's email. */
  as?: { member: string }
  internal?: boolean
  /** Markdown. */
  body: string
  /** Upload ids. */
  attachments?: string[]
}

export interface Upload {
  id: string
  name: string
  type: string
  size: number
  /** User view: signed for one object/contact for 1 h and transferable while access remains valid. Workspace view:
   * fetch with the server's secret bearer; no shareable URL is issued for internal or hidden content. */
  url: string
}

export interface Message {
  held?: boolean // Workspace only, awaiting review.
  internal?: boolean
  id: string
  conversation_id: string
  author: Participant
  /** Markdown as written. */
  body: string
  attachments: Upload[]
  created_at: string
  edited_at: string | null
}

export type ConversationEvent =
  | { type: "workspace_event"; action: string; data: Record<string, unknown> }
  | { type: "status_changed"; status: IssueStatus; close_reason: CloseReason | null }
  | { type: "assigned"; assignee: Participant | null }
  | { type: "verification_requested"; verification_id: string }
  | { type: "verified"; verification_id: string }

export type ConversationItem = { internal?: boolean; hidden?: boolean; held?: boolean } & (
  | { kind: "message"; id: string; created_at: string; message: Message }
  | { kind: "event"; id: string; created_at: string; actor: Participant | null; event: ConversationEvent }
)

export type RealtimeEvent =
  | { type: "item.created"; conversation_id: string; item: ConversationItem }
  | { type: "message.updated"; conversation_id: string; message: Message }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "typing"; conversation_id: string; participant: Participant }
  /** An agent is working on it; `text` is a short status ("Looking up your invoice…"), null when done. */
  | { type: "activity"; conversation_id: string; participant: Participant; text: string | null }

/** Settings → API keys (internal API, admin). */
export interface ApiKey {
  /** Publishable keys only, admins only. Absent for older hash-only publishable keys. */
  key?: string
  id: string
  name: string
  kind: "publishable" | "secret"
  /** e.g. "bh_pk_…3f9a". */
  preview: string
  /** Publishable keys: exact origins allowed to use it, e.g. "https://opencode.ai". Empty for secret keys. */
  allowed_origins: string[]
  created_at: string
  last_used_at: string | null
}

export interface NewApiKey extends ApiKey {
  key: string
}
