import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from "react"
import type { Attachment, CloseReason, Me } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { setData } from "../../lib/cache"
import { ensureHuman } from "../../lib/human"
import { signInHref } from "../../lib/site"
import { Editor } from "../../ui/Editor"
import { ChevronDownIcon, LockIcon } from "../../ui/icons"
import { Menu, MenuItem } from "../../ui/Menu"
import { Button, StateIcon } from "../../ui/primitives"
import { SiteLink } from "../../ui/SiteLink"
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

/** A guest's display name: 1–40 characters after trimming. */
export const validGuestName = (name: string) => name.trim().length >= 1 && name.trim().length <= 40

/**
 * The reply box pinned to the bottom of the viewport, with close/reopen as a split button beside Send. Guests see
 * who they post as above it; until they have a name, that line is the name field, and the name goes with the post.
 */
export function Composer({ model, nameField }: { model: IssueModel; nameField: RefObject<HTMLInputElement | null> }) {
  const { app, issue, me, member, onStatus, onDuplicate } = model
  const guest = me && !me.user ? me.guest : null
  const [changing, setChanging] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const naming = !!guest && (!guest.name || changing || model.askName)
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

  useEffect(() => {
    if (model.askName) nameField.current?.focus()
  }, [model.askName, nameField])

  const comment = async () => {
    if (!hasText || busy) return true
    let guestName: string | undefined
    if (naming) {
      guestName = nameField.current?.value.trim() ?? ""
      if (!validGuestName(guestName)) {
        setNameError(guestName ? "Up to 40 characters." : "Add your name to post.")
        nameField.current?.focus()
        return false
      }
    }
    setNameError(null)
    const text = body
    const ids = attachments.filter((a) => text.includes(a.url)).map((a) => a.id)
    setBody("")
    setAttachments([])
    const ok = await model.onComment(text, ids, guestName, note)
    if (ok) setChanging(false)
    return ok
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
  const closeLabel = reason === "completed" ? (hasText ? (note ? "Close with note" : "Close with comment") : "Close issue") : option.label
  const reopenLabel = hasText ? (note ? "Reopen with note" : "Reopen with comment") : "Reopen issue"
  const duplicating = member && reason === "duplicate" && issue.status !== "closed"

  // The team, and the reporter (completed or not planned; duplicates need the team).
  const options = member ? closeOptions : closeOptions.filter((o) => o.reason !== "duplicate")
  const splitControl = !member && !issue.viewer_is_author ? null : issue.status === "closed" ? (
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
        {guest && (
          <GuestBar
            me={me!}
            naming={naming}
            nameField={nameField}
            error={nameError}
            onChange={() => setChanging(true)}
            onDone={() => {
              setChanging(false)
              setNameError(null)
            }}
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
              <Button variant="primary" onClick={() => void comment()} disabled={!hasText || busy} trailing={<kbd className="kbd">{sendKey}</kbd>}>
                {busy ? "Uploading…" : note ? "Add note" : "Send"}
              </Button>
            </>
          }
        />
      </div>
    </div>
  )
}

/** "Posting as Alex · Change name · Sign in", or the name field while a guest names (or renames) themselves. */
function GuestBar({
  me,
  naming,
  nameField,
  error,
  onChange,
  onDone,
}: {
  me: Me
  naming: boolean
  nameField: RefObject<HTMLInputElement | null>
  error: string | null
  onChange: () => void
  onDone: () => void
}) {
  const saved = me.guest.name
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // A rename without posting: PUT /api/me/guest. A first name just goes along with the post.
  const save = async (e: FormEvent) => {
    e.preventDefault()
    const name = nameField.current?.value.trim() ?? ""
    if (!validGuestName(name)) return setSaveError(name ? "Up to 40 characters." : "Add a name.")
    if (name === saved) return onDone()
    setSaving(true)
    setSaveError(null)
    try {
      await ensureHuman(false)
      setData<Me>(keys.me, await api.setGuestName(name))
      onDone()
    } catch (err) {
      setSaveError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const signIn = (
    <SiteLink href={signInHref()} className="guest-bar-link">
      Sign in
    </SiteLink>
  )

  if (!naming)
    return (
      <div className="guest-bar">
        <span className="guest-bar-text">
          Posting as <strong>{saved}</strong>
        </span>
        <span aria-hidden="true">·</span>
        <button type="button" className="guest-bar-link" onClick={onChange}>
          Change name
        </button>
        <span aria-hidden="true">·</span>
        {signIn}
      </div>
    )

  const problem = error ?? saveError
  return (
    <form className="guest-bar" onSubmit={saved ? save : (e) => e.preventDefault()}>
      <label htmlFor="guest-name">Your name</label>
      <div className="input" data-size="small" data-invalid={problem ? "" : undefined}>
        <input
          ref={nameField}
          id="guest-name"
          defaultValue={saved ?? ""}
          maxLength={40}
          autoComplete="name"
          placeholder="Name"
          aria-invalid={!!problem}
          aria-describedby={problem ? "guest-name-error" : undefined}
          autoFocus={!!saved}
        />
      </div>
      {saved && (
        <>
          <Button type="submit" size="small" disabled={saving}>
            Save
          </Button>
          <Button size="small" variant="invisible" onClick={onDone}>
            Cancel
          </Button>
        </>
      )}
      {problem && (
        <span id="guest-name-error" className="field-error">
          {problem}
        </span>
      )}
      {!saved && (
        <>
          <span className="spacer" />
          {signIn}
        </>
      )}
    </form>
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
