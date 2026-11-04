import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from "react"
import type { Actor, Attachment, Mentionable } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { useResource } from "../lib/cache"
import { ensureHuman } from "../lib/human"
import { kindOf, upload, type UploadHandle } from "../lib/upload"
import { ImageIcon, PaperclipIcon, RecordIcon, VideoIcon, XIcon } from "./icons"
import { Markdown, loadMarkdown } from "./Markdown"
import { ActorAvatar } from "./Actor"
import { AiBadge, Button } from "./primitives"

interface Chip {
  id: number
  name: string
  type: string
  progress: number
  error?: string
  handle?: UploadHandle
}

let seq = 0

function markdownFor(a: Attachment) {
  const name = a.name.replace(/[[\]]/g, "")
  return a.kind === "file" ? `[${name}](${a.url})` : `![${name}](${a.url})`
}

const recordingTypes = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
const canRecord = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== "undefined"

/** Markdown composer shared by new issues, comments and edits: the text, then a toolbar with uploads (picker,
 *  paste, drop), screen recording, a preview toggle and the caller's actions. Uploaded files land in the text as markdown and in `onAttachment`. */
export function Editor({
  slug,
  value,
  onChange,
  member,
  onAttachment,
  onSubmit,
  onBusyChange,
  placeholder = "Write a reply…",
  autoFocus,
  minHeight = 120,
  label,
  actions,
  extra,
  variant,
  mentions,
}: {
  slug: string
  value: string
  onChange: (value: string) => void
  member: boolean
  onAttachment: (attachment: Attachment) => void
  onSubmit?: () => void
  onBusyChange?: (busy: boolean) => void
  placeholder?: string
  autoFocus?: boolean
  minHeight?: number
  label?: string
  /** Buttons on the right of the toolbar (Send, Save). */
  actions?: ReactNode
  /** A row between the text and the toolbar. */
  extra?: ReactNode
  /** "chat": the docked composer on an issue. */
  variant?: "chat"
  /** The team: `@` suggests members and agents to mention. Guests get plain text. */
  mentions?: boolean
}) {
  const [tab, setTab] = useState<"write" | "preview">("write")
  const [chips, setChips] = useState<Chip[]>([])
  const [dragging, setDragging] = useState(false)
  const [recording, setRecording] = useState<{ recorder: MediaRecorder; stream: MediaStream; started: number } | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const mediaInput = useRef<HTMLInputElement>(null)
  const latest = useRef(value)
  latest.current = value
  // Where uploads land: the last caret position, or the end until the person has clicked into the text.
  const caret = useRef<{ start: number; end: number } | null>(null)

  // @ autocomplete: the handle being typed (from the @ to the caret), and which suggestion is highlighted.
  const [at, setAt] = useState<{ start: number; query: string } | null>(null)
  const [highlight, setHighlight] = useState(0)
  const [wantPeople, setWantPeople] = useState(false)
  const { data: people } = useResource<Mentionable[]>(mentions && wantPeople ? keys.mentionables(slug) : null, () => api.mentionables(slug), 60_000)
  const suggestions =
    at && people
      ? people.filter((p) => p.handle.startsWith(at.query) || p.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(at.query))).slice(0, 6)
      : []
  const suggesting = !!at && suggestions.length > 0
  // Agents that share a name ("OpenCode" twice) get what tells them apart: how they connect and whose they are.
  const qualifier = (p: Mentionable) => {
    if (p.type !== "agent" || (people ?? []).filter((x) => x.name === p.name).length < 2) return null
    const kind = p.agent_kind === "oauth" ? "Connected app" : p.agent_kind === "token" ? "Token agent" : null
    return [kind, p.owner_name].filter(Boolean).join(" · ") || null
  }
  const listId = `mentions-${slug}-${variant ?? "page"}`

  const detect = (el: HTMLTextAreaElement) => {
    if (!mentions) return
    if (el.selectionStart !== el.selectionEnd) return setAt(null)
    const before = el.value.slice(0, el.selectionStart)
    const m = /(^|[\s([{])@([a-z0-9-]{0,40})$/i.exec(before)
    if (!m) return setAt(null)
    setWantPeople(true)
    setAt((prev) => {
      const next = { start: el.selectionStart - m[2]!.length - 1, query: m[2]!.toLowerCase() }
      if (prev?.query !== next.query || prev.start !== next.start) setHighlight(0)
      return next
    })
  }

  const choose = (p: Mentionable) => {
    const el = area.current
    if (!at) return
    const v = latest.current
    const end = at.start + 1 + at.query.length
    const tail = v.slice(end)
    const text = `@${p.handle}${tail.startsWith(" ") ? "" : " "}`
    caretAfter.current = at.start + text.length
    set(v.slice(0, at.start) + text + tail)
    setAt(null)
    el?.focus()
  }
  // After a pick, put the caret after the handle as soon as the new text is committed, before the next keystroke.
  const caretAfter = useRef<number | null>(null)
  useLayoutEffect(() => {
    const el = area.current
    if (caretAfter.current === null || !el) return
    el.setSelectionRange(caretAfter.current, caretAfter.current)
    caretAfter.current = null
  }, [value])

  const busy = chips.some((c) => !c.error) || !!recording
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange])
  useEffect(() => () => recording?.stream.getTracks().forEach((t) => t.stop()), [recording])

  const set = (next: string) => {
    latest.current = next
    onChange(next)
  }

  const insert = (text: string) => {
    const el = area.current
    const v = latest.current
    const focused = !!el && document.activeElement === el
    const sel = focused ? { start: el.selectionStart, end: el.selectionEnd } : caret.current
    const start = Math.min(sel?.start ?? v.length, v.length)
    const end = Math.min(sel?.end ?? v.length, v.length)
    const before = v.slice(0, start)
    const pad = before && !before.endsWith("\n") ? "\n" : ""
    const next = `${before}${pad}${text}\n${v.slice(end)}`
    set(next)
    const at = before.length + pad.length + text.length + 1
    caret.current = { start: at, end: at }
    requestAnimationFrame(() => {
      if (el && document.activeElement === el) el.setSelectionRange(at, at)
    })
  }

  const patch = (id: number, p: Partial<Chip>) => setChips((cs) => cs.map((c) => (c.id === id ? { ...c, ...p } : c)))
  const drop = (id: number) => setChips((cs) => cs.filter((c) => c.id !== id))

  const start = async (files: File[]) => {
    if (!files.length) return
    try {
      await ensureHuman(member)
    } catch (e) {
      setChips((cs) => [...cs, { id: ++seq, name: files[0]!.name, type: files[0]!.type, progress: 0, error: errorMessage(e) }])
      return
    }
    for (const file of files) {
      const id = ++seq
      const placeholderText = `[Uploading ${file.name.replace(/[[\]]/g, "")} (${id})…]()`
      insert(placeholderText)
      const handle = upload(slug, file, (progress) => patch(id, { progress }))
      setChips((cs) => [...cs, { id, name: file.name, type: file.type, progress: 0, handle }])
      handle.promise.then(
        (attachment) => {
          set(latest.current.replace(placeholderText, markdownFor(attachment)))
          onAttachment(attachment)
          drop(id)
        },
        (error: unknown) => {
          set(latest.current.replace(`${placeholderText}\n`, "").replace(placeholderText, ""))
          if (error instanceof DOMException && error.name === "AbortError") drop(id)
          else patch(id, { error: errorMessage(error), handle: undefined })
        },
      )
    }
  }

  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files]
    if (!files.length) return
    e.preventDefault()
    start(files)
  }

  const onDrop = (e: DragEvent) => {
    setDragging(false)
    const files = [...e.dataTransfer.files]
    if (!files.length) return
    e.preventDefault()
    start(files)
  }

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return
    e.preventDefault()
    setDragging(true)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (suggesting) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault()
        const step = e.key === "ArrowDown" ? 1 : -1
        setHighlight((i) => (i + step + suggestions.length) % suggestions.length)
        return
      }
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey) || e.key === "Tab") {
        e.preventDefault()
        choose(suggestions[Math.min(highlight, suggestions.length - 1)]!)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        e.stopPropagation()
        setAt(null)
        return
      }
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) {
      e.preventDefault()
      onSubmit()
    }
  }

  const record = async () => {
    if (recording) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true })
    } catch {
      return // The person cancelled the picker.
    }
    const mimeType = recordingTypes.find((t) => MediaRecorder.isTypeSupported(t))
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000 } : undefined)
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data)
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      setRecording(null)
      const type = (recorder.mimeType || mimeType || "video/webm").split(";")[0]!
      const ext = type === "video/mp4" ? "mp4" : "webm"
      const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, "")
      if (chunks.length) start([new File(chunks, `recording-${stamp}.${ext}`, { type })])
    }
    // Stopping the share from the browser's own bar ends the recording too.
    stream.getVideoTracks()[0]?.addEventListener("ended", () => recorder.state !== "inactive" && recorder.stop())
    recorder.start(1000)
    setRecording({ recorder, stream, started: Date.now() })
  }

  const pick = (input: HTMLInputElement | null) => {
    if (!input) return
    start([...(input.files ?? [])])
    input.value = ""
  }

  const tools = (
    <div className="editor-tools">
      <Button
        variant="ghost-muted"
        iconOnly
        aria-label="Attach file"
        title="Attach file"
        icon={<PaperclipIcon />}
        onClick={() => fileInput.current?.click()}
      />
      <Button
        variant="ghost-muted"
        iconOnly
        aria-label="Add image or video"
        title="Add image or video"
        icon={<ImageIcon />}
        onClick={() => mediaInput.current?.click()}
      />
      {canRecord && (
        <Button
          variant="ghost-muted"
          iconOnly
          aria-label="Record screen"
          title="Record screen"
          icon={<RecordIcon />}
          disabled={!!recording}
          onClick={record}
        />
      )}
      <Button
        variant="ghost-muted"
        aria-pressed={tab === "preview"}
        title={tab === "preview" ? "Back to writing" : "Preview markdown"}
        onMouseEnter={() => loadMarkdown()}
        onClick={() => setTab(tab === "write" ? "preview" : "write")}
      >
        {tab === "write" ? "Preview" : "Write"}
      </Button>
      <input ref={fileInput} type="file" multiple hidden onChange={(e) => pick(e.currentTarget)} />
      <input ref={mediaInput} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => pick(e.currentTarget)} />
    </div>
  )

  return (
    <div className="editor" data-variant={variant} data-dragging={dragging || undefined} data-preview={tab === "preview" || undefined}>
      {tab === "write" ? (
        <textarea
          ref={area}
          className="editor-area"
          style={{ minHeight }}
          value={value}
          placeholder={placeholder}
          aria-label={label ?? "Markdown"}
          autoFocus={autoFocus}
          aria-autocomplete={mentions ? "list" : undefined}
          aria-controls={suggesting ? listId : undefined}
          aria-expanded={mentions ? suggesting : undefined}
          aria-activedescendant={suggesting ? `${listId}-${highlight}` : undefined}
          onChange={(e) => {
            set(e.target.value)
            detect(e.target)
          }}
          onSelect={(e) => {
            caret.current = { start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd }
            detect(e.currentTarget)
          }}
          // Later than a tap on a suggestion, which some phones deliver after the blur.
          onBlur={() => setTimeout(() => setAt(null), 150)}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={() => setDragging(false)}
          onKeyDown={onKeyDown}
        />
      ) : (
        <div className="editor-preview" style={{ minHeight }}>
          {value.trim() ? <Markdown source={value} slug={slug} /> : <p className="muted-text">Nothing to preview.</p>}
        </div>
      )}

      {suggesting && (
        <div className="mention-menu" id={listId} role="listbox" aria-label="People to mention" data-place={variant === "chat" ? "above" : "below"}>
          {suggestions.map((p, i) => {
            const actor: Actor = p.type === "agent" ? { type: "agent", id: p.id, name: p.name } : { type: "member", id: p.id, name: p.name, avatar_url: p.avatar_url }
            return (
              <button
                key={p.id}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === highlight}
                className="mention-option"
                // Keep the caret in the text: choosing mustn't blur it first.
                onMouseDown={(e) => e.preventDefault()}
                onPointerDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(p)}
              >
                <ActorAvatar actor={actor} size={20} />
                <span className="mention-option-text">
                  <span className="mention-option-line">
                    <span className="mention-option-name">{p.name}</span>
                    {p.type === "agent" && <AiBadge />}
                  </span>
                  {qualifier(p) && <span className="mention-option-qualifier">{qualifier(p)}</span>}
                </span>
                <span className="mention-option-handle mono">@{p.handle}</span>
              </button>
            )
          })}
        </div>
      )}

      {chips.length > 0 && (
        <div className="editor-chips">
          {chips.map((chip) => (
            <UploadChip
              key={chip.id}
              chip={chip}
              onCancel={() => (chip.handle ? chip.handle.abort() : drop(chip.id))}
            />
          ))}
        </div>
      )}
      {extra}
      <div className="editor-foot">
        {tools}
        {actions && <div className="editor-actions">{actions}</div>}
      </div>
      {recording && <RecordingBar started={recording.started} onStop={() => recording.recorder.stop()} />}
    </div>
  )
}

