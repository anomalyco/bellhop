import { useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import type { Attachment, CloseReason } from "../../../shared/api"
import { useWho } from "../../lib/guest"
import { Editor } from "../../ui/Editor"
import { ChevronDownIcon, LockIcon } from "../../ui/icons"
import { Menu, MenuItem } from "../../ui/Menu"
import { GuestLine, useNamePrompt } from "../../ui/NamePrompt"
import { Button, StateIcon } from "../../ui/primitives"
import type { IssueModel } from "./model"

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
 * The reply box pinned to the bottom of the viewport, with close/reopen as a split button beside Send. Guests see
 * who they post as above it; a guest without a name is asked for one when they first post ("What should we call
 * you?"), in a prompt growing from the button they pressed, and the name goes along with that post.
 */
export function Composer({ model }: { model: IssueModel }) {
  const { app, issue, me, member, onStatus, onDuplicate } = model
  const guest = me && !me.user ? me.guest : null
  // Known on the first paint from the local cache; undefined on a first visit until /api/me answers, when the line
  // holds its space (invisibly) so the composer never grows under the reader.
  const who = useWho(me)
  const { ask, prompt } = useNamePrompt()
  const sendButton = useRef<HTMLButtonElement>(null)
  const { slot, dock, dockStyle } = useDock()
  const [body, setBody] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState<CloseReason>("completed")
  const [dupOf, setDupOf] = useState("")
  const [dupError, setDupError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  // The team writes either a reply (everyone sees it) or an internal note (the team and agents only). The choice
  // stays put between posts, and everything about the box says which one it is.
  const [internal, setInternal] = useState(false)
  const note = member && internal
  const hasText = !!body.trim()

  /** Posts the draft; `anchor` is the button pressed, where the name prompt grows from if one is needed. */
  const comment = async (anchor: HTMLElement | null = sendButton.current) => {
    if (!hasText || busy) return true
    let guestName: string | undefined
    if (guest && !guest.name) {
      const name = await ask({ anchor, mode: "first", action: "Post" })
      if (!name) return false
      guestName = name
    }
    const text = body
    const files = attachments
    const ids = files.filter((a) => text.includes(a.url)).map((a) => a.id)
    setBody("")
    setAttachments([])
    let result = await model.onComment(text, ids, guestName, note)
    if (result === "name_required") {
      // The server has no name for this browser after all (its cookie was cleared): ask, then send the same post.
      const name = await ask({ anchor, mode: "first", action: "Post" })
      if (!name) {
        setBody((b) => b || text)
        setAttachments((l) => (l.length ? l : files))
        return false
      }
      result = await model.onComment(text, ids, name, note)
    }
    return result === true
  }

  const close = async (why: CloseReason = reason, anchor?: HTMLElement) => {
    setDupError(null)
    if (why === "duplicate") {
      const n = Number(dupOf.replace(/^#/, ""))
      if (!Number.isInteger(n) || n < 1) return setDupError("Enter the issue this duplicates.")
      setWorking(true)
      try {
        if (!(await comment(anchor))) return
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
    if (!(await comment(anchor))) return
    onStatus("closed", why).catch(() => {})
  }

  const reopen = async (anchor?: HTMLElement) => {
    if (!(await comment(anchor))) return
    onStatus("open").catch(() => {})
  }

  const option = closeOptions.find((o) => o.reason === reason)!
  const closeLabel = reason === "completed" ? (hasText ? (note ? "Close with note" : "Close with comment") : "Close issue") : option.label
  const reopenLabel = hasText ? (note ? "Reopen with note" : "Reopen with comment") : "Reopen issue"
  const duplicating = member && reason === "duplicate" && issue.status !== "closed"

  // The team, and the reporter (completed or not planned; duplicates need the team).
  const options = member ? closeOptions : closeOptions.filter((o) => o.reason !== "duplicate")
  const splitControl = !member && !issue.viewer_is_author ? null : issue.status === "closed" ? (
    <Button icon={<StateIcon state="open" size={14} />} onClick={(e) => void reopen(e.currentTarget)} disabled={busy} aria-label={reopenLabel} title={reopenLabel}>
      <span className="close-label">{reopenLabel}</span>
    </Button>
  ) : (
    <span className="split">
      <Button
        icon={<StateIcon state={reason === "completed" ? "closed" : "not_planned"} size={14} />}
        onClick={(e) => void close(reason, e.currentTarget)}
        disabled={busy || working}
        aria-label={closeLabel}
        title={hasText ? `${closeLabel} (posts your reply first)` : closeLabel}
      >
        <span className="close-label">{closeLabel}</span>
      </Button>
      <Menu align="end" width={300} trigger={(p) => <Button iconOnly aria-label="More close options" icon={<ChevronDownIcon size={14} />} {...p} />}>
        {(dismiss) =>
          options.map((o) => (
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

  return (
    <div className="composer-slot" ref={slot}>
      <div className="composer" ref={dock} style={dockStyle} data-internal={note || undefined}>
        {member && (
          <div className="composer-mode">
            <div className="segmented composer-mode-switch" role="radiogroup" aria-label="Post as">
              <button type="button" role="radio" aria-checked={!note} aria-pressed={!note} onClick={() => setInternal(false)}>
                Reply
              </button>
              <button type="button" role="radio" aria-checked={note} aria-pressed={note} onClick={() => setInternal(true)}>
                <LockIcon size={12} />
                Internal note
              </button>
            </div>
            <span className="composer-mode-hint">{note ? "Only the team and agents see this" : "Everyone who can see the issue sees this"}</span>
          </div>
        )}
        {(who === undefined || !who.user) && (
          <GuestLine
            name={who && !who.user ? who.name : null}
            placeholder={who === undefined}
            onChange={(anchor) => void ask({ anchor, mode: "edit" })}
          />
        )}
        <Editor
          variant="chat"
          mentions={member}
          slug={app.slug}
          value={body}
          onChange={setBody}
          member={member}
          onAttachment={(a) => setAttachments((l) => [...l, a])}
          onBusyChange={setBusy}
          onSubmit={() => void comment()}
          label={note ? "Internal note" : "Reply"}
          placeholder={note ? "Add an internal note for the team…" : undefined}
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
                {dupError && <span className="field-error">{dupError}</span>}
              </div>
            )
          }
          actions={
            <>
              {splitControl}
              <Button ref={sendButton} variant="primary" onClick={(e) => void comment(e.currentTarget)} disabled={!hasText || busy} trailing={<kbd className="kbd">{sendKey}</kbd>}>
                {busy ? "Uploading…" : note ? "Add note" : "Send"}
              </Button>
            </>
          }
        />
      </div>
      {prompt}
    </div>
  )
}

/** In place of the composer on a locked issue, for anyone outside the team. */
export function LockedComposer() {
  return (
    <div className="composer-locked" role="note">
      Locked: only the team can reply.
    </div>
  )
}
