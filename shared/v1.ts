// Bellhop public API, v1: what a custom widget, a host app's frontend or its backend builds on. Bellhop's own help
// desk pages and chat widget use the same API, so anything they do, a custom integration can do.
//
// Stable: within v1, fields and routes are only added, never renamed or removed. Unknown fields must be ignored.
// Base URL: https://api.blhp.app/v1 (also /v1 on every workspace host and, later, custom domains).
// JSON; times are ISO 8601; lists are Page<T> with cursor pagination; errors are { error: { code, message } } with
// the usual statuses (400, 401, 403, 404, 409, 410, 413, 422, 428, 429 + Retry-After). POSTs accept an
// Idempotency-Key header (replayed for 24 h). End users never see "Bellhop": team and agent participants are shown
// as the workspace presents them.
//
// Keys (created by workspace admins in Settings → API keys; shown once):
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
//          the host's server vouches for its signed-in user directly (no token signing needed)
//   POST   /v1/sessions        publishable key { identity_token }                -> Session   an IdentityToken (api.ts)
//   POST   /v1/sessions        publishable key { anonymous: true, turnstile_token } -> Session   if allowed
//   POST   /v1/sessions/email  publishable key { email, turnstile_token }        -> { ok: true }   sends a code
//   POST   /v1/sessions/email/verify publishable key { email, code }            -> Session
//          Email start returns Challenge-Token in a CORS-exposed response header. Keep it in this browser and send
//          it on verify (and repeat starts for the same challenge). A publishable key or Origin is not a browser ID.
//   DELETE /v1/session         session                                           -> { ok: true }
//
// As the end user (session):
//   GET    /v1/me                                         -> EndUser
//   PATCH  /v1/me              { name?, locale? }         -> EndUser
//   GET    /v1/conversations?status=open|closed&cursor=   -> Page<Conversation>   only their own, newest activity first
//   POST   /v1/conversations   ConversationInput          -> Conversation
//   GET    /v1/conversations/:id                          -> Conversation
//   GET    /v1/conversations/:id/items?cursor=&after=     -> Page<ConversationItem>   public messages and events, oldest
//          first; `after` (an item id) for catching up after a reconnect
//   POST   /v1/conversations/:id/messages MessageInput    -> Message
//   POST   /v1/conversations/:id/read { item_id }         -> { ok: true }
//   POST   /v1/conversations/:id/typing                   -> { ok: true }      shown to the team for 5 s
//   POST   /v1/conversations/:id/verifications/:vid/confirm { code } -> Verification (api.ts)
//   POST   /v1/uploads         multipart/form-data, one part named file -> Upload; attach once within 24 h
//   POST   /v1/realtime        -> { url, expires_at }     a single-use wss:// URL valid 60 s; the socket sends
//                                                         RealtimeEvent JSON frames for all of this user's conversations
//          Open the returned URL unchanged. Send the text ping every 25 s; pong is a heartbeat, not a JSON event.
//          On reconnect mint a fresh ticket, open the socket and buffer frames, then page items?after=<last item id>
//          per conversation and merge by item id. Refresh the conversation list for new requests or changed state.
//          If the anchor was deleted/hidden, reload that timeline. Close 4401 means the session is no longer authorized.
//
// Server API (secret key), next phase, outline only: contacts (list, get, upsert by external id), conversations
// (list and search all, get, reply as the workspace or a named team member, internal notes, status, assignee,
// labels, request a verification), and the same events as webhooks. Agents keep using MCP.

import type { CloseReason, IssueStatus, Locale, Verification } from "./api"

export interface Page<T> {
  data: T[]
  next_cursor: string | null
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

/** Who wrote a message or did something, as end users see them. */
export type Participant =
  | { type: "user"; id: string; name: string | null }
  | { type: "team"; id: string; name: string; avatar_url: string | null }
  | { type: "agent"; id: string; name: string; avatar_url: string | null }

/** A conversation is a help desk request (an issue). */
export interface Conversation {
  id: string
  /** The request number the team sees (#12). */
  number: number
  subject: string
  status: IssueStatus
  close_reason: CloseReason | null
  created_at: string
  updated_at: string
  last_item: ConversationItem | null
  /** Items from others after the user's last read mark. */
  unread: number
  assignee: Participant | null
  /** Pending and completed email verifications on this conversation. */
  verifications: Verification[]
}

export interface ConversationInput {
  /** Defaults to the start of the first message. */
  subject?: string
  message: MessageInput
  /** Report metadata to attach (see the report metadata API). */
  metadata_id?: string
}

export interface MessageInput {
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
  /** Signed for one object/contact for 1 hour; anyone holding the whole URL can read it while access remains valid. */
  url: string
}

export interface Message {
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
  | { type: "status_changed"; status: IssueStatus; close_reason: CloseReason | null }
  | { type: "assigned"; assignee: Participant | null }
  | { type: "verification_requested"; verification_id: string }
  | { type: "verified"; verification_id: string }

export type ConversationItem =
  | { kind: "message"; id: string; created_at: string; message: Message }
  | { kind: "event"; id: string; created_at: string; actor: Participant | null; event: ConversationEvent }

export type RealtimeEvent =
  | { type: "item.created"; conversation_id: string; item: ConversationItem }
  | { type: "message.updated"; conversation_id: string; message: Message }
  | { type: "conversation.updated"; conversation: Conversation }
  | { type: "typing"; conversation_id: string; participant: Participant }
  /** An agent is working on it; `text` is a short status ("Looking up your invoice…"), null when done. */
  | { type: "activity"; conversation_id: string; participant: Participant; text: string | null }

/** Settings → API keys (internal API, admin). */
export interface ApiKey {
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
