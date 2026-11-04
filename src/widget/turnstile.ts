// Cloudflare Turnstile, needed for anonymous sessions and email codes. Loaded only when one of those starts, and
// rendered into a slot inside the widget (invisible unless Turnstile needs the person to interact).
type Turnstile = {
  render(el: HTMLElement, options: Record<string, unknown>): string
  remove(id: string): void
}
let script: Promise<Turnstile> | null = null

function load(): Promise<Turnstile> {
  const w = window as unknown as { turnstile?: Turnstile }
  if (w.turnstile) return Promise.resolve(w.turnstile)
  script ??= new Promise<Turnstile>((resolve, reject) => {
    const s = document.createElement("script")
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    s.async = true
    s.onload = () => (w.turnstile ? resolve(w.turnstile) : reject(new Error("Turnstile unavailable")))
    s.onerror = () => {
      script = null
      reject(new Error("Turnstile unavailable"))
    }
    document.head.append(s)
  })
  return script
}

/** A one-time Turnstile token. `slot` is where the challenge shows if it needs a click. */
export async function turnstileToken(siteKey: string | undefined, slot: HTMLElement | null): Promise<string> {
  if (!siteKey) throw Object.assign(new Error("Human check unavailable"), { code: "unavailable" })
  const t = await load()
  const host = slot ?? document.body
  const el = document.createElement("div")
  host.append(el)
  return new Promise<string>((resolve, reject) => {
    let id = ""
    const done = (fn: () => void) => {
      fn()
      setTimeout(() => {
        try {
          t.remove(id)
        } catch {
          /* already gone */
        }
        el.remove()
      })
    }
    id = t.render(el, {
      sitekey: siteKey,
      appearance: "interaction-only",
      size: "flexible",
      callback: (token: string) => done(() => resolve(token)),
      "error-callback": () => done(() => reject(Object.assign(new Error("Human check failed"), { code: "unavailable" }))),
      "expired-callback": () => done(() => reject(Object.assign(new Error("Human check expired"), { code: "unavailable" }))),
    })
  })
}
