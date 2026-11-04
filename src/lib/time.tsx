import { memo, useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { getLocale, useLocale } from "../i18n"
import { t } from "../i18n/core"

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

// Formatters in the active language, made once per language
const formats = new Map<string, { short: Intl.DateTimeFormat; long: Intl.DateTimeFormat; full: Intl.DateTimeFormat; rel: Intl.RelativeTimeFormat }>()
function formatsFor(locale: string) {
  let f = formats.get(locale)
  if (!f) {
    f = {
      short: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }),
      long: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", year: "numeric" }),
      full: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
      // English reads "5m ago"; other languages use their short forms ("vor 5 Min.", "5分前")
      rel: new Intl.RelativeTimeFormat(locale, { style: locale === "en" ? "narrow" : "short", numeric: "always" }),
    }
    formats.set(locale, f)
  }
  return f
}

/** A date and time in full, in the active language ("Nov 4, 2026, 3:12 PM"). */
export const fullDate = (iso: string) => formatsFor(getLocale()).full.format(new Date(iso))

export function relative(iso: string, now = clockNow()) {
  const date = new Date(iso)
  const f = formatsFor(getLocale())
  const s = Math.max(0, (now - date.getTime()) / 1000)
  if (s < 45) return t("time.justNow")
  if (s < 3600) return f.rel.format(-Math.max(1, Math.round(s / 60)), "minute")
  if (s < 86400) return f.rel.format(-Math.round(s / 3600), "hour")
  if (s < 86400 * 30) return f.rel.format(-Math.round(s / 86400), "day")
  return t("time.onDate", { date: (date.getFullYear() === new Date(now).getFullYear() ? f.short : f.long).format(date) })
}

export const Time = memo(function Time({ iso }: { iso: string }) {
  const now = useSyncExternalStore(subscribe, () => minute)
  const locale = useLocale()
  // A freshly mounted time should not lag the shared minute tick.
  const [mountedAt] = useState(clockNow)
  const title = useMemo(() => formatsFor(locale).full.format(new Date(iso)), [iso, locale])
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
