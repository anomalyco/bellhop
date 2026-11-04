import type { Conversation, RealtimeEvent } from "../../shared/v1"
import { BellhopError } from "./http"
import type { SessionClient } from "./session"

export type RealtimeHandler = (event: RealtimeEvent) => void

/**
 * live: a realtime socket is open. polling: no socket (the API doesn't offer one, or it keeps failing), so the SDK
 * polls. connecting: (re)opening the socket. offline: no network; resumes and catches up when it's back.
 * ended: the session is no longer valid (401); create a new one.
 */
export type ConnectionState = "connecting" | "live" | "polling" | "offline" | "ended"

export interface SubscribeOptions {
  onState?: (state: ConnectionState) => void
  /** Use the realtime socket when the API offers it (default true). */
  realtime?: boolean
  /** Polling: how often watched conversations are checked for new items (ms, default 4000). */
  pollInterval?: number
  /** Polling: how often the conversation list is checked for changes and unread counts (ms, default 15000). */
  listInterval?: number
  /** The item a watched conversation was anchored on is gone (deleted or hidden): reload that timeline. */
  onReset?: (conversationId: string) => void
}

export interface Subscription {
  readonly state: ConnectionState
  /** Keeps a conversation caught up closely (the one on screen). `after`: the last item id you already have. */
  watch(conversationId: string, after?: string | null): void
  unwatch(conversationId: string): void
  /** Checks for changes now (e.g. right after the user sends something). */
  refresh(): Promise<void>
  close(): void
}

type Seen = { updated_at: string; unread: number; status: string; last: string | null }

