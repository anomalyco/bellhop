import { useEffect, useSyncExternalStore } from "react"
import type { Me } from "../../shared/api"
import { keys } from "./api"
import { peek, setData } from "./cache"

// Who this browser is, remembered locally so the "Posting as …" line renders on the first paint instead of
// arriving with /api/me and pushing the composer. The server stays the source of truth (it keeps the guest name
// per browser cookie); this is only a cache of its last answer, shared between tabs.

const storageKey = "bh_who"

/** The last known identity: a signed-in account, or a guest with their name (null until they choose one). */
export type Who = { user: true } | { user: false; name: string | null }

/** A guest's display name: 1–40 characters after trimming. */
export const validGuestName = (name: string) => name.trim().length >= 1 && name.trim().length <= 40

function read(): Who | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const v = JSON.parse(raw) as Who
    return v && typeof v.user === "boolean" ? v : null
  } catch {
    return null
  }
}

let current = read()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

function remember(who: Who) {
  if (current && JSON.stringify(current) === JSON.stringify(who)) return
  current = who
  try {
    localStorage.setItem(storageKey, JSON.stringify(who))
  } catch {
    // Storage disabled: the line simply waits for /api/me.
  }
  emit()
}

const whoOf = (me: Me): Who => (me.user ? { user: true } : { user: false, name: me.guest.name })

if (typeof window !== "undefined") {
  // Another tab renamed this guest (or signed in): follow it here too, in the cache and in /api/me's cached answer.
  window.addEventListener("storage", (e) => {
    if (e.key !== storageKey) return
    current = read()
    const who = current
    if (who && !who.user)
      setData<Me>(keys.me, (m) => (m && !m.user && m.guest.name !== who.name ? { ...m, guest: { ...m.guest, name: who.name } } : m))
    emit()
  })
}

/** Records the server's answer: call wherever /api/me lands or a guest's name changes. */
export function rememberMe(me: Me) {
  remember(whoOf(me))
}

/** Sets the guest's name in the cached /api/me and the local cache (after posting with guest_name or renaming). */
export function setGuestNameLocally(name: string | null) {
  setData<Me>(keys.me, (m) => (m && !m.user ? { ...m, guest: { ...m.guest, name } } : m))
  const me = peek<Me>(keys.me)
  if (me) rememberMe(me)
  else remember({ user: false, name })
}

/**
 * Who's posting, for the first paint: /api/me once it's known, the local cache before that, and `undefined` when
 * neither is known yet (a first visit), so callers can hold the line's space.
 */
export function useWho(me: Me | undefined): Who | undefined {
  const cached = useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
    () => null,
  )
  useEffect(() => {
    if (me) rememberMe(me)
  }, [me])
  return me ? whoOf(me) : (cached ?? undefined)
}
