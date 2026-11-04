import type { Conversation, ConversationItem, Participant, RealtimeEvent, Upload, Workspace as ApiWorkspace } from "../../shared/v1"
import type { Locale } from "../../shared/api"
import { BellhopError, createClient, uploadErrorKind, type Client, type ConnectionState, type EmailChallenge, type SessionClient, type Subscription } from "../sdk"
import { h, icons } from "./dom"
import { markdown } from "./markdown"
import { css } from "./styles"
import { pickLocale, translator, type T } from "./i18n"
import { turnstileToken } from "./turnstile"

// The chat widget, built only on the public SDK: whatever it does, a custom widget can do too.

export interface WidgetOptions {
  /** The workspace's publishable key (bh_pk_…). */
  key: string
  /** A host-signed identity token for the signed-in user. */
  identityToken?: string
  /** A session token (bh_us_…) your server minted with a secret key. */
  sessionToken?: string
  locale?: string
  theme?: "light" | "dark" | "auto"
  position?: "right" | "left" | "bottom-right" | "bottom-left"
  baseUrl?: string
  turnstileSiteKey?: string
}
export type WidgetEvent = "unread" | "open" | "close"
type View = { name: "home" } | { name: "conversation"; id: string | null } | { name: "email"; step: "email" | "code"; then: () => Promise<void> }
type Pending = { local: string; conversationId: string | null; body: string; files: Upload[]; state: "sending" | "failed"; key: string; retry?: () => Promise<void> }
type Attachment = { local: string; name: string; state: "uploading" | "done"; upload?: Upload }
type Workspace = Partial<ApiWorkspace>

