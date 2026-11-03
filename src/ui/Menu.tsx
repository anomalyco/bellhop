import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"

/** A small anchored overlay: click outside or Escape closes it, arrow keys move between items. */
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
  const root = useRef<HTMLDivElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  const set = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) set(false)
    }
    document.addEventListener("pointerdown", onDown)
    const first = panel.current?.querySelector<HTMLElement>("input, [role^=menuitem]")
    first?.focus()
    return () => document.removeEventListener("pointerdown", onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation()
      set(false)
      root.current?.querySelector<HTMLElement>("[aria-haspopup]")?.focus()
      return
    }
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
      {open && (
        <div className="menu" role="menu" ref={panel} data-align={align} style={{ width }}>
          {children(() => set(false))}
        </div>
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
