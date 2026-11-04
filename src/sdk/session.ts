import type {
  Conversation,
  ConversationInput,
  ConversationItem,
  EndUser,
  Message,
  MessageInput,
  Page,
  Session,
  Upload,
  Workspace,
} from "../../shared/v1"
import type { Locale } from "../../shared/api"
import type { Verification } from "../../shared/v1"
import { BellhopError, send, type Call, type Transport } from "./http"
import { subscribe, type Subscription, type SubscribeOptions, type RealtimeHandler } from "./realtime"

/** A pending email sign-in: keep `challenge` in this browser and pass it to verifyEmail. */
export interface EmailChallenge {
  email: string
  challenge: string
}

export interface SessionOptions {
  /** Called after the token changes (refresh): store the new session; the old token no longer works. */
  onRefresh?: (session: Session) => void
  /**
   * Called on a 401 before giving up: return a newer token (e.g. another tab refreshed it into shared storage)
   * and the call is retried once with it. Return null to let the 401 through.
   */
  onUnauthorized?: (rejected: string) => string | null | Promise<string | null>
}

/** Everything an end user can do, with their session token (bh_us_…). */
export class SessionClient {
  /** The session token. Store it (and update it in onRefresh) to resume later with `client.fromSessionToken`. */
  token: string
  /** When the session ends (24 h after it started or was refreshed); null when resumed from a bare token. */
  expiresAt: string | null
  /** The user as the session started; `me()` reads it fresh. */
  user: EndUser | null
  private refreshing: Promise<Session> | null = null
  private keepAliveTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly transport: Transport,
    session: Pick<Session, "token"> & Partial<Session>,
    readonly options: SessionOptions = {},
  ) {
    this.token = session.token
    this.expiresAt = session.expires_at ?? null
    this.user = session.user ?? null
  }

  /** A raw call with this session (for routes newer than this SDK). */
  async request<T>(call: Omit<Call, "bearer">): Promise<T> {
    if (this.refreshing) await this.refreshing.catch(() => {})
    const token = this.token
    try {
      return (await send<T>(this.transport, { ...call, bearer: token })).data
    } catch (e) {
      if (!(e instanceof BellhopError) || e.status !== 401) throw e
      // Another holder may have rotated the token (a refresh in another tab): try the newer one once.
      const next = this.token !== token ? this.token : await this.options.onUnauthorized?.(token)
      if (!next || next === token) throw e
      this.token = next
      return (await send<T>(this.transport, { ...call, bearer: next })).data
    }
  }

  /**
   * Rotates the session: a new token valid for up to 24 h more (at most 30 days from the original sign-in). The old
   * token and its sockets stop working at once. Concurrent calls share one rotation. Verified sessions only
   * (anonymous ones get 403 verification_required).
   */
  refresh(): Promise<Session> {
    this.refreshing ??= send<Session>(this.transport, { method: "POST", path: "/session/refresh", bearer: this.token })
      .then(({ data }) => {
        this.token = data.token
        this.expiresAt = data.expires_at
        this.user = data.user
        this.options.onRefresh?.(data)
        return data
      })
      .finally(() => (this.refreshing = null))
    return this.refreshing
  }

  /**
   * Keeps a long-lived page signed in: refreshes `margin` ms before `expiresAt` (default 10 minutes), again after
   * each rotation, until the 30-day cap. Returns a function that stops it. Needs `expiresAt` (it's set for sessions
   * this SDK started or refreshed; pass it to fromSessionToken when resuming).
   */
  keepAlive(margin = 10 * 60_000): () => void {
    const stop = () => {
      if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
    const schedule = () => {
      stop()
      if (!this.expiresAt || this.user?.anonymous) return
      const wait = Math.max(5_000, Date.parse(this.expiresAt) - Date.now() - margin)
      this.keepAliveTimer = setTimeout(async () => {
        const before = this.expiresAt
        try {
          await this.refresh()
          // At the 30-day cap the expiry stops moving: stop instead of refreshing in a loop.
          if (this.expiresAt !== before) schedule()
        } catch (e) {
          if (!(e instanceof BellhopError) || e.status === 0 || e.status === 429) {
            this.keepAliveTimer = setTimeout(schedule, 60_000)
          }
        }
      }, Math.min(wait, 2 ** 31 - 1))
    }
    schedule()
    return stop
  }

  /** The workspace as end users see it: white-label name and icon, sign-in options. */
  workspace(): Promise<Workspace> {
    return this.request({ method: "GET", path: "/workspace" })
  }

  /**
   * Anonymous sessions: start an email sign-in with this session, so its conversations move to the verified contact.
   * (On a fresh visit, use client.startEmail instead.)
   */
  async startEmail(email: string, options: { turnstileToken: string; challenge?: string }): Promise<EmailChallenge> {
    const { headers } = await send(this.transport, {
      method: "POST",
      path: "/sessions/email",
      bearer: this.token,
      body: { email, turnstile_token: options.turnstileToken },
      headers: options.challenge ? { "Challenge-Token": options.challenge } : undefined,
    })
    const challenge = headers.get("Challenge-Token") ?? options.challenge
    if (!challenge) throw new BellhopError(0, "missing_challenge", "The API didn't return a Challenge-Token")
    return { email, challenge }
  }

  /** Anonymous sessions: finish the email sign-in. Returns the verified session; this one ends. */
  async verifyEmail(c: EmailChallenge, code: string): Promise<SessionClient> {
    const { data } = await send<Session>(this.transport, {
      method: "POST",
      path: "/sessions/email/verify",
      bearer: this.token,
      body: { email: c.email, code },
      headers: { "Challenge-Token": c.challenge },
    })
    this.stop()
    return new SessionClient(this.transport, data, this.options)
  }

  /** Stops keepAlive timers (call when you drop this session). */
  stop() {
    if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  /** The current user. */
  async me(): Promise<EndUser> {
    return (this.user = await this.request<EndUser>({ method: "GET", path: "/me" }))
  }

  /** Sets the user's display name or language. */
  async updateMe(input: { name?: string; locale?: Locale }): Promise<EndUser> {
    return (this.user = await this.request<EndUser>({ method: "PATCH", path: "/me", body: input }))
  }

  /** Ends the session on the server. The token stops working at once. */
  async logout(): Promise<void> {
    this.stop()
    await this.request({ method: "DELETE", path: "/session" })
  }

  /** One page of the user's conversations, newest activity first. */
  listConversations(options: { status?: "open" | "closed"; cursor?: string } = {}): Promise<Page<Conversation>> {
    return this.request({ method: "GET", path: "/conversations", query: options })
  }

  /** Every conversation, page by page: `for await (const c of session.conversations()) …` */
  async *conversations(options: { status?: "open" | "closed" } = {}): AsyncGenerator<Conversation> {
    let cursor: string | undefined
    do {
      const page = await this.listConversations({ ...options, cursor })
      yield* page.data
      cursor = page.next_cursor ?? undefined
    } while (cursor)
  }

  getConversation(id: string): Promise<Conversation> {
    return this.request({ method: "GET", path: `/conversations/${encodeURIComponent(id)}` })
  }

  /** Starts a conversation with its first message. */
  createConversation(input: ConversationInput, options: { idempotencyKey?: string } = {}): Promise<Conversation> {
    return this.request({ method: "POST", path: "/conversations", body: input, ...options })
  }

  /**
   * One page of a conversation's items (messages and events). Forward (default): oldest first; `after` (an item id)
   * catches up. Backward: `last` (1–100) opens at the newest N and `before` (an item id) gets older ones; backward
   * pages are in display order and their next_cursor continues toward older items. Don't mix after with last/before.
   */
  listItems(
    conversationId: string,
    options: { cursor?: string; after?: string; before?: string; last?: number } = {},
  ): Promise<Page<ConversationItem>> {
    const { last, ...rest } = options
    return this.request({
      method: "GET",
      path: `/conversations/${encodeURIComponent(conversationId)}/items`,
      query: { ...rest, last: last === undefined ? undefined : String(last) },
    })
  }

  /** The newest `n` items in display order; pass `next_cursor` to `older()` for the ones before them. */
  latest(conversationId: string, n = 30): Promise<Page<ConversationItem>> {
    return this.listItems(conversationId, { last: n })
  }

  /** The page before a backward page's cursor (or before an item id), in display order. */
  older(conversationId: string, from: { cursor: string } | { before: string; last?: number }): Promise<Page<ConversationItem>> {
    return this.listItems(conversationId, from)
  }

  /** Every item, oldest first, optionally only those after an item id. */
  async *items(conversationId: string, options: { after?: string } = {}): AsyncGenerator<ConversationItem> {
    let page = await this.listItems(conversationId, options)
    yield* page.data
    while (page.next_cursor) {
      page = await this.listItems(conversationId, { cursor: page.next_cursor })
      yield* page.data
    }
  }

  /** Pages backward from the newest items: `for await (const page of session.history(id)) prepend(page.data)` */
  async *history(conversationId: string, pageSize = 30): AsyncGenerator<ConversationItem[]> {
    let page = await this.latest(conversationId, pageSize)
    yield page.data
    while (page.next_cursor) {
      page = await this.older(conversationId, { cursor: page.next_cursor })
      yield page.data
    }
  }

  /** Posts a message (Markdown). Pass an idempotencyKey to make a retried send safe across reloads. */
  sendMessage(conversationId: string, input: MessageInput, options: { idempotencyKey?: string } = {}): Promise<Message> {
    return this.request({ method: "POST", path: `/conversations/${encodeURIComponent(conversationId)}/messages`, body: input, ...options })
  }

  /** Marks everything up to and including an item as read. */
  async markRead(conversationId: string, itemId: string): Promise<void> {
    await this.request({ method: "POST", path: `/conversations/${encodeURIComponent(conversationId)}/read`, body: { item_id: itemId } })
  }

  /** Shows the team the user is typing (for 5 s). Call it at most every few seconds while they type. */
  async typing(conversationId: string): Promise<void> {
    await this.request({ method: "POST", path: `/conversations/${encodeURIComponent(conversationId)}/typing` })
  }

  /**
   * Uploads a file to attach to a message (pass the returned id in MessageInput.attachments within 24 h). Limits:
   * images 10 MiB, videos 100 MiB, other files 25 MiB, plus a daily byte budget. Errors: 413 too_large or
   * upload_byte_quota, 415 unsupported_video (the content isn't a known video container) or expected_multipart,
   * 429 rate_limited (hourly count). See `uploadErrorKind`.
   */
  upload(file: Blob, name?: string): Promise<Upload> {
    const form = new FormData()
    form.append("file", file, name ?? (file as File).name ?? "file")
    return this.request({ method: "POST", path: "/uploads", body: form })
  }

  /** Enters the code from an email verification the team asked for. */
  confirmVerification(conversationId: string, verificationId: string, code: string): Promise<Verification> {
    return this.request({
      method: "POST",
      path: `/conversations/${encodeURIComponent(conversationId)}/verifications/${encodeURIComponent(verificationId)}/confirm`,
      body: { code },
    })
  }

  /**
   * Live events for all of this user's conversations: a realtime socket when the API offers one, polling otherwise,
   * with reconnects and catch-up (items after the last one seen) either way. `watch(id)` the conversation on screen
   * so it's caught up promptly.
   */
  subscribe(handler: RealtimeHandler, options: SubscribeOptions = {}): Subscription {
    return subscribe(this, handler, options)
  }
}
