import { useLayoutEffect, useRef, useState, type CSSProperties } from "react"
import { useLocation, useSearch } from "wouter"
import type { Attachment, CloseReason, ReportMetadata } from "../../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { load, useResource } from "../../lib/cache"
import { setGuestNameLocally, useWho } from "../../lib/guest"
import { ensureHuman } from "../../lib/human"
import { appendTimeline } from "../../lib/issues"
import { appPath } from "../../lib/site"
import { Editor } from "../../ui/Editor"
import { contentsText, sourceText } from "../../ui/features/Diagnostics"
import { SavedRepliesMenu } from "../../ui/features/SavedRepliesMenu"
import { actorName } from "../../ui/Actor"
import { ChevronDownIcon, LockIcon, PaperclipIcon, XIcon } from "../../ui/icons"
import { Menu, MenuItem } from "../../ui/Menu"
import { GuestLine, useNamePrompt } from "../../ui/NamePrompt"
import { Button, StateIcon } from "../../ui/primitives"
import type { IssueModel } from "./model"
import { tKey, useT } from "../../i18n/core"
import { useT as useDeskT } from "../../i18n/helpdesk"
import { deskOutsider } from "../../lib/helpdesk"

const closeOptions: { reason: CloseReason; readonly label: string; readonly description: string }[] = (["completed", "not_planned", "duplicate"] as const).map((reason) => ({
  reason,
  get label() {
    return tKey(`close.${reason}`)
  },
  get description() {
    return tKey(`close.${reason}Text`)
  },
}))

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
  const t = useT()
  const td = useDeskT()
  const { app, issue, me, member, onStatus, onDuplicate } = model
  const guest = me && !me.user && !me.contact ? me.guest : null
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
  // "Add to #34 instead" from a new report lands here with ?metadata=md_…: the next post carries those diagnostics.
  const [, navigate] = useLocation()
  const metadataId = new URLSearchParams(useSearch()).get("metadata")
  const dropMetadata = () => navigate(appPath(app.slug, `/issues/${issue.number}`), { replace: true })
  const [metadataError, setMetadataError] = useState<string | null>(null)
  const canSend = hasText || (!!metadataId && !note)

  /** A post with diagnostics goes straight to the API (the shared pending queue doesn't carry them), then the issue
   *  is refetched so the Diagnostics chip appears on it. */
  const commentWithMetadata = async (anchor: HTMLElement | null, guestName?: string): Promise<boolean> => {
    if (!metadataId) return true
    if (guest && !guest.name && !guestName) {
      const name = await ask({ anchor, mode: "first", action: t("composer.post") })
      if (!name) return false
      guestName = name
    }
    setWorking(true)
    setMetadataError(null)
    try {
      await ensureHuman(member || !!me?.user)
      const posted = await api.comment(app.slug, issue.number, {
        body,
        metadata_id: metadataId,
        attachment_ids: attachments.filter((a) => body.includes(a.url)).map((a) => a.id),
        guest_name: guestName,
      })
      if (guestName) setGuestNameLocally(guestName)
      appendTimeline(app.slug, issue.number, { kind: "comment", comment: posted })
      setBody("")
      setAttachments([])
      dropMetadata()
      load(keys.issue(app.slug, issue.number), () => api.issue(app.slug, issue.number)).catch(() => {})
      return true
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "name_required" && !guestName) {
        setGuestNameLocally(null)
        setWorking(false)
        const name = await ask({ anchor, mode: "first", action: t("composer.post") })
        return name ? commentWithMetadata(anchor, name) : false
      }
      setMetadataError(e instanceof ApiFailure && e.status === 410 ? t("composer.diagExpiredError") : errorMessage(e))
      return false
    } finally {
      setWorking(false)
    }
  }

  /** Posts the draft; `anchor` is the button pressed, where the name prompt grows from if one is needed. */
  const comment = async (anchor: HTMLElement | null = sendButton.current) => {
    if (metadataId && !note) return busy ? true : commentWithMetadata(anchor)
    if (!hasText || busy) return true
    let guestName: string | undefined
    if (guest && !guest.name) {
      const name = await ask({ anchor, mode: "first", action: t("composer.post") })
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
      const name = await ask({ anchor, mode: "first", action: t("composer.post") })
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
      if (!Number.isInteger(n) || n < 1) return setDupError(t("composer.enterDuplicate"))
      setWorking(true)
      try {
        if (!(await comment(anchor))) return
        await onDuplicate(n)
        setDupOf("")
        setReason("completed")
      } catch (e) {
        setDupError(e instanceof Error ? e.message : t("composer.duplicateFailed"))
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
  const desk = deskOutsider(model.app)
  const closeLabel =
    reason === "completed"
      ? hasText
        ? note
          ? t("composer.closeWithNote")
          : t("composer.closeWithComment")
        : desk
          ? td("composer.closeRequest")
          : t("composer.closeIssue")
      : option.label
  const reopenLabel = hasText ? (note ? t("composer.reopenWithNote") : t("composer.reopenWithComment")) : desk ? td("composer.reopenRequest") : t("composer.reopenIssue")
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
        title={hasText ? t("composer.postsFirst", { label: closeLabel }) : closeLabel}
      >
        <span className="close-label">{closeLabel}</span>
      </Button>
      <Menu align="end" width={300} trigger={(p) => <Button iconOnly aria-label={t("composer.moreClose")} icon={<ChevronDownIcon size={14} />} {...p} />}>
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
            <div className="segmented composer-mode-switch" role="radiogroup" aria-label={t("composer.postAs")}>
              <button type="button" role="radio" aria-checked={!note} aria-pressed={!note} onClick={() => setInternal(false)}>
                {t("composer.reply")}
              </button>
              <button type="button" role="radio" aria-checked={note} aria-pressed={note} onClick={() => setInternal(true)}>
                <LockIcon size={12} />
                {t("composer.note")}
              </button>
            </div>
            <span className="composer-mode-hint">{note ? t("composer.noteHint") : t("composer.replyHint")}</span>
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
          label={note ? t("composer.note") : t("composer.reply")}
          placeholder={note ? t("composer.notePlaceholder") : undefined}
          minHeight={40}
          extra={
            (duplicating || (metadataId && !note)) && (
              <>
                {metadataId && !note && <MetadataChip slug={app.slug} id={metadataId} error={metadataError} onRemove={dropMetadata} />}
                {duplicating && (
                  <div className="dup-form">
                    <label className="field-label" htmlFor="dup-of">
                      {t("composer.duplicateOf")}
                    </label>
                    <div className="input" data-size="small">
                      <span className="input-prefix mono">#</span>
                      <input id="dup-of" className="mono" inputMode="numeric" value={dupOf} onChange={(e) => setDupOf(e.target.value)} placeholder="123" autoFocus />
                    </div>
                    {dupError && <span className="field-error">{dupError}</span>}
                  </div>
                )}
              </>
            )
          }
          actions={
            <>
              {member && (
                <SavedRepliesMenu
                  slug={app.slug}
                  reporter={actorName(issue.author)}
                  onInsert={(text) => {
                    setBody((b) => (b.trim() ? `${b.replace(/\s*$/, "")}\n\n${text}` : text))
                    // Back to the text, caret at the end, so the reply can be adjusted and sent from the keyboard.
                    requestAnimationFrame(() => {
                      const area = dock.current?.querySelector("textarea")
                      if (!area) return
                      area.focus()
                      area.setSelectionRange(area.value.length, area.value.length)
                    })
                  }}
                />
              )}
              {splitControl}
              <Button ref={sendButton} variant="primary" onClick={(e) => void comment(e.currentTarget)} disabled={!canSend || busy || working} trailing={<kbd className="kbd">{sendKey}</kbd>}>
                {busy ? t("composer.uploading") : note ? t("composer.addNote") : t("composer.send")}
              </Button>
            </>
          }
        />
      </div>
      {prompt}
    </div>
  )
}

/** "Diagnostics attached" in the composer: what the next post carries, with a way to leave it out. */
function MetadataChip({ slug, id, error, onRemove }: { slug: string; id: string; error: string | null; onRemove: () => void }) {
  const t = useT()
  const { data, error: loadError } = useResource<ReportMetadata>(keys.metadata(slug, id), () => api.metadata(slug, id), 60_000)
  const gone = loadError instanceof ApiFailure && (loadError.status === 410 || loadError.status === 404)
  const used = !!data?.attached_to
  const detail = data ? [sourceText(data), contentsText(data)].filter(Boolean).join(" · ") : ""
  return (
    <div className="composer-diag">
      <span className="composer-diag-chip" data-problem={gone || used || undefined}>
        <PaperclipIcon size={12} />
        <span className="composer-diag-text">
          {gone ? t("composer.diagExpired") : used ? t("composer.diagSent") : t("composer.diagAttached")}
          {detail && !gone && !used && <span className="composer-diag-meta"> · {detail}</span>}
        </span>
        <button type="button" className="composer-diag-remove" aria-label={t("composer.diagRemove")} title={t("composer.diagRemoveTitle")} onClick={onRemove}>
          <XIcon size={12} />
        </button>
      </span>
      {error && <span className="field-error">{error}</span>}
    </div>
  )
}

/** In place of the composer on a locked issue, for anyone outside the team. */
export function LockedComposer() {
  const t = useT()
  return (
    <div className="composer-locked" role="note">
      {t("composer.locked")}
    </div>
  )
}
