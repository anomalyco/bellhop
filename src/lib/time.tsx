import { useEffect, useState, useSyncExternalStore } from "react"

// One shared minute ticker re-renders every relative time on the page.
let minute = Date.now()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined

function subscribe(listener: () => void) {
  listeners.add(listener)
  timer ??= setInterval(() => {
    minute = Date.now()
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

export function relative(iso: string, now = Date.now()) {
  const date = new Date(iso)
  const s = Math.max(0, (now - date.getTime()) / 1000)
  if (s < 45) return "just now"
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`
  return `on ${(date.getFullYear() === new Date(now).getFullYear() ? short : long).format(date)}`
}

export function Time({ iso }: { iso: string }) {
  const now = useSyncExternalStore(subscribe, () => minute)
  // A freshly mounted time should not lag the shared minute tick.
  const [mountedAt] = useState(Date.now)
  return (
    <time className="mono time" dateTime={iso} title={full.format(new Date(iso))}>
      {relative(iso, Math.max(now, mountedAt))}
    </time>
  )
}

/** Re-renders when `iso` passes, e.g. to hide an expired activity. Returns whether it is still in the future. */
export function useUntil(iso: string | null | undefined) {
  const [, force] = useState(0)
  useEffect(() => {
    const ms = iso ? new Date(iso).getTime() - Date.now() : -1
    if (ms <= 0) return
    const t = setTimeout(() => force((n) => n + 1), Math.min(ms + 50, 2 ** 31 - 1))
    return () => clearTimeout(t)
  }, [iso])
  return iso ? new Date(iso).getTime() > Date.now() : false
}
