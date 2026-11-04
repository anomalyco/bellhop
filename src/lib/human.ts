import type { Config, Me } from "../../shared/api"
import { load, peek, setData } from "./cache"
import { t } from "../i18n/core"

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
/** Stops a check that renders inside a host the caller owns (the name prompt), when that host goes away. */
let cancelHosted: (() => void) | null = null

function loadScript(): Promise<Turnstile> {
  script ??= new Promise<Turnstile>((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile)
    const el = document.createElement("script")
    el.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
    el.async = true
    el.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile didn't load.")))
    el.onerror = () => {
      script = null
      reject(new Error(t("human.loadFailed")))
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

/**
 * Turnstile runs invisibly and only shows itself when it needs a click. By default that happens in a small panel of
 * its own; with `host` (an element inside the caller's own prompt) it shows there instead, so a guest sees one
 * prompt, not two. `host` gets data-visible while the widget needs them.
 */
async function check(host?: HTMLElement) {
  const [turnstile, sitekey] = await Promise.all([loadScript(), siteKey()])
  // The prompt closed while the script loaded: don't render into an element that's gone (it would never answer).
  if (host && !host.isConnected) throw new Error("cancelled")
  let panel: HTMLElement
  let slot: HTMLElement
  if (host) {
    panel = host
    slot = document.createElement("div")
    host.appendChild(slot)
  } else {
    panel = document.createElement("div")
    panel.className = "human-check"
    panel.setAttribute("role", "dialog")
    panel.setAttribute("aria-label", t("human.title"))
    const text = document.createElement("div")
    text.textContent = t("human.prompt")
    slot = document.createElement("div")
    panel.append(text, slot)
    document.body.appendChild(panel)
  }

  let widget: string | undefined
  try {
    const token = await new Promise<string>((resolve, reject) => {
      if (host) cancelHosted = () => reject(new Error("cancelled"))
      widget = turnstile.render(slot, {
        sitekey,
        appearance: "interaction-only",
        theme: "dark",
        callback: resolve,
        "error-callback": () => reject(new Error(t("human.failed"))),
        "expired-callback": () => reject(new Error(t("human.expired"))),
        "before-interactive-callback": () => panel.setAttribute("data-visible", ""),
      })
    })
    const res = await fetch("/api/human", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
    if (!res.ok) throw new Error(t("human.failed"))
    setData<Me>("me", (me) => (me ? { ...me, human: true } : me))
  } finally {
    cancelHosted = null
    if (widget) turnstile.remove(widget)
    if (host) {
      slot.remove()
      host.removeAttribute("data-visible")
    } else panel.remove()
  }
}

/**
 * Runs Turnstile now (after a 428, or before a write when me.human is false). Concurrent callers share one run;
 * `host` only applies when this call starts it.
 */
export function runHumanCheck(host?: HTMLElement): Promise<void> {
  running ??= check(host).finally(() => {
    running = null
  })
  return running
}

/** The name prompt closed: drop a check still waiting inside it, so a later write can start a fresh one. */
export function cancelHostedCheck() {
  cancelHosted?.()
}

/** Before a guest writes: passes straight through for members of the app or when the cookie is still valid. */
export async function ensureHuman(member: boolean) {
  if (member) return
  const me = peek<Me>("me")
  // Signed-in help desk contacts write without the check, like accounts
  if (me?.human || me?.contact) return
  await runHumanCheck()
}
