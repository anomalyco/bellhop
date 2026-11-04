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
} from "../../shared/v1"
import type { Locale } from "../../shared/api"
import type { Verification } from "../../shared/v1"
import { send, type Call, type Transport } from "./http"
import { subscribe, type Subscription, type SubscribeOptions, type RealtimeHandler } from "./realtime"

/** Everything an end user can do, with their session token (bh_us_…). */
export class SessionClient {
  /** The session token. Store it to resume later with `client.fromSessionToken(token)`. */
  readonly token: string
  /** When the session ends (24 h after it started); null when resumed from a bare token. */
  readonly expiresAt: string | null
  /** The user as the session started; `me()` reads it fresh. */
  user: EndUser | null

  constructor(
    private readonly transport: Transport,
    session: Pick<Session, "token"> & Partial<Session>,
  ) {
    this.token = session.token
    this.expiresAt = session.expires_at ?? null
    this.user = session.user ?? null
  }

  /** A raw call with this session (for routes newer than this SDK). */
  async request<T>(call: Omit<Call, "bearer">): Promise<T> {
    return (await send<T>(this.transport, { ...call, bearer: this.token })).data
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

  /** One page of a conversation's items (messages and events), oldest first. `after` (an item id) catches up. */
  listItems(conversationId: string, options: { cursor?: string; after?: string } = {}): Promise<Page<ConversationItem>> {
    return this.request({ method: "GET", path: `/conversations/${encodeURIComponent(conversationId)}/items`, query: options })
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

  /** Uploads a file to attach to a message (pass the returned id in MessageInput.attachments within 24 h). */
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
