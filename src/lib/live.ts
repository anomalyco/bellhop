import { useEffect, useRef } from "react"
import type { LiveEvent } from "../../shared/api"

/** One live WebSocket per page. Reconnects with jittered backoff and pings every 25 s.
 *  `onOpen(reconnected)` lets the page refetch whatever it may have missed while disconnected. */
export function useLive(path: string | null, onEvent: (event: LiveEvent) => void, onOpen?: (reconnected: boolean) => void) {
  const handlers = useRef({ onEvent, onOpen })
  handlers.current = { onEvent, onOpen }

  useEffect(() => {
    if (!path) return
    let ws: WebSocket | null = null
    let attempt = 0
    let opened = false
    let closed = false
    let ping: ReturnType<typeof setInterval> | undefined
    let retry: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${path}`
      ws = new WebSocket(url)
      ws.onopen = () => {
        attempt = 0
        handlers.current.onOpen?.(opened)
        opened = true
        ping = setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25_000)
      }
      ws.onmessage = (message) => {
        if (typeof message.data !== "string" || message.data === "pong") return
        try {
          handlers.current.onEvent(JSON.parse(message.data) as LiveEvent)
        } catch {
          // Ignore anything that isn't a LiveEvent.
        }
      }
      ws.onclose = () => {
        clearInterval(ping)
        if (closed) return
        const delay = Math.min(30_000, 500 * 2 ** attempt++) * (0.75 + Math.random() * 0.5)
        retry = setTimeout(connect, delay)
      }
    }

    // Reconnect at once when the tab comes back after the socket died in the background.
    const onVisible = () => {
      if (document.visibilityState === "visible" && ws?.readyState === WebSocket.CLOSED) {
        clearTimeout(retry)
        attempt = 0
        connect()
      }
    }

    connect()
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      closed = true
      clearTimeout(retry)
      clearInterval(ping)
      document.removeEventListener("visibilitychange", onVisible)
      ws?.close()
    }
  }, [path])
}
