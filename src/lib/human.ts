import type { Config, Me } from "../../shared/api"
import { load, peek, setData } from "./cache"

// Turnstile, rendered on demand. Guests must pass it before their first write; the Worker answers 428
// once the bh_human cookie expires, and the API client calls runHumanCheck() and retries once.

interface Turnstile {
  render(el: HTMLElement, options: Record<string, unknown>): string
  remove(id: string): void
}
declare global {
  interface Window {
    turnstile?: Turnstile
  }
}

let script: Promise<Turnstile> | null = null
let running: Promise<void> | null = null

function loadScript(): Promise<Turnstile> {
  script ??= new Promise<Turnstile>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile)
    const el = document.createElement("script")
    el.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    el.async = true
    el.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile didn't load.")))
    el.onerror = () => {
      script = null
      reject(new Error("Couldn't load the human check. Check your connection and try again."))
    }
    document.head.appendChild(el)
  })
  return script
}

async function siteKey() {
  const config = await load<Config>("config", async () => {
    const res = await fetch("/api/config")
    return (await res.json()) as Config
  })
  return config.turnstile_site_key
}

async function check() {
  const [turnstile, sitekey] = await Promise.all([loadScript(), siteKey()])
  const panel = document.createElement("div")
  panel.className = "human-check"
  panel.setAttribute("role", "dialog")
  panel.setAttribute("aria-label", "Human check")
  const text = document.createElement("div")
  text.textContent = "Confirm you're human to continue"
  const slot = document.createElement("div")
  panel.append(text, slot)
  document.body.appendChild(panel)

  let widget: string | undefined
  try {
    const token = await new Promise<string>((resolve, reject) => {
      widget = turnstile.render(slot, {
        sitekey,
        appearance: "interaction-only",
        theme: "dark",
        callback: resolve,
        "error-callback": () => reject(new Error("The human check failed. Try again.")),
        "expired-callback": () => reject(new Error("The human check expired. Try again.")),
        "before-interactive-callback": () => panel.setAttribute("data-visible", ""),
      })
    })
    const res = await fetch("/api/human", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) throw new Error("The human check failed. Try again.")
    setData<Me>("me", (me) => (me ? { ...me, human: true } : me))
  } finally {
    if (widget) turnstile.remove(widget)
    panel.remove()
  }
}

/** Runs Turnstile now (after a 428, or before a write when me.human is false). Concurrent callers share one run. */
export function runHumanCheck(): Promise<void> {
  running ??= check().finally(() => {
    running = null
  })
  return running
}

/** Before a guest writes: passes straight through for members of the app or when the cookie is still valid. */
export async function ensureHuman(member: boolean) {
  if (member) return
  const me = peek<Me>("me")
  if (me?.human) return
  await runHumanCheck()
}
