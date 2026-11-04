import { useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import type { AppDetail, Attachment, CloseReason, Issue, IssueStatus } from "../../../shared/api"
import { Editor } from "../../ui/Editor"
import { ChevronDownIcon, KebabIcon } from "../../ui/icons"
import { Menu, MenuItem } from "../../ui/Menu"
import { Button, StateIcon } from "../../ui/primitives"
import { statusOptions } from "./Sidebar"

const closeOptions: { reason: CloseReason; label: string; description: string }[] = [
  { reason: "completed", label: "Close as completed", description: "Done, closed, fixed, resolved" },
  { reason: "not_planned", label: "Close as not planned", description: "Won't fix, can't reproduce, stale" },
  { reason: "duplicate", label: "Close as duplicate", description: "Duplicate of another issue" },
]

const sendKey = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘↵" : "Ctrl ↵"

/**
 * Pins the composer to the bottom of the viewport. The in-flow slot keeps the composer's height (so the thread's
 * end is never hidden) and lends it the column's left edge and width; on iOS the keyboard offset comes from visualViewport.
 */
function useDock() {
  const slot = useRef<HTMLDivElement>(null)
  const dock = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ left: number; width: number; height: number; keyboard: number }>({ left: 0, width: 0, height: 0, keyboard: 0 })

  useLayoutEffect(() => {
    const s = slot.current
    const d = dock.current
    if (!s || !d) return
    const vv = window.visualViewport
    const measure = () => {
      const r = s.getBoundingClientRect()
      const keyboard = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0
      setBox((b) => {
        const next = { left: Math.round(r.left), width: Math.round(r.width), height: Math.ceil(d.offsetHeight), keyboard }
        return next.left === b.left && next.width === b.width && next.height === b.height && next.keyboard === b.keyboard ? b : next
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(s)
    observer.observe(d)
    observer.observe(document.documentElement)
    window.addEventListener("resize", measure)
    vv?.addEventListener("resize", measure)
    vv?.addEventListener("scroll", measure)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", measure)
      vv?.removeEventListener("resize", measure)
      vv?.removeEventListener("scroll", measure)
    }
  }, [])

  // The height is shared as --composer-h so layouts can reserve it elsewhere (the stacked sidebar on narrow screens).
  useLayoutEffect(() => {
    const root = document.documentElement.style
    root.setProperty("--composer-h", `${box.height}px`)
    return () => {
      root.removeProperty("--composer-h")
    }
  }, [box.height])

  const dockStyle: CSSProperties = box.width ? { left: box.left, width: box.width, bottom: box.keyboard } : { visibility: "hidden" }
  return { slot, dock, dockStyle }
}

/**
 * The reply box pinned to the bottom of the viewport. "split": close/reopen as a split button beside Send. "menu": a small menu beside
 * Send with the status changes and the close options (the chat layout).
 */
export function Composer({
  app,
  issue,
  onComment,
  onStatus,
  onDuplicate,
  variant = "split",
  placeholder,
}: {
  app: AppDetail
  issue: Issue
  onComment: (body: string, attachmentIds: string[]) => Promise<boolean>
  onStatus: (status: IssueStatus, reason?: CloseReason) => Promise<void>
  onDuplicate: (other: number) => Promise<void>
  variant?: "split" | "menu"
  placeholder?: string
}) {
  const member = !!app.role
  const { slot, dock, dockStyle } = useDock()
  const [body, setBody] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState<CloseReason>("completed")
  const [dupOf, setDupOf] = useState("")
  const [dupError, setDupError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const hasText = !!body.trim()

  const comment = async () => {
    if (!hasText || busy) return true
    const text = body
    const ids = attachments.filter((a) => text.includes(a.url)).map((a) => a.id)
    setBody("")
    setAttachments([])
    return onComment(text, ids)
  }

  const close = async (why: CloseReason = reason) => {
    setDupError(null)
    if (why === "duplicate") {
      const n = Number(dupOf.replace(/^#/, ""))
      if (!Number.isInteger(n) || n < 1) return setDupError("Enter the issue this duplicates.")
      setWorking(true)
      try {
        if (!(await comment())) return
        await onDuplicate(n)
        setDupOf("")
        setReason("completed")
      } catch (e) {
        setDupError(e instanceof Error ? e.message : "Couldn't close as duplicate.")
      } finally {
        setWorking(false)
      }
      return
    }
    if (!(await comment())) return
    onStatus("closed", why).catch(() => {})
  }

  const reopen = async () => {
    if (!(await comment())) return
    onStatus("open").catch(() => {})
  }

  const option = closeOptions.find((o) => o.reason === reason)!
  const closeLabel = reason === "completed" ? (hasText ? "Close with comment" : "Close issue") : option.label
  const reopenLabel = hasText ? "Reopen with comment" : "Reopen issue"
  const duplicating = member && reason === "duplicate" && issue.status !== "closed"

  const splitControl = !member ? null : issue.status === "closed" ? (
    <Button icon={<StateIcon state="open" size={14} />} onClick={reopen} disabled={busy} aria-label={reopenLabel} title={reopenLabel}>
      <span className="close-label">{reopenLabel}</span>
    </Button>
  ) : (
    <span className="split">
      <Button
        icon={<StateIcon state={reason === "completed" ? "closed" : "not_planned"} size={14} />}
        onClick={() => void close()}
        disabled={busy || working}
        aria-label={closeLabel}
        title={hasText ? `${closeLabel} (posts your reply first)` : closeLabel}
      >
        <span className="close-label">{closeLabel}</span>
      </Button>
      <Menu align="end" width={300} trigger={(p) => <Button iconOnly aria-label="More close options" icon={<ChevronDownIcon size={14} />} {...p} />}>
        {(dismiss) =>
          closeOptions.map((o) => (
            <MenuItem
              key={o.reason}
              checked={reason === o.reason}
              description={o.description}
              onSelect={() => {
                setReason(o.reason)
                setDupError(null)
                dismiss()
              }}
            >
              {o.label}
            </MenuItem>
          ))
        }
      </Menu>
    </span>
  )

  const after = hasText ? " (posts your reply first)" : ""
  const menuControl = !member ? null : (
    <Menu
      align="end"
      width={280}
      trigger={(p) => <Button iconOnly variant="invisible" aria-label="Status and close options" title="Status and close options" icon={<KebabIcon />} {...p} />}
    >
      {(dismiss) =>
        issue.status === "closed" ? (
          <MenuItem
            description={hasText ? "Posts your reply first" : undefined}
            onSelect={() => {
              dismiss()
              void reopen()
            }}
          >
            <StateIcon state="open" size={14} />
            {reopenLabel}
          </MenuItem>
        ) : (
          <>
            {statusOptions
              .filter((o) => o.status !== issue.status)
              .map((o) => (
                <MenuItem
                  key={o.status}
                  onSelect={() => {
                    dismiss()
                    onStatus(o.status).catch(() => {})
                  }}
                >
                  <StateIcon state={o.status} size={14} />
                  Mark as {o.label.toLowerCase()}
                </MenuItem>
              ))}
            <div className="menu-sep" role="separator" />
            {closeOptions.map((o) => (
              <MenuItem
                key={o.reason}
                description={o.reason === "duplicate" ? "Asks which issue" : o.description + after}
                onSelect={() => {
                  dismiss()
                  setDupError(null)
                  if (o.reason === "duplicate") setReason("duplicate")
                  else void close(o.reason)
                }}
              >
                <StateIcon state={o.reason === "completed" ? "closed" : "not_planned"} size={14} />
                {o.label}
              </MenuItem>
            ))}
          </>
        )
      }
    </Menu>
  )

  return (
    <div className="composer-slot" ref={slot}>
      <div className="composer" ref={dock} data-variant={variant} style={dockStyle}>
        <Editor
          variant="chat"
          slug={app.slug}
          value={body}
          onChange={setBody}
          member={member}
          onAttachment={(a) => setAttachments((l) => [...l, a])}
          onBusyChange={setBusy}
          onSubmit={() => void comment()}
          label="Reply"
          placeholder={placeholder}
          minHeight={40}
          extra={
            duplicating && (
              <div className="dup-form">
                <label className="field-label" htmlFor="dup-of">
                  Duplicate of
                </label>
                <div className="input" data-size="small">
                  <span className="input-prefix mono">#</span>
                  <input id="dup-of" className="mono" inputMode="numeric" value={dupOf} onChange={(e) => setDupOf(e.target.value)} placeholder="123" autoFocus />
                </div>
                {variant === "menu" && (
                  <>
                    <Button size="small" onClick={() => void close("duplicate")} disabled={busy || working}>
                      Close as duplicate
                    </Button>
                    <Button size="small" variant="invisible" onClick={() => setReason("completed")}>
                      Cancel
                    </Button>
                  </>
                )}
                {dupError && <span className="field-error">{dupError}</span>}
              </div>
            )
          }
          actions={
            <>
              {variant === "menu" ? menuControl : splitControl}
              <Button variant="primary" onClick={() => void comment()} disabled={!hasText || busy} trailing={<kbd className="kbd">{sendKey}</kbd>}>
                {busy ? "Uploading…" : "Send"}
              </Button>
            </>
          }
        />
      </div>
    </div>
  )
}
