import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { Me } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { peek, setData } from "../lib/cache"
import { rememberMe, validGuestName } from "../lib/guest"
import { cancelHostedCheck, runHumanCheck } from "../lib/human"
import { reduced, SPRING_25 } from "../lib/motion"
import { signInHref } from "../lib/site"
import { Button } from "./primitives"
import { SiteLink } from "./SiteLink"

/** Phones get a bottom sheet; wider screens a popover growing out of the control that asked. */
const sheetQuery = "(max-width: 640px)"
const margin = 8
const gap = 8
const width = 332

export interface NameAsk {
  /** The control that asked (Send, Submit, Change name): the popover grows from it and focus returns to it. */
  anchor: HTMLElement | null
  /** "first": a nameless guest posting; the button continues the post with `action` ("Post", "Submit issue").
   *  "edit": Change name; the prompt saves the name itself (PUT /api/me/guest). */
  mode: "first" | "edit"
  action?: string
}

interface Open extends NameAsk {
  id: number
  resolve: (name: string | null) => void
}

let seq = 0

/**
 * "What should we call you?": asked once, when a guest without a name posts. Resolves with the name (the caller
 * sends it as guest_name with the post) or null when they cancel, which leaves their draft alone. The human check
 * runs inside the same prompt (invisibly, unless Turnstile needs a click), so a first-time poster sees one prompt.
 */
export function useNamePrompt() {
  const [open, setOpen] = useState<Open | null>(null)
  const ask = useCallback(
    (a: NameAsk) =>
      new Promise<string | null>((resolve) => {
        setOpen((prev) => {
          prev?.resolve(null)
          return { ...a, id: ++seq, resolve }
        })
      }),
    [],
  )
  // The answer goes back at once (the post starts on the same frame); the prompt unmounts after its fade.
  const remove = useCallback((id: number) => setOpen((prev) => (prev?.id === id ? null : prev)), [])
  const prompt = open ? <NamePrompt key={open.id} ask={open} onRemove={() => remove(open.id)} /> : null
  return { ask, prompt }
}

