import { useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { Activity, Actor } from "../../../shared/api"
import { stateText, visibleState } from "../../lib/issues"
import { Time, useUntil } from "../../lib/time"
import { ActorAvatar, ActorName } from "../../ui/Actor"
import { PersonIcon, XIcon } from "../../ui/icons"
import { Markdown } from "../../ui/Markdown"
import { Button, Dots, StateLabel } from "../../ui/primitives"
import { Composer } from "./Composer"
import { BodyForm, TitleForm } from "./Editing"
import { blocks, entries, hasMedia, type IssueModel, type MessageEntry } from "./model"
import { Sidebar } from "./Sidebar"
import { AttachmentList, eventContent } from "./Timeline"
import "../../styles/issue-layouts.css"

/** Team members and agents answer from the left; the reporter and other guests write from the right. */
const sideOf = (author: Actor, byAuthor: boolean) => (byAuthor || author.type === "guest" ? "reporter" : "team")

/** Prototype A: a support chat. One column of bubbles, events as small centered markers, details in a slide-over. */
export function ChatLayout({ model }: { model: IssueModel }) {
  const { app, issue, canEdit, actionError } = model
  const [details, setDetails] = useState(false)
  const [editingBody, setEditingBody] = useState(false)

  return (
    <main className="chat">
      <header className="chat-head">
        <div className="chat-col chat-head-inner">
          <h1 className="chat-title">
            <span className="chat-title-text">{issue.title}</span> <span className="mono chat-title-number">#{issue.number}</span>
          </h1>
          <StateLabel state={visibleState(issue)} text={stateText(issue)} size="small" />
          <Button aria-expanded={details} onClick={() => setDetails(true)}>
            Details
          </Button>
        </div>
      </header>

      <div className="chat-col chat-thread">
        {blocks(entries(model, true)).map((b) =>
          b.kind === "events" ? (
            b.events.map((event) => {
              const { icon, tone, body } = eventContent(app.slug, event)
              return (
                <div key={event.id} className="chat-marker" data-tone={tone}>
                  <span className="chat-marker-icon">{icon}</span>
                  <span>
                    <ActorName actor={event.actor} badge={false} /> {body} · <Time iso={event.created_at} />
                  </span>
                </div>
              )
            })
          ) : (
            <div key={b.key} className="chat-run" data-side={sideOf(b.author, b.byAuthor)} data-agent={b.author.type === "agent" || undefined}>
              <span className="chat-run-avatar">
                <ActorAvatar actor={b.author} size={28} />
              </span>
              <div className="chat-run-main">
                <div className="chat-run-name">
                  <ActorName actor={b.author} />
                </div>
                {b.messages.map((m, i) => (
                  <Bubble
                    key={m.key}
                    slug={app.slug}
                    message={m}
                    pos={b.messages.length === 1 ? "single" : i === 0 ? "first" : i === b.messages.length - 1 ? "last" : "middle"}
                    editing={!!m.opener && editingBody}
                    form={m.opener && editingBody ? <BodyForm app={app} issue={issue} onDone={() => setEditingBody(false)} /> : null}
                  />
                ))}
                <RunFoot messages={b.messages} onEdit={canEdit && !editingBody ? () => setEditingBody(true) : undefined} />
              </div>
            </div>
          ),
        )}
        <TypingBubble activity={issue.activity} />
      </div>

      <div className="chat-dock">
        <div className="chat-col">
          {actionError && (
            <p className="flash" data-tone="danger">
              {actionError}
            </p>
          )}
          <Composer
            app={app}
            issue={issue}
            variant="menu"
            placeholder="Write a message…"
            onComment={model.onComment}
            onStatus={model.onStatus}
            onDuplicate={model.onDuplicate}
          />
        </div>
      </div>

      {details && <DetailsPanel model={model} onClose={() => setDetails(false)} />}
    </main>
  )
}

function Bubble({
  slug,
  message,
  pos,
  editing,
  form,
}: {
  slug: string
  message: MessageEntry
  pos: "single" | "first" | "middle" | "last"
  editing: boolean
  form: ReactNode
}) {
  if (editing) return <div className="chat-edit">{form}</div>
  const loose = message.attachments.filter((a) => !message.body.includes(a.url))
  return (
    <div className="chat-msg" data-pending={message.note ? "" : undefined}>
      <div
        className="bubble"
        data-pos={pos}
        data-wide={hasMedia(message.body, message.attachments) || undefined}
        title={new Date(message.createdAt).toLocaleString()}
      >
        <Markdown source={message.body} slug={slug} />
        {loose.length > 0 && <AttachmentList attachments={loose} />}
      </div>
      {message.note && <div className="chat-note">{message.note}</div>}
    </div>
  )
}

/** The small line under a run: when the last message arrived, and Edit on the description. */
function RunFoot({ messages, onEdit }: { messages: MessageEntry[]; onEdit?: () => void }) {
  const sent = messages.filter((m) => !m.note)
  const last = sent[sent.length - 1]
  const opener = messages.some((m) => m.opener)
  if (!last) return null
  return (
    <div className="chat-run-foot">
      {opener && messages.length === 1 ? "Opened " : ""}
      <Time iso={last.createdAt} />
      {opener && onEdit && (
        <>
          {" · "}
          <button type="button" className="chat-foot-action" onClick={onEdit}>
            Edit description
          </button>
        </>
      )}
    </div>
  )
}

function TypingBubble({ activity }: { activity: Activity | null }) {
  const live = useUntil(activity?.expires_at)
  if (!activity || !live) return null
  return (
    <div className="chat-run" data-side="team" data-agent={activity.actor.type === "agent" || undefined} aria-live="polite">
      <span className="chat-run-avatar">
        <ActorAvatar actor={activity.actor} size={28} />
      </span>
      <div className="chat-run-main">
        <div className="chat-run-name">
          <ActorName actor={activity.actor} />
        </div>
        <div className="chat-msg">
          <div className="bubble chat-typing" data-pos="single">
            <Dots />
            {activity.text && <span className="chat-typing-text">{activity.text}</span>}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Status, assignee, labels, relationships, system info and files, sliding in from the right (a bottom sheet on phones). */
function DetailsPanel({ model, onClose }: { model: IssueModel; onClose: () => void }) {
  const { app, issue, me, viewers, canEdit, actions } = model
  const [editingTitle, setEditingTitle] = useState(false)
  const panel = useRef<HTMLElement>(null)

  useEffect(() => {
    panel.current?.querySelector<HTMLElement>(".details-head .btn")?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".menu") && onClose()
    document.addEventListener("keydown", onKey)
    const html = document.documentElement
    const overflow = html.style.overflow
    html.style.overflow = "hidden"
    return () => {
      document.removeEventListener("keydown", onKey)
      html.style.overflow = overflow
    }
  }, [onClose])

  return createPortal(
    <>
      <div className="details-scrim" aria-hidden="true" onClick={onClose} />
      <aside ref={panel} className="details" role="dialog" aria-modal="true" aria-label="Details">
        <div className="details-head">
          <h2>Details</h2>
          <Button iconOnly variant="invisible" aria-label="Close details" icon={<XIcon size={14} />} onClick={onClose} />
        </div>
        <div className="details-body">
          <section className="details-summary">
            {editingTitle ? (
              <TitleForm app={app} issue={issue} onDone={() => setEditingTitle(false)} />
            ) : (
              <div className="details-title-row">
                <p className="details-title">
                  {issue.title} <span className="mono chat-title-number">#{issue.number}</span>
                </p>
                {canEdit && (
                  <Button size="small" variant="invisible" onClick={() => setEditingTitle(true)}>
                    Edit
                  </Button>
                )}
              </div>
            )}
            <p className="details-meta">
              <ActorName actor={issue.author} badge={false} /> opened this <Time iso={issue.created_at} />
              {viewers !== null && viewers > 0 && (
                <>
                  {" · "}
                  <PersonIcon size={12} /> {viewers} viewing
                </>
              )}
            </p>
          </section>
          <Sidebar app={app} issue={issue} me={me} actions={actions} />
        </div>
      </aside>
    </>,
    document.body,
  )
}