function UploadChip({ chip, onCancel }: { chip: Chip; onCancel: () => void }) {
  const kind = kindOf(chip.type)
  return (
    <span className="upload-chip" data-error={chip.error ? "" : undefined} title={chip.error ?? chip.name}>
      {kind === "image" ? <ImageIcon size={14} /> : kind === "video" ? <VideoIcon size={14} /> : <PaperclipIcon size={14} />}
      <span className="upload-chip-name">{chip.name}</span>
      {chip.error ? (
        <span className="upload-chip-error">{chip.error}</span>
      ) : (
        <>
          <span className="upload-progress" aria-hidden="true">
            <span style={{ transform: `scaleX(${chip.progress})` }} />
          </span>
          <span className="mono upload-chip-pct">{Math.round(chip.progress * 100)}%</span>
        </>
      )}
      <button type="button" className="upload-chip-x" aria-label={chip.error ? "Dismiss" : `Cancel ${chip.name}`} onClick={onCancel}>
        <XIcon size={12} />
      </button>
    </span>
  )
}

function RecordingBar({ started, onStop }: { started: number; onStop: () => void }): ReactNode {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  const s = Math.floor((now - started) / 1000)
  return (
    <div className="recording" role="status">
      <span className="recording-dot" aria-hidden="true" />
      Recording
      <span className="mono">
        {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
      </span>
      <Button size="small" variant="danger" onClick={onStop}>
        Stop
      </Button>
    </div>
  )
}
