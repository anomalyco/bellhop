// The transport under the SDK: JSON requests to the v1 API with typed errors, an automatic Idempotency-Key on every
// POST (the same key across retries of one call), and retries on 429 that honour Retry-After.

/** An error answered by the API ({ error: { code, message } }), or a network failure (status 0, code "network"). */
export class BellhopError extends Error {
  override readonly name = "BellhopError"
  constructor(
    /** HTTP status; 0 when the request never got an answer. */
    readonly status: number,
    /** Stable machine-readable code, e.g. "invalid_credential", "rate_limited", "contact_required". */
    readonly code: string,
    message: string,
    /** Seconds the API asked to wait (429), when it said. */
    readonly retryAfter: number | null = null,
  ) {
    super(message)
  }
}

export interface Transport {
  baseUrl: string
  fetch: typeof fetch
  /** Retries per call on 429 (and on network errors for safe requests). */
  retries: number
  /** The longest Retry-After the SDK sleeps through by itself; longer waits throw. */
  maxRetryWait: number
}

export interface Call {
  method: "GET" | "POST" | "PATCH" | "DELETE"
  path: string
  bearer: string
  body?: unknown
  query?: Record<string, string | undefined>
  headers?: Record<string, string>
  idempotencyKey?: string
  signal?: AbortSignal
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true })
  })

const randomKey = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join("-")

/** Seconds from a Retry-After header (delta seconds or an HTTP date). */
function retryAfter(value: string | null): number | null {
  if (!value) return null
  const n = Number(value)
  if (Number.isFinite(n)) return Math.max(0, n)
  const at = Date.parse(value)
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000))
}

/** Sends one call; returns the parsed JSON body and the response headers. */
export async function send<T>(t: Transport, call: Call): Promise<{ data: T; headers: Headers }> {
  const url = new URL(t.baseUrl.replace(/\/$/, "") + call.path)
  for (const [k, v] of Object.entries(call.query ?? {})) if (v !== undefined) url.searchParams.set(k, v)
  const headers: Record<string, string> = { Authorization: `Bearer ${call.bearer}`, Accept: "application/json", ...call.headers }
  const form = typeof FormData !== "undefined" && call.body instanceof FormData
  if (call.body !== undefined && !form) headers["Content-Type"] = "application/json"
  if (call.method === "POST") headers["Idempotency-Key"] = call.idempotencyKey ?? randomKey()
  const safe = call.method === "GET" || call.method === "POST" // POSTs carry an Idempotency-Key, so a retry is safe
  for (let attempt = 0; ; attempt++) {
    let res: Response
    try {
      res = await t.fetch(url, {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : form ? (call.body as FormData) : JSON.stringify(call.body),
        signal: call.signal,
        credentials: "omit",
      })
    } catch (e) {
      if (call.signal?.aborted) throw e
      if (safe && attempt < t.retries) {
        await sleep(500 * 2 ** attempt, call.signal)
        continue
      }
      throw new BellhopError(0, "network", e instanceof Error ? e.message : "Network error")
    }
    if (res.ok) return { data: (res.status === 204 ? null : await res.json()) as T, headers: res.headers }
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    const wait = retryAfter(res.headers.get("Retry-After"))
    if (res.status === 429 && attempt < t.retries && (wait ?? 1) <= t.maxRetryWait) {
      await sleep((wait ?? 2 ** attempt) * 1000, call.signal)
      continue
    }
    throw new BellhopError(res.status, body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? res.statusText, wait)
  }
}