const storageKey = (key: string) => `bellhop.session.${key.slice(6, 22)}`
const jwtSub = (token: string) => {
  try {
    return (JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))) as { sub?: string }).sub ?? null
  } catch {
    return null
  }
}
const snippet = (body: string) => body.replace(/[*_`#>[\]()]/g, "").replace(/\s+/g, " ").trim()
const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2))

export class Widget {
  private client: Client
  private session: SessionClient | null = null
  private sub: Subscription | null = null
  private t: T
  private locale: Locale
  private conversations = new Map<string, Conversation>()
  private items = new Map<string, ConversationItem[]>()
  private pending: Pending[] = []
  private typing = new Map<string, { name: string; until: number }>()
  private activity = new Map<string, { name: string; text: string }>()
  private listeners = new Map<WidgetEvent, Set<(data?: unknown) => void>>()
  private view: View = { name: "home" }
  private draft: { subject?: string; body: string; metadataId?: string } = { body: "" }
  private workspace: Workspace = {}
  private connection: ConnectionState = "polling"
  private wasLive = false
  private isOpen = false
  private loadingList = false
  private listError = false
  private unreadTotal = 0
  private lastTyping = 0
  private host: HTMLElement
  private shadow: ShadowRoot
  private root: HTMLElement
  private launcher: HTMLButtonElement
  private badge: HTMLElement
  private announcer: HTMLElement
  private panel: HTMLElement | null = null
  private body: HTMLElement | null = null
  private notice: HTMLElement | null = null
  private thread: HTMLElement | null = null
  private live: HTMLElement | null = null
  private card: HTMLElement | null = null
  private textarea: HTMLTextAreaElement | null = null
  private typingTimer: ReturnType<typeof setInterval> | null = null

  constructor(private options: WidgetOptions) {
    this.locale = pickLocale(options.locale)
    this.t = translator(this.locale)
    this.client = createClient({ key: options.key, baseUrl: options.baseUrl })
    this.host = document.createElement("div")
    this.host.setAttribute("data-chat-widget", "")
    this.shadow = this.host.attachShadow({ mode: "open" })
    const sheet = typeof CSSStyleSheet !== "undefined" && "replaceSync" in CSSStyleSheet.prototype ? new CSSStyleSheet() : null
    if (sheet) {
      sheet.replaceSync(css)
      this.shadow.adoptedStyleSheets = [sheet]
    } else this.shadow.append(h("style", {}, css))
    this.badge = h("span", { class: "badge", hidden: true, "aria-hidden": "true" })
    this.launcher = h("button", { class: "launcher", type: "button", "aria-label": this.t("launcher.open"), "aria-expanded": "false", onclick: () => this.toggle() }, icons.chat(), this.badge)
    this.announcer = h("div", { class: "sr", "aria-live": "polite", "aria-atomic": "true" })
    this.root = h("div", { class: "root", lang: this.locale, "data-theme": options.theme ?? "light", "data-position": /left/.test(options.position ?? "") ? "left" : "right" }, this.launcher, this.announcer)
    this.shadow.append(this.root)
    ;(document.body ?? document.documentElement).append(this.host)
    document.addEventListener("visibilitychange", () => this.isOpen && !document.hidden && this.markRead())
    void this.start()
  }

  // Public API

  on(event: WidgetEvent, fn: (data?: unknown) => void) {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn)
    if (event === "unread") fn(this.unreadTotal)
    return () => set.delete(fn)
  }
  open() {
    if (this.isOpen) return
    this.isOpen = true
    this.root.toggleAttribute("data-open", true)
    this.launcher.setAttribute("aria-expanded", "true")
    this.launcher.setAttribute("aria-label", this.t("launcher.close"))
    this.launcher.replaceChildren(icons.down(), this.badge)
    this.buildPanel()
    this.emit("open")
    if (this.session) void this.refreshList()
    if (this.view.name === "conversation" && this.view.id) {
      this.sub?.watch(this.view.id, this.items.get(this.view.id)?.at(-1)?.id)
      this.markRead()
    }
  }
  close() {
    if (!this.isOpen) return
    this.isOpen = false
    this.root.toggleAttribute("data-open", false)
    this.panel?.remove()
    this.panel = this.body = this.thread = this.live = this.card = this.textarea = this.notice = null
    this.launcher.setAttribute("aria-expanded", "false")
    this.launcher.setAttribute("aria-label", this.t("launcher.open"))
    this.launcher.replaceChildren(icons.chat(), this.badge)
    if (this.view.name === "conversation" && this.view.id) this.sub?.unwatch(this.view.id)
    this.launcher.focus()
    this.emit("close")
  }
  toggle() {
    if (this.isOpen) this.close()
    else this.open()
  }
  async identify(token: string) {
    this.options = { ...this.options, identityToken: token.startsWith("bh_us_") ? undefined : token, sessionToken: token.startsWith("bh_us_") ? token : undefined }
    this.clearSession()
    await this.start()
  }
  newConversation(input: { subject?: string; message?: string; metadataId?: string } = {}) {
    this.draft = { subject: input.subject, body: input.message ?? "", metadataId: input.metadataId }
    this.open()
    // Where visitors can't sign in, home explains how to reach support instead.
    this.go(this.canSignIn() ? { name: "conversation", id: null } : { name: "home" })
  }
  async logout() {
    const s = this.session
    this.clearSession()
    this.options = { ...this.options, identityToken: undefined, sessionToken: undefined }
    this.go({ name: "home" })
    await s?.logout().catch(() => {})
  }
  destroy() {
    this.sub?.close()
    this.host.remove()
  }

  // Sessions

  private async start() {
    void this.loadWorkspace()
    const o = this.options
    try {
      if (o.sessionToken) {
        // A token the host's server minted: resume a stored rotation of it if this page already refreshed it.
        const stored = this.stored() as (SessionClient & { origin?: string }) | null
        const resumed = stored && stored.user && stored.origin === o.sessionToken ? stored : this.client.fromSessionToken(o.sessionToken, undefined, this.sessionOptions())
        ;(resumed as SessionClient & { origin?: string }).origin = o.sessionToken
        return await this.useSession(resumed, true)
      }
      const stored = this.stored()
      if (o.identityToken) {
        const sub = jwtSub(o.identityToken)
        if (stored && sub && stored.user?.external_id === sub && (await this.useSession(stored, true).then(() => true, () => false))) return
        return await this.useSession(await this.client.signInWithIdentityToken(o.identityToken), false)
      }
      if (stored) await this.useSession(stored, true)
    } catch (e) {
      if (e instanceof BellhopError && e.status === 401) this.forget()
      else console.warn("[chat]", e)
      this.render()
    }
  }
  private stored(): SessionClient | null {
    try {
      const raw = localStorage.getItem(storageKey(this.options.key))
      if (!raw) return null
      const v = JSON.parse(raw) as { token: string; user?: SessionClient["user"]; expires_at?: string | null; origin?: string }
      if (v.expires_at && Date.parse(v.expires_at) < Date.now()) return this.forget(), null
      const s = this.client.fromSessionToken(v.token, v.user ?? undefined, { ...this.sessionOptions(), expiresAt: v.expires_at ?? undefined })
      return Object.assign(s, { origin: v.origin })
    } catch {
      return null
    }
  }
  private forget() {
    try {
      localStorage.removeItem(storageKey(this.options.key))
    } catch {
      /* storage blocked */
    }
  }
  /** Session hooks: store rotated tokens; on a 401, pick up a token another tab rotated into storage. */
  private sessionOptions() {
    return {
      onRefresh: () => this.persist(),
      onUnauthorized: (rejected: string) => {
        try {
          const v = JSON.parse(localStorage.getItem(storageKey(this.options.key)) ?? "null") as { token?: string } | null
          return v?.token && v.token !== rejected ? v.token : null
        } catch {
          return null
        }
      },
    }
  }
  private persist() {
    const s = this.session as (SessionClient & { origin?: string }) | null
    if (!s) return
    try {
      localStorage.setItem(storageKey(this.options.key), JSON.stringify({ token: s.token, user: s.user, expires_at: s.expiresAt, origin: s.origin }))
    } catch {
      /* storage blocked: the session lasts as long as the page */
    }
  }
  /** Adopts a session: validates resumed ones, stores it, keeps it alive, subscribes and loads conversations. */
  private async useSession(s: SessionClient, validate: boolean) {
    if (validate) await s.me()
    this.sub?.close()
    this.session?.stop()
    this.session = s
    this.persist()
    // Long-lived pages: rotate the session before it expires (verified sessions only; up to 30 days).
    if (!s.expiresAt && !s.user?.anonymous) await s.refresh().catch(() => {})
    s.keepAlive()
    if (s.user?.locale && !this.options.locale && s.user.locale !== this.locale) this.setLocale(s.user.locale)
    this.conversations.clear()
    this.items.clear()
    this.sub = s.subscribe((e) => this.onEvent(e), {
      onState: (state) => this.onConnection(state),
      onReset: (id) => void this.loadItems(id),
    })
    if (this.view.name === "conversation" && this.view.id) this.sub.watch(this.view.id, this.items.get(this.view.id)?.at(-1)?.id)
    await this.refreshList()
  }
  private clearSession() {
    this.session?.stop()
    this.sub?.close()
    this.sub = null
    this.session = null
    this.forget()
    this.conversations.clear()
    this.items.clear()
    this.pending = []
    this.updateUnread()
    this.render()
  }
  private setLocale(locale: Locale) {
    this.locale = locale
    this.t = translator(locale)
    this.root.lang = locale
    this.launcher.setAttribute("aria-label", this.t(this.isOpen ? "launcher.close" : "launcher.open"))
    this.render()
  }
  private async loadWorkspace() {
    try {
      this.workspace = await this.client.workspace()
    } catch (e) {
      return console.warn("[chat] couldn't load the workspace:", e)
    }
    if (!this.workspace.turnstile_site_key && !this.options.sessionToken && !this.options.identityToken)
      console.info(
        `[chat] Email and anonymous sign-in aren't available on ${location.origin} (they need a human check that only runs on the workspace's own site). ` +
          "Identify signed-in users with Bellhop.init({ key, sessionToken }) or { identityToken }: https://blhp.app/docs/widget#identifying-users",
      )
    this.renderHead()
    this.render()
  }
  /** Visitors without a session can only start one where the workspace's human check runs. */
  private canSignIn() {
    return !!this.session || !this.workspace.name || !!this.workspace.turnstile_site_key
  }
  /**
   * Runs an action that needs a verified contact. Without a session it tries an anonymous one (if the workspace
   * allows them); when the workspace wants a verified email, it asks for one, then runs the action.
   */
  private async withContact(action: () => Promise<void>) {
    try {
      if (!this.session) {
        if (this.workspace.name && !this.workspace.allow_anonymous) return this.go({ name: "email", step: "email", then: action })
        try {
          await this.useSession(await this.client.anonymous({ turnstileToken: await this.human(), ...this.sessionOptions() }), false)
        } catch (e) {
          if (e instanceof BellhopError && (e.code === "anonymous_disabled" || e.code === "forbidden" || e.status === 403)) return this.go({ name: "email", step: "email", then: action })
          throw e
        }
      }
      await action()
    } catch (e) {
      if (e instanceof BellhopError && e.code === "contact_required") return this.go({ name: "email", step: "email", then: action })
      throw e
    }
  }
  private human() {
    const slot = this.body?.querySelector<HTMLElement>(".human") ?? null
    return turnstileToken(this.workspace.turnstile_site_key ?? undefined, slot)
  }

  // Data

  private sorted() {
    return [...this.conversations.values()].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
  }
  private async refreshList() {
    if (!this.session || this.loadingList) return
    this.loadingList = true
    try {
      const page = await this.session.listConversations()
      for (const c of page.data) this.conversations.set(c.id, c)
      this.listError = false
    } catch (e) {
      this.listError = true
      this.handle(e)
    } finally {
      this.loadingList = false
    }
    this.updateUnread()
    const shape = JSON.stringify([this.listError, this.sorted().map((c) => [c.id, c.updated_at, c.unread, c.status])])
    if (this.view.name === "home" && shape !== this.listShape) this.render()
    this.listShape = shape
  }
  private listShape = ""
  private older = new Map<string, string | null>()
  private loadingOlder = false
  private attachments: Attachment[] = []
  private uploadError: string | null = null
  private attachRow: HTMLElement | null = null
  /** Prepends the page before the oldest loaded item, keeping what's on screen where it is. */
  private async loadOlder(id: string) {
    const cursor = this.older.get(id)
    if (!cursor || this.loadingOlder || !this.session) return
    this.loadingOlder = true
    this.renderThread(false, true)
    try {
      const page = await this.session.older(id, { cursor })
      const list = this.items.get(id) ?? []
      const known = new Set(list.map((i) => i.id))
      this.items.set(id, [...page.data.filter((i) => !known.has(i.id)), ...list])
      this.older.set(id, page.next_cursor)
    } catch (e) {
      this.handle(e)
    } finally {
      this.loadingOlder = false
    }
    if (this.view.name === "conversation" && this.view.id === id) this.renderThread(false, true)
  }
  private async attach(file: File) {
    if (!this.session) return
    const a: Attachment = { local: randomId(), name: file.name, state: "uploading" }
    this.attachments.push(a)
    this.uploadError = null
    this.renderAttachments()
    try {
      a.upload = await this.session.upload(file)
      a.state = "done"
    } catch (e) {
      this.attachments = this.attachments.filter((x) => x !== a)
      const t = this.t,
        kind = uploadErrorKind(e)
      this.uploadError =
        kind === "too_large"
          ? t("upload.tooLarge", { name: file.name })
          : kind === "quota"
            ? t("upload.quota")
            : kind === "type"
              ? t("upload.type", { name: file.name })
              : kind === "rate_limited"
                ? t("upload.rateLimited")
                : t("upload.failed", { name: file.name })
      if (!kind) this.handle(e)
    }
    this.renderAttachments()
  }
  private renderAttachments() {
    const row = this.attachRow
    if (!row) return
    const t = this.t
    const chips = this.attachments.map((a) =>
      h(
        "span",
        { class: "chip" },
        h("span", { class: "chip-name" }, a.state === "uploading" ? t("upload.uploading", { name: a.name }) : a.name),
        a.state === "done"
          ? h(
              "button",
              {
                class: "icon-btn",
                type: "button",
                "aria-label": t("composer.removeFile", { name: a.name }),
                onclick: () => {
                  this.attachments = this.attachments.filter((x) => x !== a)
                  this.renderAttachments()
                },
              },
              icons.close(),
            )
          : null,
      ),
    )
    row.replaceChildren(...chips, this.uploadError ? h("p", { class: "err", role: "alert" }, this.uploadError) : "")
    row.hidden = !chips.length && !this.uploadError
    const send = this.panel?.querySelector<HTMLButtonElement>(".send")
    if (send) send.disabled = this.attachments.some((x) => x.state === "uploading") || (!this.textarea?.value.trim() && !this.attachments.length)
  }
  private confirmed = new Set<string>()
  /** Opens a thread at its newest items; older ones load as the person scrolls up. */
  private async loadItems(id: string) {
    if (!this.session) return
    let all: ConversationItem[]
    try {
      const page = await this.session.latest(id, 30)
      all = page.data
      this.older.set(id, page.next_cursor)
    } catch (e) {
      return this.handle(e)
    }
    this.items.set(id, all)
    this.sub?.watch(id, all.at(-1)?.id ?? null)
    if (this.view.name === "conversation" && this.view.id === id) {
      this.renderThread(true)
      this.markRead()
    }
  }
  private onEvent(e: RealtimeEvent) {
    if (e.type === "conversation.updated") {
      this.conversations.set(e.conversation.id, e.conversation)
      this.updateUnread()
      if (this.view.name === "home") this.render()
      else if (this.view.name === "conversation" && this.view.id === e.conversation.id) {
        this.renderCard()
        if (e.conversation.unread) this.markRead()
      }
    } else if (e.type === "item.created") {
      const list = this.items.get(e.conversation_id)
      if (list && !list.some((i) => i.id === e.item.id)) {
        list.push(e.item)
        this.pending = this.pending.filter((p) => !(e.item.kind === "message" && p.conversationId === e.conversation_id && p.state === "sending" && e.item.message.author.type === "user" && e.item.message.body === p.body))
      }
      const c = this.conversations.get(e.conversation_id)
      const fromOthers = e.item.kind === "message" ? e.item.message.author.type !== "user" : !!e.item.actor && e.item.actor.type !== "user"
      if (c) {
        const ev = e.item.kind === "event" ? e.item.event : null
        this.conversations.set(c.id, {
          ...c,
          last_item: e.item,
          updated_at: e.item.created_at,
          unread: c.unread + (fromOthers ? 1 : 0),
          ...(ev?.type === "status_changed" ? { status: ev.status, close_reason: ev.close_reason } : {}),
        })
      }
      if (fromOthers) {
        this.typing.delete(e.conversation_id)
        if (e.item.kind === "message") {
          this.activity.delete(e.conversation_id)
          this.announce(`${this.name(e.item.message.author)}: ${snippet(e.item.message.body).slice(0, 200)}`)
        }
      }
      if (this.view.name === "conversation" && this.view.id === e.conversation_id) {
        this.renderThread(false)
        this.markRead()
      } else if (this.view.name === "home") this.render()
      this.updateUnread()
      if (!c) void this.refreshList()
    } else if (e.type === "message.updated") {
      const list = this.items.get(e.conversation_id)
      const at = list?.findIndex((i) => i.kind === "message" && i.id === e.message.id) ?? -1
      if (list && at >= 0) list[at] = { ...(list[at] as ConversationItem & { kind: "message" }), message: e.message }
      if (this.view.name === "conversation" && this.view.id === e.conversation_id) this.renderThread(false)
    } else if (e.type === "typing") {
      if (e.participant.type === "user") return
      this.typing.set(e.conversation_id, { name: this.name(e.participant), until: Date.now() + 6000 })
      this.renderLive()
    } else if (e.type === "activity") {
      if (e.text) this.activity.set(e.conversation_id, { name: this.name(e.participant), text: e.text })
      else this.activity.delete(e.conversation_id)
      this.renderLive()
    }
  }
  private onConnection(state: ConnectionState) {
    if (state === "live") this.wasLive = true
    this.connection = state
    if (state === "ended") {
      this.session = null
      this.forget()
    }
    this.renderNotice()
  }
  private updateUnread() {
    const total = [...this.conversations.values()].reduce((n, c) => n + c.unread, 0)
    this.badge.hidden = total === 0
    this.badge.textContent = total > 99 ? "99+" : String(total)
    this.launcher.setAttribute("aria-label", (this.isOpen ? this.t("launcher.close") : this.t("launcher.open")) + (total ? ` (${this.t("launcher.unread", { count: total })})` : ""))
    if (total !== this.unreadTotal) {
      this.unreadTotal = total
      this.emit("unread", total)
    }
  }
  private markRead() {
    if (!this.isOpen || document.hidden || this.view.name !== "conversation" || !this.view.id || !this.session) return
    const id = this.view.id,
      last = this.items.get(id)?.at(-1),
      c = this.conversations.get(id)
    if (!last || (c && c.unread === 0 && c.last_item?.id === last.id)) return
    if (c) this.conversations.set(id, { ...c, unread: 0, last_item: last })
    this.updateUnread()
    void this.session.markRead(id, last.id).catch((e) => this.handle(e))
  }
  private handle(e: unknown) {
    if (e instanceof BellhopError && e.status === 401) {
      this.onConnection("ended")
      return
    }
    console.warn("[chat]", e)
  }
  private emit(event: WidgetEvent, data?: unknown) {
    for (const fn of this.listeners.get(event) ?? []) {
      try {
        fn(data)
      } catch (e) {
        console.error(e)
      }
    }
  }
  private announce(text: string) {
    this.announcer.textContent = ""
    requestAnimationFrame(() => (this.announcer.textContent = text))
  }
  private name(p: Participant | null) {
    if (!p) return this.t("conversation.someone")
    return p.type === "user" ? this.t("conversation.you") : p.name || (p.type === "agent" ? this.t("conversation.agentLabel") : this.t("conversation.team"))
  }

  // Sending

  private async send(text: string) {
    const body = text.trim()
    const files = this.attachments.filter((a) => a.state === "done").map((a) => a.upload!)
    if (!body && !files.length) return
    const view = this.view
    if (view.name !== "conversation") return
    this.attachments = []
    this.renderAttachments()
    const p: Pending = { local: randomId(), conversationId: view.id, body, files, state: "sending", key: randomId() }
    this.pending.push(p)
    this.renderThread(true)
    const run = async () => {
      p.state = "sending"
      this.renderThread(false)
      const s = this.session!
      if (!p.conversationId) {
        const c = await s.createConversation(
          {
            subject: this.draft.subject ?? (snippet(body.split("\n")[0]!).slice(0, 80) || undefined),
            message: { body, attachments: files.map((f) => f.id) },
            metadata_id: this.draft.metadataId,
          },
          { idempotencyKey: p.key },
        )
        this.draft = { body: "" }
        this.conversations.set(c.id, c)
        p.conversationId = c.id
        this.pending = this.pending.filter((x) => x !== p)
        this.updateUnread()
        if (this.view.name === "conversation" && this.view.id === null) this.go({ name: "conversation", id: c.id })
        return
      }
      const m = await s.sendMessage(p.conversationId, { body, attachments: files.map((f) => f.id) }, { idempotencyKey: p.key })
      const list = this.items.get(p.conversationId)
      if (list && !list.some((i) => i.id === m.id)) list.push({ kind: "message", id: m.id, created_at: m.created_at, message: m })
      this.pending = this.pending.filter((x) => x !== p)
      this.sub?.watch(p.conversationId, list?.at(-1)?.id)
      if (this.view.name === "conversation" && this.view.id === p.conversationId) this.renderThread(true)
      void this.sub?.refresh()
    }
    const failed = (e: unknown) => {
      p.state = "failed"
      this.handle(e)
      this.renderThread(false)
    }
    // A request refused for a precondition (contact_required) never ran, but the API replays its stored 4xx for that
    // Idempotency-Key for a while: once the person has verified, retry under a new key. Failures after the email
    // step (which resumes this) mark the message failed here, since that view is gone by then.
    const attempt = () =>
      run().catch((e) => {
        if (!(e instanceof BellhopError && e.code === "contact_required")) return failed(e)
        p.key = randomId()
        throw e
      })
    p.retry = () => this.withContact(attempt).catch(failed)
    await p.retry()
  }

  // Rendering

  private go(view: View) {
    if (this.view.name === "conversation" && this.view.id && !(view.name === "conversation" && view.id === this.view.id)) this.sub?.unwatch(this.view.id)
    this.view = view
    this.render()
    if (view.name === "conversation" && view.id) {
      if (this.items.has(view.id)) {
        this.sub?.watch(view.id, this.items.get(view.id)!.at(-1)?.id ?? null)
        this.markRead()
      } else void this.loadItems(view.id)
    }
  }
  private buildPanel() {
    if (this.panel) return
    this.notice = h("div", { class: "notice", hidden: true })
    this.body = h("div", { class: "body" })
    this.panel = h("div", { class: "panel", role: "dialog", "aria-modal": "true", "aria-label": this.t("panel.label"), onkeydown: (e: Event) => this.onKey(e as KeyboardEvent) }, h("div", { class: "head" }), this.notice, this.body)
    this.root.insertBefore(this.panel, this.launcher)
    this.render()
    requestAnimationFrame(() => {
      const target = ["textarea", "input", ".btn.primary", ".row", ".icon-btn"].map((sel) => this.panel?.querySelector<HTMLElement>(`.body ${sel}, ${sel}`)).find(Boolean)
      target?.focus()
    })
  }
  private onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation()
      return this.close()
    }
    if (e.key !== "Tab" || !this.panel) return
    const focusable = [...this.panel.querySelectorAll<HTMLElement>('button:not([disabled]),a[href],input:not([disabled]),textarea:not([disabled]),[tabindex="0"]')].filter((el) => !el.closest("[hidden]"))
    if (!focusable.length) return
    const first = focusable[0]!,
      last = focusable.at(-1)!,
      active = this.shadow.activeElement
    if (e.shiftKey && (active === first || !this.panel.contains(active))) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
  private render() {
    if (!this.panel || !this.body) return
    // Keep keyboard focus on the same control across a re-render (e.g. when the list refreshes underneath).
    const focused = (this.shadow.activeElement as HTMLElement | null)?.dataset?.k
    queueMicrotask(() => focused && this.panel?.querySelector<HTMLElement>(`[data-k="${CSS.escape(focused)}"]`)?.focus())
    this.renderHead()
    this.renderNotice()
    this.thread = this.live = this.card = this.textarea = null
    if (this.typingTimer) clearInterval(this.typingTimer)
    const v = this.view
    if (v.name === "home") this.body.replaceChildren(this.homeView())
    else if (v.name === "email") this.body.replaceChildren(this.emailView(v))
    else this.body.replaceChildren(...this.conversationView(v.id))
  }
  private renderHead() {
    const head = this.panel?.querySelector(".head")
    if (!head) return
    const t = this.t,
      inner = this.view.name !== "home",
      c = this.view.name === "conversation" && this.view.id ? this.conversations.get(this.view.id) : null
    const title = c?.subject ?? (this.view.name === "conversation" ? t("conversation.new") : (this.workspace.name ?? t("panel.fallbackTitle")))
    head.replaceChildren(
      ...[
      inner ? h("button", { class: "icon-btn", type: "button", "data-k": "back", "aria-label": t("panel.back"), onclick: () => this.go({ name: "home" }) }, icons.back()) : null,
      h("div", { class: "title" }, !inner && this.workspace.icon_url ? h("img", { class: "icon", src: this.workspace.icon_url, alt: "" }) : null, h("span", {}, title)),
      h("button", { class: "icon-btn", type: "button", "data-k": "close", "aria-label": t("panel.close"), onclick: () => this.close() }, icons.close()),
      ].filter((x) => x !== null),
    )
  }
  private renderNotice() {
    const n = this.notice
    if (!n) return
    const t = this.t
    const state = this.connection
    const text = state === "offline" ? t("state.offline") : state === "ended" ? t("state.ended") : state === "connecting" && this.wasLive ? t("state.reconnecting") : null
    n.hidden = !text
    n.replaceChildren(text ?? "")
    if (state === "ended")
      n.append(h("button", { class: "btn quiet", type: "button", onclick: () => ((this.connection = "polling"), this.clearSession(), void this.start()) }, t("state.restart")))
  }
  private homeView() {
    const t = this.t
    const list = this.sorted()
    const name = this.session?.user?.name?.split(" ")[0]
    return h(
      "div",
      { class: "scroll" },
      h(
        "div",
        { class: "home" },
        h("div", { class: "hello" }, h("h2", {}, name ? `${t("home.greeting", { name })}` : t("home.title")), name ? h("p", {}, t("home.title")) : this.canSignIn() ? h("p", {}, t("home.text")) : null),
        this.canSignIn()
          ? h("button", { class: "btn primary block", type: "button", "data-k": "new", onclick: () => this.newConversation() }, icons.plus(), t("home.new"))
          : h("div", { class: "card signin", role: "note" }, h("h3", {}, t("signin.title", { host: location.hostname })), h("p", {}, t("signin.text"))),
        this.session && (list.length || this.loadingList || this.listError)
          ? h(
              "div",
              {},
              h("h3", { class: "section" }, t("home.recent")),
              h(
                "div",
                { class: "list" },
                list.length ? list.slice(0, 20).map((c) => this.row(c)) : h("p", { class: "empty" }, this.listError ? t("error.generic") : t("home.loading")),
              ),
            )
          : null,
      ),
    )
  }
  private row(c: Conversation) {
    const t = this.t
    const last = c.last_item
    let text = ""
    if (last?.kind === "message") {
      const body = snippet(last.message.body) || t("row.attachment")
      text = last.message.author.type === "user" ? t("row.you", { text: body }) : body
    } else if (last) text = this.eventText(last)
    return h(
      "button",
      { class: "row", type: "button", "data-k": "c:" + c.id, onclick: () => this.go({ name: "conversation", id: c.id }) },
      h("span", { class: "row-top" }, h("span", { class: "row-subject", dir: "auto" }, c.subject), h("span", { class: "row-time" }, this.relative(c.updated_at))),
      h(
        "span",
        { class: "row-bottom" },
        h("span", { class: "row-text", dir: "auto" }, text),
        c.unread ? h("span", { class: "pill unread" }, t("row.unread", { count: c.unread })) : null,
        c.status === "closed" || c.status === "waiting" ? h("span", { class: "pill" }, t(`status.${c.status}`)) : null,
      ),
    )
  }
  private conversationView(id: string | null): Node[] {
    const t = this.t
    this.thread = h("div", { class: "thread", role: "log", "aria-label": t("panel.label") })
    this.live = h("div", { class: "live", "aria-hidden": "true" })
    this.card = h("div", { hidden: true })
    const textarea = h("textarea", {
      rows: 1,
      placeholder: id ? t("composer.placeholder") : t("composer.firstPlaceholder"),
      "aria-label": id ? t("composer.placeholder") : t("composer.firstPlaceholder"),
      "aria-describedby": "bw-hint",
      enterkeyhint: "send",
    })
    textarea.value = id ? "" : this.draft.body
    const sendBtn = h("button", { class: "send", type: "button", "aria-label": t("composer.send"), disabled: !textarea.value.trim() && !this.attachments.length }, icons.send())
    const file = h("input", { type: "file", class: "sr", tabindex: "-1", "aria-hidden": "true" })
    file.addEventListener("change", () => {
      for (const f of file.files ?? []) void this.attach(f)
      file.value = ""
    })
    const attachBtn = this.session
      ? h("button", { class: "icon-btn attach", type: "button", "aria-label": t("composer.attach"), onclick: () => file.click() }, icons.clip())
      : null
    this.attachRow = h("div", { class: "attachments", hidden: true })
    const submit = () => {
      const value = textarea.value
      if (!value.trim() && !this.attachments.some((a) => a.state === "done")) return
      if (this.attachments.some((a) => a.state === "uploading")) return
      textarea.value = ""
      if (!id) this.draft.body = ""
      grow()
      void this.send(value)
    }
    const grow = () => {
      textarea.style.height = "auto"
      textarea.style.height = Math.min(140, textarea.scrollHeight) + "px"
      sendBtn.disabled = (!textarea.value.trim() && !this.attachments.some((a) => a.state === "done")) || this.attachments.some((a) => a.state === "uploading")
    }
    textarea.addEventListener("input", () => {
      grow()
      if (!id) this.draft.body = textarea.value
      if (id && this.session && Date.now() - this.lastTyping > 3000) {
        this.lastTyping = Date.now()
        void this.session.typing(id).catch(() => {})
      }
    })
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        submit()
      }
    })
    sendBtn.addEventListener("click", submit)
    this.textarea = textarea
    requestAnimationFrame(grow)
    this.typingTimer = setInterval(() => this.renderLive(), 1000)
    const scroll = h("div", { class: "scroll" }, this.thread)
    // Near the top, load the page before the oldest message.
    scroll.addEventListener("scroll", () => id && scroll.scrollTop < 160 && this.items.has(id) && void this.loadOlder(id), { passive: true })
    const out = [
      scroll,
      this.live,
      this.card,
      h("div", { class: "human" }),
      this.attachRow,
      h("div", { class: "composer" }, attachBtn, textarea, sendBtn, file),
      h("span", { id: "bw-hint", class: "sr" }, t("composer.hint")),
    ]
    this.renderAttachments()
    this.renderThread(true)
    this.renderLive()
    this.renderCard()
    return out
  }
  /** stick: scroll to the newest. anchor: keep the content on screen in place (older messages prepended above). */
  private renderThread(stick: boolean, anchor = false) {
    const thread = this.thread,
      v = this.view
    if (!thread || v.name !== "conversation") return
    const t = this.t
    const scroller = thread.parentElement
    const atBottom = !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80
    const fromBottom = scroller ? scroller.scrollHeight - scroller.scrollTop : 0
    const items = v.id ? this.items.get(v.id) : []
    const nodes: Node[] = []
    if (v.id && this.older.get(v.id)) nodes.push(h("p", { class: "event older", "aria-hidden": "true" }, this.loadingOlder ? t("conversation.older") : "\u00a0"))
    if (!items) nodes.push(h("p", { class: "event" }, t("conversation.loading")))
    else if (!items.length && !this.pending.some((p) => p.conversationId === v.id)) nodes.push(h("p", { class: "event" }, t("conversation.empty")))
    let prev: { author: string; at: number } | null = null
    for (const item of items ?? []) {
      if (item.kind === "event") {
        nodes.push(h("p", { class: "event" }, this.eventText(item)))
        prev = null
        continue
      }
      const m = item.message,
        mine = m.author.type === "user",
        at = Date.parse(m.created_at),
        cont = !!prev && prev.author === m.author.id && at - prev.at < 5 * 60_000
      prev = { author: m.author.id, at }
      // dir=auto + unicode-bidi: isolate (CSS): bidi override characters can't reorder text outside the bubble.
      const bubble = h("div", { class: "bubble", dir: "auto" }, markdown(m.body))
      for (const a of m.attachments) {
        // File names with bidi controls ("invoice\u202Efdp.exe") could pose as another type: drop them.
        const label = t("conversation.attachment", { name: a.name.replace(/[\u202a-\u202e\u2066-\u2069]/g, "") })
        bubble.append(h("p", {}, /^https?:\/\//.test(a.url) ? h("a", { href: a.url, target: "_blank", rel: "noopener noreferrer", dir: "auto" }, label) : label))
      }
      nodes.push(
        h(
          "div",
          { class: `msg${mine ? " mine" : ""}${cont ? " cont" : ""}` },
          cont
            ? null
            : h(
                "div",
                { class: "who" },
                mine ? null : h("span", {}, this.name(m.author)),
                m.author.type === "agent" ? h("span", { class: "ai", title: t("conversation.agentLabel") }, t("conversation.agent")) : null,
                h("time", { datetime: m.created_at }, this.clock(m.created_at)),
              ),
          bubble,
          m.edited_at ? h("div", { class: "meta" }, t("conversation.edited")) : null,
        ),
      )
    }
    for (const p of this.pending.filter((x) => x.conversationId === v.id)) {
      nodes.push(
        h(
          "div",
          { class: "msg mine" },
          h("div", { class: "bubble", dir: "auto" }, markdown(p.body), ...p.files.map((f) => h("p", {}, t("conversation.attachment", { name: f.name })))),
          p.state === "sending"
            ? h("div", { class: "meta" }, t("composer.sending"))
            : h("div", { class: "meta err" }, t("composer.failed"), " ", h("button", { type: "button", onclick: () => p.retry?.() }, t("composer.retry"))),
        ),
      )
    }
    const c = v.id ? this.conversations.get(v.id) : null
    if (c?.status === "closed") nodes.push(h("p", { class: "event" }, t("conversation.closedNote")))
    thread.replaceChildren(...nodes)
    if (scroller && anchor && !stick) scroller.scrollTop = scroller.scrollHeight - fromBottom
    else if (scroller && (stick || atBottom)) {
      scroller.scrollTop = scroller.scrollHeight
      requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight))
    }
    this.renderHead()
  }
  private renderLive() {
    const live = this.live,
      v = this.view
    if (!live || v.name !== "conversation" || !v.id) return live?.replaceChildren()
    const typing = this.typing.get(v.id),
      act = this.activity.get(v.id)
    const dots = () => h("span", { class: "dots" }, h("i"), h("i"), h("i"))
    if (act) live.replaceChildren(dots(), h("span", {}, act.text))
    else if (typing && typing.until > Date.now()) live.replaceChildren(dots(), h("span", {}, this.t("conversation.typing", { name: typing.name })))
    else live.replaceChildren()
  }
  /** The verification card: the team asked to confirm an email; the code arrived by email. */
  private renderCard() {
    const card = this.card,
      v = this.view
    if (!card || v.name !== "conversation" || !v.id) return
    const id = v.id
    const t = this.t
    const c = this.conversations.get(id)
    // A code confirmed here counts as verified even if a slightly older snapshot of the conversation arrives later.
    const state = (x: { id: string; state: string }) => (this.confirmed.has(x.id) ? "verified" : x.state)
    const proof = c?.verifications.filter((x) => state(x) === "pending").at(-1)
    const done = c?.verifications.filter((x) => state(x) === "verified").at(-1)
    if (!proof) {
      card.hidden = true
      if (done && card.dataset.proof === done.id) {
        card.hidden = false
        card.className = "card"
        card.replaceChildren(h("p", { class: "ok", role: "status" }, t("verify.done", { email: done.email })))
      }
      return
    }
    if (card.dataset.proof === proof.id && !card.hidden) return
    card.dataset.proof = proof.id
    card.hidden = false
    card.className = "card"
    const input = h("input", { class: "input code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, "aria-label": t("verify.code"), placeholder: "000000" })
    const error = h("p", { class: "err", role: "alert", hidden: true })
    const button = h("button", { class: "btn primary", type: "submit" }, t("verify.submit"))
    const form = h(
      "form",
      {
        class: "field",
        onsubmit: async (e: Event) => {
          e.preventDefault()
          const code = input.value.replace(/\D/g, "")
          if (code.length !== 6 || !this.session) return
          button.disabled = true
          button.textContent = t("verify.checking")
          error.hidden = true
          try {
            const result = await this.session.confirmVerification(id, proof.id, code)
            const conv = this.conversations.get(id)
            if (conv) this.conversations.set(id, { ...conv, verifications: conv.verifications.map((x) => (x.id === result.id ? result : x)) })
            if (result.state !== "verified") throw new BellhopError(400, result.state, result.state)
            this.confirmed.add(result.id)
            card.dataset.proof = result.id
            this.renderCard()
            void this.sub?.refresh()
          } catch (err) {
            const code = err instanceof BellhopError ? err.code : ""
            error.textContent = code === "expired" ? t("verify.expired") : code === "failed" ? t("verify.failed") : t("verify.wrong")
            error.hidden = false
            button.disabled = false
            button.textContent = t("verify.submit")
          }
        },
      },
      input,
      button,
    )
    card.replaceChildren(h("h3", {}, t("verify.title")), h("p", {}, t("verify.text", { email: proof.email })), form, error)
  }
  private emailView(v: View & { name: "email" }) {
    const t = this.t
    const error = h("p", { class: "err", role: "alert", hidden: true })
    const fail = (text: string) => ((error.textContent = text), (error.hidden = false))
    const human = h("div", { class: "human" })
    let challenge: EmailChallenge | null = (this as { challenge?: EmailChallenge }).challenge ?? null
    if (v.step === "email" || !challenge) {
      const input = h("input", { class: "input", type: "email", autocomplete: "email", required: true, id: "bw-email", placeholder: t("email.placeholder"), value: this.session?.user?.email ?? "" })
      const button = h("button", { class: "btn primary block", type: "submit" }, t("email.continue"))
      const form = h(
        "form",
        {
          class: "form",
          novalidate: true,
          onsubmit: async (e: Event) => {
            e.preventDefault()
            const email = input.value.trim()
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(t("email.invalid"))
            error.hidden = true
            button.disabled = true
            button.textContent = t("email.sending")
            try {
              const turnstile = await turnstileToken(this.workspace.turnstile_site_key ?? undefined, human)
              // An anonymous session starts the sign-in itself, so its conversations move to the verified contact.
              ;(this as { challenge?: EmailChallenge }).challenge = this.session?.user?.anonymous
                ? await this.session.startEmail(email, { turnstileToken: turnstile })
                : await this.client.startEmail(email, { turnstileToken: turnstile })
              this.go({ ...v, step: "code" })
            } catch (err) {
              fail(this.errorText(err))
              button.disabled = false
              button.textContent = t("email.continue")
            }
          },
        },
        h("h2", {}, t("email.title")),
        h("p", { class: "muted" }, t("email.text")),
        h("label", { for: "bw-email" }, t("email.label")),
        input,
        human,
        error,
        button,
      )
      requestAnimationFrame(() => input.focus())
      return h("div", { class: "scroll" }, form)
    }
    const input = h("input", { class: "input code", id: "bw-code", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, placeholder: "000000" })
    const button = h("button", { class: "btn primary block", type: "submit" }, t("email.verify"))
    const note = h("p", { class: "ok", role: "status", hidden: true }, t("email.resent"))
    const form = h(
      "form",
      {
        class: "form",
        onsubmit: async (e: Event) => {
          e.preventDefault()
          const code = input.value.replace(/\D/g, "")
          if (code.length !== 6) return fail(t("email.wrongCode"))
          error.hidden = true
          button.disabled = true
          button.textContent = t("email.verifying")
          try {
            const anonymous = this.session?.user?.anonymous ? this.session : null
            await this.useSession(anonymous ? await anonymous.verifyEmail(challenge!, code) : await this.client.verifyEmail(challenge!, code, this.sessionOptions()), false)
            ;(this as { challenge?: EmailChallenge }).challenge = undefined
            this.go({ name: "conversation", id: null })
            await v.then()
          } catch (err) {
            fail(err instanceof BellhopError && err.code === "invalid_code" ? t("email.wrongCode") : this.errorText(err))
            button.disabled = false
            button.textContent = t("email.verify")
          }
        },
      },
      h("h2", {}, t("email.codeTitle")),
      h("p", { class: "muted" }, t("email.codeText", { email: challenge.email })),
      h("label", { for: "bw-code" }, t("email.code")),
      input,
      human,
      error,
      note,
      button,
      h(
        "div",
        { class: "links" },
        h("button", { class: "btn quiet", type: "button", onclick: () => this.go({ ...v, step: "email" }) }, t("email.change")),
        h(
          "button",
          {
            class: "btn quiet",
            type: "button",
            onclick: async () => {
              try {
                const again = { turnstileToken: await turnstileToken(this.workspace.turnstile_site_key ?? undefined, human), challenge: challenge!.challenge }
                if (this.session?.user?.anonymous) await this.session.startEmail(challenge!.email, again)
                else await this.client.startEmail(challenge!.email, again)
                note.hidden = false
              } catch (err) {
                fail(this.errorText(err))
              }
            },
          },
          t("email.resend"),
        ),
      ),
    )
    requestAnimationFrame(() => input.focus())
    return h("div", { class: "scroll" }, form)
  }
  private errorText(e: unknown) {
    if (e instanceof BellhopError) {
      if (e.status === 429) return this.t("error.rateLimited")
      if (e.status === 503 || e.code === "unavailable") return this.t("error.unavailable")
    }
    return this.t("error.generic")
  }
  private eventText(item: ConversationItem & { kind: "event" }) {
    const t = this.t,
      e = item.event
    if (e.type === "status_changed")
      return e.status === "closed" ? t("event.closed") : e.status === "in_progress" ? t("event.in_progress") : e.status === "waiting" ? t("event.waiting") : t("event.reopened")
    if (e.type === "assigned") return e.assignee ? t("event.assigned", { name: this.name(e.assignee) }) : t("event.unassigned")
    return e.type === "verified" ? t("event.verified") : t("event.verificationRequested")
  }
  private clock(iso: string) {
    return new Intl.DateTimeFormat(this.locale, { hour: "numeric", minute: "2-digit" }).format(new Date(iso))
  }
  private relative(iso: string) {
    const s = (Date.parse(iso) - Date.now()) / 1000,
      rtf = new Intl.RelativeTimeFormat(this.locale, { numeric: "auto", style: "narrow" })
    const abs = Math.abs(s)
    if (abs < 60) return rtf.format(0, "second")
    if (abs < 3600) return rtf.format(Math.round(s / 60), "minute")
    if (abs < 86400) return rtf.format(Math.round(s / 3600), "hour")
    if (abs < 7 * 86400) return rtf.format(Math.round(s / 86400), "day")
    return new Intl.DateTimeFormat(this.locale, { month: "short", day: "numeric" }).format(new Date(iso))
  }
}
