import { memo, useEffect, useMemo, useState, useSyncExternalStore } from "react"

// The server's clock, as far as this page knows: boot data carries the server time, so relative times read the
// same as on the server even when this device's clock is off.
let offset = 0
export const clockNow = () => Date.now() + offset
/** `serverIso` was the server's time when this device's clock read `clientAt`. */
export function setServerClock(serverIso: string, clientAt: number) {
  const d = Date.parse(serverIso) - clientAt
  if (!Number.isFinite(d)) return
  offset = Math.abs(d) < 1000 ? 0 : d
  minute = clockNow()
}

// One shared minute ticker re-renders every relative time on the page.
let minute = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void) {
  listeners.add(listener)
  timer ??= setInterval(() => {
    minute = clockNow()
    for (const l of listeners) l()
  }, 60_000)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      clearInterval(timer)
      timer = undefined
    }
  }
}

const short = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
const long = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" })
const full = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

export function relative(iso: string, now = clockNow()) {
  const date = new Date(iso)
  const s = Math.max(0, (now - date.getTime()) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`
  return `on ${(date.getFullYear() === new Date(now).getFullYear() ? short : long).format(date)}`
}

export const Time = memo(function Time({ iso }: { iso: string }) {
  const now = useSyncExternalStore(subscribe, () => minute)
  // A freshly mounted time should not lag the shared minute tick.
  const [mountedAt] = useState(clockNow)
  const title = useMemo(() => full.format(new Date(iso)), [iso])
  return (
    <time className="time" dateTime={iso} title={title}>
      {relative(iso, Math.max(now, mountedAt))}
    </time>
  )
})

/** Re-renders when `iso` passes, e.g. to hide an expired activity. Returns whether it is still in the future. */
export function useUntil(iso: string | null | undefined) {
  const [, force] = useState(0)
  useEffect(() => {
    const ms = iso ? new Date(iso).getTime() - clockNow() : -1
    if (ms <= 0) return
    const t = setTimeout(() => force((n) => n + 1), Math.min(ms + 50, 2 ** 31 - 1))
    return () => clearTimeout(t)
  }, [iso])
  return iso ? new Date(iso).getTime() > clockNow() : false
}
