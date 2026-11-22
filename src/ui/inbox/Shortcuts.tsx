import { useEffect, useRef } from "react"
import { createPortal } from "react-dom"
import { useT } from "../../i18n/inbox"
import { XIcon } from "../icons"
import "../../styles/inbox.css"

/** The inbox's keyboard shortcuts, as a small dialog (?, Esc closes). */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    ref.current?.focus()
    return () => back?.focus?.()
  }, [])
  const rows: [string[], string][] = [
    [["j", "k"], t("keys.move")],
    [["Enter", "o"], t("keys.open")],
    [["Esc"], t("keys.back")],
    [["e"], t("keys.close")],
    [["l"], t("keys.labels")],
    [["a"], t("keys.assign")],
    [["r"], t("keys.reply")],
    [["n"], t("keys.note")],
    [["/"], t("keys.search")],
    [["⌘", "Enter"], t("keys.send")],
    [["?"], t("keys.help")],
  ]
  return createPortal(
    <div className="inbox-keys-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className="inbox-keys"
        role="dialog"
        aria-modal="true"
        aria-labelledby="inbox-keys-title"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "?") {
            e.preventDefault()
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <div className="inbox-keys-head">
          <h2 id="inbox-keys-title">{t("keys.title")}</h2>
          <button type="button" className="btn" data-variant="ghost-muted" data-size="small" data-icon-only="" onClick={onClose} aria-label={t("keys.done")}>
            <XIcon size={14} />
          </button>
        </div>
        <dl className="inbox-keys-list">
          {rows.map(([keys, label]) => (
            <div key={label} className="inbox-keys-row">
              <dt>
                {keys.map((k) => (
                  <kbd key={k}>{k}</kbd>
                ))}
              </dt>
              <dd>{label}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>,
    document.body,
  )
}
