// The Bellhop SDK: a typed, dependency-free client for the public v1 API (shared/v1.ts). It runs in browsers and in
// Node 18+ (anything with fetch). Bellhop's own chat widget is built only on this, so a custom widget can do
// everything ours does.
//
//   import { createClient } from "https://blhp.app/sdk/v1.js"
//   const client = createClient({ key: "bh_pk_…" })
//   const session = await client.signInWithIdentityToken(token)
//   const conversation = await session.createConversation({ message: { body: "Hi!" } })
//   session.subscribe((event) => console.log(event)).watch(conversation.id, conversation.last_item?.id)

import type { EndUser, Session } from "../../shared/v1"
import type { Locale } from "../../shared/api"
import { BellhopError, send, type Call, type Transport } from "./http"
import { SessionClient } from "./session"

export { BellhopError } from "./http"
export type { Call } from "./http"
export { SessionClient } from "./session"
export type { ConnectionState, RealtimeHandler, SubscribeOptions, Subscription } from "./realtime"
export type {
  Conversation,
  ConversationEvent,
  ConversationInput,
  ConversationItem,
  EndUser,
  Message,
  MessageInput,
  Page,
  Participant,
  RealtimeEvent,
  Session,
  Upload,
} from "../../shared/v1"
export type { Verification, Locale } from "../../shared/api"

export const VERSION = "1.0.0"

export interface ClientOptions {
  /** A publishable key (bh_pk_…) in browsers, or a secret key (bh_sk_…) on your server. */
  key: string
  /** Defaults to https://api.blhp.app/v1. */
  baseUrl?: string
  /** Your fetch (defaults to the global one). */
  fetch?: typeof fetch
  /** Retries per call on 429 and network errors (default 2). */
  retries?: number
}

/** A pending email sign-in: keep `challenge` in this browser and pass it to verifyEmail. */
export interface EmailChallenge {
  email: string
  challenge: string
}

/** What your server vouches for when it starts a session with a secret key. */
export interface HostUser {
  /** Your user id (becomes the contact's external_id). */
  id: string
  email?: string
  email_verified?: boolean
  name?: string
  locale?: Locale
}

export interface Client {
  readonly key: string
  readonly baseUrl: string
  /** Resumes a session from its token (bh_us_…), e.g. one your server minted or one stored in this browser. */
  fromSessionToken(token: string, user?: EndUser): SessionClient
  /** Publishable key: starts a session for a user your server signed (an identity token). */
  signInWithIdentityToken(identityToken: string): Promise<SessionClient>
  /** Publishable key: emails a sign-in code. Repeat with the same challenge to resend. */
  startEmail(email: string, options: { turnstileToken: string; challenge?: string }): Promise<EmailChallenge>
  /** Publishable key: finishes an email sign-in with the code from the email. */
  verifyEmail(challenge: EmailChallenge, code: string): Promise<SessionClient>
  /** Publishable key: an anonymous session, when the workspace allows them (Turnstile-checked). */
  anonymous(options: { turnstileToken: string }): Promise<SessionClient>
  /** Secret key, server only: starts a session for your signed-in user and returns it (send `token` to the browser). */
  createSession(user: HostUser): Promise<Session>
  /** A raw call with this key (for routes newer than this SDK). */
  request<T>(call: Omit<Call, "bearer">): Promise<T>
}

export function createClient(options: ClientOptions): Client {
  if (!/^bh_(pk|sk)_[0-9a-f]{64}$/i.test(options.key)) throw new BellhopError(0, "invalid_key", "Expected a bh_pk_ or bh_sk_ key")
  const transport: Transport = {
    baseUrl: options.baseUrl ?? "https://api.blhp.app/v1",
    fetch: options.fetch ?? ((...args) => globalThis.fetch(...args)),
    retries: options.retries ?? 2,
    maxRetryWait: 30,
  }
  const key = options.key
  const start = async (path: string, body: unknown, headers?: Record<string, string>) =>
    new SessionClient(transport, (await send<Session>(transport, { method: "POST", path, bearer: key, body, headers })).data)

  return {
    key,
    baseUrl: transport.baseUrl,
    fromSessionToken: (token, user) => new SessionClient(transport, { token, user }),
    signInWithIdentityToken: (identity_token) => start("/sessions", { identity_token }),
    async startEmail(email, { turnstileToken, challenge }) {
      const { headers } = await send(transport, {
        method: "POST",
        path: "/sessions/email",
        bearer: key,
        body: { email, turnstile_token: turnstileToken },
        headers: challenge ? { "Challenge-Token": challenge } : undefined,
      })
      const token = headers.get("Challenge-Token") ?? challenge
      if (!token) throw new BellhopError(0, "missing_challenge", "The API didn't return a Challenge-Token (is it exposed to this origin?)")
      return { email, challenge: token }
    },
    verifyEmail: (c, code) => start("/sessions/email/verify", { email: c.email, code }, { "Challenge-Token": c.challenge }),
    anonymous: ({ turnstileToken }) => start("/sessions", { anonymous: true, turnstile_token: turnstileToken }),
    async createSession(user) {
      return (await send<Session>(transport, { method: "POST", path: "/sessions", bearer: key, body: { user } })).data
    },
    async request<T>(call: Omit<Call, "bearer">) {
      return (await send<T>(transport, { ...call, bearer: key })).data
    },
  }
}