function NamePrompt({ ask, onRemove }: { ask: Open; onRemove: () => void }) {
  const me = peek<Me>(keys.me)
  const saved = me && !me.user ? me.guest.name : null
  const [sheet] = useState(() => window.matchMedia(sheetQuery).matches)
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" })
  const [name, setName] = useState(ask.mode === "edit" ? (saved ?? "") : "")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [closing, setClosing] = useState(false)
  const refocus = useRef(true)
  const panel = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const checkHost = useRef<HTMLDivElement>(null)
  const human = useRef<Promise<void> | null>(null)

  // Placement: above the trigger when it fits (Send and Submit sit low on the screen), else below; right edges
  // aligned, and the scale grows from the trigger's side. The sheet only follows the on-screen keyboard.
  const place = useCallback(() => {
    if (sheet) {
      const vv = window.visualViewport
      const keyboard = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0
      setStyle({ bottom: `max(${margin + keyboard}px, env(safe-area-inset-bottom))` })
      return
    }
    const el = panel.current
    const anchor = ask.anchor?.getBoundingClientRect()
    if (!el) return
    const vw = document.documentElement.clientWidth
    const vh = window.innerHeight
    const w = Math.min(width, vw - margin * 2)
    if (!anchor) {
      setStyle({ left: (vw - w) / 2, top: vh / 3, width: w })
      return
    }
    const h = el.offsetHeight
    const left = Math.max(margin, Math.min(anchor.right - w, vw - margin - w))
    const above = anchor.top - gap - margin >= h || anchor.top > vh - anchor.bottom
    const originX = Math.max(12, Math.min(w - 12, anchor.left + anchor.width / 2 - left))
    setStyle(
      above
        ? { left, width: w, bottom: vh - anchor.top + gap, transformOrigin: `${originX}px 100%` }
        : { left, width: w, top: anchor.bottom + gap, transformOrigin: `${originX}px 0` },
    )
  }, [ask.anchor, sheet])

  useLayoutEffect(() => {
    place()
    const observer = new ResizeObserver(place)
    if (panel.current) observer.observe(panel.current)
    const vv = window.visualViewport
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    vv?.addEventListener("resize", place)
    vv?.addEventListener("scroll", place)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
      vv?.removeEventListener("resize", place)
      vv?.removeEventListener("scroll", place)
    }
  }, [place])

  // Start the human check as the prompt opens, so it's usually finished by the time they've typed their name.
  const startCheck = () => {
    if (peek<Me>(keys.me)?.human) return Promise.resolve()
    human.current ??= runHumanCheck(checkHost.current ?? undefined).catch((e) => {
      human.current = null
      throw e
    })
    return human.current
  }
  useEffect(() => {
    startCheck().catch(() => {})
    return () => cancelHostedCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const close = useCallback(
    (value: string | null, returnFocus = true) => {
      if (closing) return
      refocus.current = returnFocus
      ask.resolve(value)
      setClosing(true)
    },
    [ask, closing],
  )
  // It grows from the trigger on open (motion.css); only the close fades. Focus goes back to the control that asked.
  useEffect(() => {
    if (!closing) return
    if (refocus.current) ask.anchor?.focus({ preventScroll: true })
    const t = window.setTimeout(onRemove, reduced() ? 150 : sheet ? 200 : SPRING_25)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && !panel.current?.contains(e.target) && !ask.anchor?.contains(e.target)) close(null, false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        close(null)
      }
    }
    document.addEventListener("pointerdown", onDown, true)
    document.addEventListener("keydown", onKey, true)
    const frame = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }))
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("pointerdown", onDown, true)
      document.removeEventListener("keydown", onKey, true)
    }
  }, [ask.anchor, close])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    const value = name.trim()
    if (!validGuestName(value)) {
      setError(value ? "Up to 40 characters." : "Add a name so people know who wrote it.")
      input.current?.focus()
      return
    }
    if (ask.mode === "edit" && value === saved) return close(null)
    setBusy(true)
    setError(null)
    try {
      await startCheck()
      if (ask.mode === "edit") {
        const m = await api.setGuestName(value)
        setData<Me>(keys.me, m)
        rememberMe(m)
      }
      close(value)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  const title = ask.mode === "edit" ? "Change your name" : "What should we call you?"
  const action = ask.mode === "edit" ? "Save" : (ask.action ?? "Post")
  return createPortal(
    <>
      {sheet && <div className="menu-scrim name-prompt-scrim" data-closing={closing || undefined} aria-hidden="true" />}
      <form
        ref={panel}
        className="name-prompt"
        role="dialog"
        aria-modal={sheet || undefined}
        aria-labelledby="name-prompt-title"
        data-sheet={sheet || undefined}
        data-closing={closing || undefined}
        style={style}
        onSubmit={submit}
        noValidate
      >
        <div className="name-prompt-head">
          <h2 id="name-prompt-title" className="name-prompt-title">
            {title}
          </h2>
          <p className="name-prompt-text">Shown next to what you post. This browser remembers it.</p>
        </div>
        <div className="input" data-size="large" data-invalid={error ? "" : undefined}>
          <input
            ref={input}
            aria-label="Your name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              if (error) setError(null)
            }}
            placeholder="Your name"
            autoComplete="name"
            enterKeyHint="send"
            maxLength={40}
            aria-invalid={!!error}
            aria-describedby={error ? "name-prompt-error" : undefined}
          />
        </div>
        {error && (
          <p id="name-prompt-error" className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="name-prompt-check" ref={checkHost} />
        <div className="name-prompt-foot">
          {ask.mode === "first" && (
            <SiteLink href={signInHref()} className="name-prompt-signin">
              Sign in instead
            </SiteLink>
          )}
          <span className="spacer" />
          <Button variant="invisible" onClick={() => close(null)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy && ask.mode === "edit" ? "Saving…" : action}
          </Button>
        </div>
      </form>
    </>,
    document.body,
  )
}

/** "Posting as Alex · Change name · Sign in" for guests (or "Posting as a guest" before they've chosen a name). */
export function GuestLine({ name, onChange, placeholder }: { name: string | null; onChange: (anchor: HTMLElement) => void; placeholder?: boolean }): ReactNode {
  return (
    <div className="guest-bar" aria-hidden={placeholder || undefined} data-placeholder={placeholder || undefined}>
      <span className="guest-bar-text">{name ? <>Posting as <strong>{name}</strong></> : "Posting as a guest"}</span>
      {name && (
        <>
          <span aria-hidden="true">·</span>
          <button type="button" className="guest-bar-link" onClick={(e) => onChange(e.currentTarget)} tabIndex={placeholder ? -1 : undefined}>
            Change name
          </button>
        </>
      )}
      <span aria-hidden="true">·</span>
      <SiteLink href={signInHref()} className="guest-bar-link" tabIndex={placeholder ? -1 : undefined}>
        Sign in
      </SiteLink>
    </div>
  )
}
