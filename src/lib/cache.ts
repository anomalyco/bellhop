import { useCallback, useEffect, useSyncExternalStore } from "react"

// A tiny stale-while-revalidate store. Every resource lives under a string key; pages read it with
// useResource, paint whatever is cached at once and refresh in the background.

interface Entry {
  data?: unknown
  error?: unknown
  promise?: Promise<unknown>
  /** When data last arrived from the server. */
  at: number
  listeners: Set<() => void>
  snapshot: Snapshot<unknown>
}

export interface Snapshot<T> {
  data: T | undefined
  error: unknown
  loading: boolean
}

const store = new Map<string, Entry>()
const empty: Snapshot<never> = { data: undefined, error: undefined, loading: false }

function entry(key: string): Entry {
  let e = store.get(key)
  if (!e) {
    e = { at: 0, listeners: new Set(), snapshot: empty }
    store.set(key, e)
  }
  return e
}

function emit(e: Entry) {
  e.snapshot = { data: e.data, error: e.error, loading: !!e.promise && e.data === undefined }
  for (const l of e.listeners) l()
}

export function peek<T>(key: string): T | undefined {
  return store.get(key)?.data as T | undefined
}

/** Fetches `key`, sharing an in-flight request. Resolves with fresh data. */
export function load<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const e = entry(key)
  if (e.promise) return e.promise as Promise<T>
  const promise = fetcher().then(
    (data) => {
      if (e.promise === promise) {
        const unchanged =
          e.data !== undefined && e.error === undefined && !e.snapshot.loading && JSON.stringify(data) === JSON.stringify(e.data)
        e.at = Date.now()
        e.promise = undefined
        if (!unchanged) {
          e.data = data
          e.error = undefined
          emit(e)
        }
      }
      return data
    },
    (error: unknown) => {
      if (e.promise === promise) {
        e.error = error
        e.promise = undefined
        emit(e)
      }
      throw error
    },
  )
  e.promise = promise
  if (e.data === undefined) emit(e)
  return promise
}

/** Warms the cache (row hover) unless the entry is fresh or already loading. */
export function prefetch<T>(key: string, fetcher: () => Promise<T>, maxAge = 15_000) {
  const e = store.get(key)
  if (e && (e.promise || Date.now() - e.at < maxAge)) return
  load(key, fetcher).catch(() => {})
}

/** Writes a new value (optimistic updates, live events). Returning undefined leaves the entry alone. */
export function setData<T>(key: string, update: T | ((prev: T | undefined) => T | undefined)) {
  const e = entry(key)
  const next = typeof update === "function" ? (update as (p: T | undefined) => T | undefined)(e.data as T | undefined) : update
  if (next === undefined || next === e.data) return
  e.data = next
  e.error = undefined
  emit(e)
}

/** Applies `update` to every cached entry whose key starts with `prefix`. */
export function updateAll<T>(prefix: string, update: (prev: T, key: string) => T | undefined) {
  for (const [key, e] of store) {
    if (!key.startsWith(prefix) || e.data === undefined) continue
    const next = update(e.data as T, key)
    if (next !== undefined && next !== e.data) {
      e.data = next
      emit(e)
    }
  }
}

export function entries<T>(prefix: string): [string, T][] {
  const out: [string, T][] = []
  for (const [key, e] of store) if (key.startsWith(prefix) && e.data !== undefined) out.push([key, e.data as T])
  return out
}

export function invalidate(prefix: string) {
  for (const [key, e] of store) if (key.startsWith(prefix)) e.at = 0
}

export function useResource<T>(key: string | null, fetcher: () => Promise<T>, maxAge = 2_000) {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!key) return () => {}
      const e = entry(key)
      e.listeners.add(listener)
      return () => e.listeners.delete(listener)
    },
    [key],
  )
  const snapshot = useSyncExternalStore(subscribe, () => (key ? entry(key).snapshot : empty)) as Snapshot<T>

  useEffect(() => {
    if (!key) return
    const e = entry(key)
    if (!e.promise && Date.now() - e.at > maxAge) load(key, fetcher).catch(() => {})
    // The fetcher is derived from the key, so the key alone decides when to refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const reload = useCallback(() => (key ? load(key, fetcher) : Promise.resolve(undefined as T)), [key, fetcher])
  return { ...snapshot, reload }
}