export function subscribe(session: SessionClient, handler: RealtimeHandler, options: SubscribeOptions = {}): Subscription {
  const pollInterval = options.pollInterval ?? 4000,
    listInterval = options.listInterval ?? 15000
  const watched = new Map<string, string | null | undefined>() // conversation id -> last item id (undefined: unknown yet)
  const seen = new Map<string, Seen>()
  // Items arrive from the socket and from catch-up pages; each is delivered once.
  const delivered = new Set<string>()
  let state: ConnectionState = "connecting",
    closed = false,
    socket: WebSocket | null = null,
    socketFailures = 0,
    realtimeUnavailableUntil = options.realtime === false ? Infinity : 0,
    timers: ReturnType<typeof setTimeout>[] = [],
    lastList = 0,
    busy = false,
    pausedUntil = 0
  const g = globalThis as { document?: Document; addEventListener?: typeof addEventListener; removeEventListener?: typeof removeEventListener; navigator?: Navigator }

  const setState = (next: ConnectionState) => {
    if (next === state) return
    state = next
    options.onState?.(next)
  }
  const emit = (event: RealtimeEvent) => {
    if (event.type === "item.created") {
      if (delivered.has(event.item.id)) return
      delivered.add(event.item.id)
      if (delivered.size > 2000) delivered.delete(delivered.values().next().value!)
      if (watched.has(event.conversation_id)) watched.set(event.conversation_id, event.item.id)
    }
    if (event.type === "conversation.updated") remember(event.conversation)
    try {
      handler(event)
    } catch (e) {
      console.error(e)
    }
  }
  const remember = (c: Conversation) =>
    seen.set(c.id, { updated_at: c.updated_at, unread: c.unread, status: c.status, last: c.last_item?.id ?? null })
  const hidden = () => g.document?.visibilityState === "hidden"
  const later = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms))
  const clearTimers = () => (timers.forEach(clearTimeout), (timers = []))

  /** Fetches items after the last seen one for each watched conversation, and changed conversations. */
  async function catchUp(list: boolean) {
    if (busy || closed) return
    busy = true
    try {
      if (list) {
        lastList = Date.now()
        const page = await session.listConversations()
        for (const c of page.data) {
          const before = seen.get(c.id)
          if (!before || before.updated_at !== c.updated_at || before.unread !== c.unread || before.status !== c.status)
            emit({ type: "conversation.updated", conversation: c })
          else remember(c)
        }
      }
      for (const [id, after] of watched) {
        if (after === undefined) {
          // First look: take the newest item as the baseline without replaying history.
          let last: string | null = null
          for await (const item of session.items(id)) {
            last = item.id
            delivered.add(item.id)
          }
          if (watched.has(id)) watched.set(id, last)
          continue
        }
        try {
          for await (const item of session.items(id, after ? { after } : {})) {
            if (!watched.has(id)) break
            emit({ type: "item.created", conversation_id: id, item })
          }
        } catch (e) {
          // The anchor item was deleted or hidden: start over from the newest item and let the app reload.
          if (!(e instanceof BellhopError && e.status === 400 && after)) throw e
          watched.set(id, undefined)
          options.onReset?.(id)
        }
      }
      if (state === "offline") setState(socket ? "live" : "polling")
    } catch (e) {
      handleError(e)
    } finally {
      busy = false
    }
  }

  function handleError(e: unknown) {
    if (!(e instanceof BellhopError)) return console.error(e)
    if (e.status === 401) {
      setState("ended")
      close()
    } else if (e.status === 429) pausedUntil = Date.now() + (e.retryAfter ?? 10) * 1000
    else if (e.status === 0) setState("offline")
  }

  function poll() {
    if (closed) return
    const wait = Math.max(0, pausedUntil - Date.now())
    if (wait) return later(poll, wait)
    if (!socket && state !== "offline" && state !== "ended") setState("polling")
    const listDue = Date.now() - lastList >= listInterval * (hidden() ? 4 : 1)
    void catchUp(listDue || watched.size === 0).finally(() => {
      if (closed) return
      if (socket) return // the socket took over meanwhile
      if (Date.now() >= realtimeUnavailableUntil) return void connect()
      later(poll, watched.size ? pollInterval * (hidden() ? 4 : 1) : listInterval)
    })
  }

  async function connect() {
    if (closed) return
    const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket
    if (!WS || Date.now() < realtimeUnavailableUntil) return poll()
    setState("connecting")
    let url: string
    try {
      url = (await session.request<{ url: string }>({ method: "POST", path: "/realtime" })).url
    } catch (e) {
      if (e instanceof BellhopError && (e.status === 404 || e.status === 405 || e.status === 501)) {
        // This API version has no realtime yet: poll, and look again in a few minutes.
        realtimeUnavailableUntil = Date.now() + 5 * 60_000
      } else {
        handleError(e)
        realtimeUnavailableUntil = Date.now() + Math.min(60_000, 2000 * 2 ** socketFailures++)
      }
      return poll()
    }
    if (closed) return
    const ws = new WS(url)
    socket = ws
    let heartbeat: ReturnType<typeof setInterval> | undefined
    ws.onopen = () => {
      socketFailures = 0
      setState("live")
      // The socket wants a text ping every 25 s ("pong" comes back and isn't an event).
      heartbeat = setInterval(() => ws.readyState === 1 && ws.send("ping"), 25_000)
      // Frames that arrive during catch-up are merged by item id (see `delivered`).
      void catchUp(true)
    }
    ws.onmessage = (m) => {
      if (m.data === "pong") return
      try {
        emit(JSON.parse(String(m.data)) as RealtimeEvent)
      } catch {
        /* not an event */
      }
    }
    ws.onclose = (event) => {
      clearInterval(heartbeat)
      if (socket !== ws) return
      socket = null
      if (closed) return
      if (event.code === 4401) {
        // The session is no longer authorized.
        setState("ended")
        return close()
      }
      // Reconnect with backoff; poll in between so nothing is missed.
      realtimeUnavailableUntil = Date.now() + Math.min(30_000, 1000 * 2 ** socketFailures++) + Math.random() * 500
      poll()
    }
  }

  const online = () => {
    if (closed) return
    clearTimers()
    if (!socket) void connect()
    else void catchUp(true)
  }
  const offline = () => !closed && setState("offline")
  const visible = () => !hidden() && !closed && !socket && (clearTimers(), poll())
  g.addEventListener?.("online", online)
  g.addEventListener?.("offline", offline)
  g.document?.addEventListener("visibilitychange", visible)

  function close() {
    if (closed) return
    closed = true
    clearTimers()
    const ws = socket
    socket = null
    ws?.close()
    g.removeEventListener?.("online", online)
    g.removeEventListener?.("offline", offline)
    g.document?.removeEventListener("visibilitychange", visible)
  }

  if (g.navigator?.onLine === false) setState("offline")
  void connect()

  return {
    get state() {
      return state
    },
    watch(id, after) {
      watched.set(id, after === undefined ? watched.get(id) : after)
      if (!socket && !closed) {
        clearTimers()
        poll()
      }
    },
    unwatch(id) {
      watched.delete(id)
    },
    refresh: () => catchUp(true),
    close,
  }
}
