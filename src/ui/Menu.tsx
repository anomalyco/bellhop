import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { reduced, SPRING_25 } from "../lib/motion"

/** Phones get a bottom sheet instead of an anchored popover. */
const sheetQuery = "(max-width: 640px)"
const margin = 8
const gap = 4

/**
 * An anchored overlay rendered into document.body, so no scrolling or clipped ancestor can cut it off. It opens
 * below its trigger (above when there's more room there), stays inside the viewport, and closes on an outside
 * click, Escape, scroll or resize. Arrow keys move between items. It appears on the next frame and fades only when
 * it closes (a phone sheet slides up and drops back down); reopening mid-fade picks it straight back up.
 */
export function Menu({
  trigger,
  children,
  align = "start",
  width = 280,
  onOpenChange,
}: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "menu" }) => ReactNode
  children: (close: () => void) => ReactNode
  align?: "start" | "end"
  width?: number
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  // On screen: from opening until its close fade has finished
  const [mounted, setMounted] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" })
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const side = useRef<"below" | "above" | null>(null)
  const changed = useRef(onOpenChange)
  changed.current = onOpenChange

  const set = (next: boolean) => {
    setOpen(next)
    if (next) setMounted(true)
    changed.current?.(next)
  }

  const close = (refocus = false) => {
    set(false)
    if (refocus) root.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus({ preventScroll: true })
  }

  const place = () => {
    const anchor = root.current?.getBoundingClientRect()
    const el = panel.current
    if (!anchor || !el) return
    if (window.matchMedia(sheetQuery).matches) {
      setSheet(true)
      setStyle({})
      return
    }
    setSheet(false)
    const vw = document.documentElement.clientWidth
    const vh = window.innerHeight
    const w = Math.min(width, vw - margin * 2)
    const left = Math.max(margin, Math.min(align === "end" ? anchor.right - w : anchor.left, vw - margin - w))
    const below = vh - anchor.bottom - gap - margin
    const above = anchor.top - gap - margin
    side.current ??= el.scrollHeight <= below || below >= above ? "below" : "above"
    setStyle(
      side.current === "below"
        ? { left, width: w, top: anchor.bottom + gap, maxHeight: below }
        : { left, width: w, bottom: vh - anchor.top + gap, maxHeight: above },
    )
  }

  useLayoutEffect(() => {
    if (!open) return
    place()
    const el = panel.current
    const observer = new ResizeObserver(() => place())
    if (el) observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const inside = (node: EventTarget | null) =>
      node instanceof Node && (!!root.current?.contains(node) || !!panel.current?.contains(node))
    const onDown = (e: PointerEvent) => {
      if (!inside(e.target)) close()
    }
    const onScroll = (e: Event) => {
      // The sheet doesn't move with the page, and focusing its filter can scroll the page on phones.
      if (!window.matchMedia(sheetQuery).matches && !inside(e.target)) close()
    }
    const onResize = () => {
      if (!window.matchMedia(sheetQuery).matches || !sheet) close()
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        close(true)
      }
    }
    document.addEventListener("pointerdown", onDown, true)
    window.addEventListener("scroll", onScroll, true)
    window.addEventListener("resize", onResize)
    document.addEventListener("keydown", onKey)
    // After the panel has been placed and shown; a hidden element can't take focus.
    const frame = requestAnimationFrame(() =>
      panel.current?.querySelector<HTMLElement>("input, [role^=menuitem]")?.focus({ preventScroll: true }),
    )
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("scroll", onScroll, true)
      window.removeEventListener("resize", onResize)
      document.removeEventListener("keydown", onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sheet])

  // After closing: the panel stays (inert) until its fade (or the sheet's drop) ends, then goes
  useEffect(() => {
    if (open || !mounted) return
    const el = panel.current
    const done = () => {
      setMounted(false)
      side.current = null
      setStyle({ visibility: "hidden" })
    }
    const onEnd = (e: TransitionEvent) => e.target === el && done()
    el?.addEventListener("transitionend", onEnd)
    // In case no transition runs (the first frames of a page, where motion is off)
    const t = window.setTimeout(done, (reduced() ? 150 : sheet ? 200 : SPRING_25) + 400)
    return () => {
      el?.removeEventListener("transitionend", onEnd)
      window.clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mounted])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
    const items = [...(panel.current?.querySelectorAll<HTMLElement>("[role^=menuitem]:not([disabled])") ?? [])]
    if (!items.length) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div className="menu-root" ref={root} onKeyDown={onKeyDown}>
      {trigger({ onClick: () => set(!open), "aria-expanded": open, "aria-haspopup": "menu" })}
      {mounted &&
        createPortal(
          <>
            {sheet && <div className="menu-scrim" aria-hidden="true" data-closing={!open || undefined} />}
            <div
              className="menu"
              role="menu"
              ref={panel}
              data-sheet={sheet || undefined}
              data-closing={!open || undefined}
              inert={!open || undefined}
              style={sheet ? undefined : { width, ...style }}
            >
              {children(() => close())}
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}

export function MenuItem({
  children,
  onSelect,
  checked,
  description,
  danger,
  disabled,
}: {
  children: ReactNode
  onSelect: () => void
  checked?: boolean
  description?: ReactNode
  danger?: boolean
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="menu-item"
      role={checked === undefined ? "menuitem" : "menuitemcheckbox"}
      aria-checked={checked}
      data-danger={danger || undefined}
      disabled={disabled}
      onClick={onSelect}
    >
      {checked !== undefined && (
        <span className="menu-check" aria-hidden="true">
          {checked && (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="m3.75 8.25 2.75 2.75 5.75-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
      )}
      <span className="menu-item-main">
        <span className="menu-item-text">{children}</span>
        {description && <span className="menu-item-description">{description}</span>}
      </span>
    </button>
  )
}

export function MenuHeader({ children }: { children: ReactNode }) {
  return <div className="menu-header">{children}</div>
}
