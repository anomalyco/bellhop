import { useState, type ReactNode } from "react"
import type { Activity, Actor, Attachment, CloseReason, IssueEvent, IssueRef, IssueStatus, Label as LabelType, Relation } from "../../../shared/api"
import { visibleState } from "../../lib/issues"
import { appPath } from "../../lib/site"
import { Time, useUntil } from "../../lib/time"
import { formatSize } from "../../lib/upload"
import { ActorAvatar, ActorName, actorName } from "../../ui/Actor"
import { ChevronDownIcon, ImageIcon, LinkIcon, PaperclipIcon, PersonIcon, StatusIcon, TagIcon, VideoIcon } from "../../ui/icons"
import { Markdown } from "../../ui/Markdown"
import { Dots, Label } from "../../ui/primitives"
import { AppLink } from "../../ui/SiteLink"
import type { MessageEntry } from "./model"

/** Consecutive messages from one person under one name. The reporter's avatar gets a thin ring instead of a badge. */
export function MessageGroup({ slug, author, byAuthor, messages }: { slug: string; author: Actor; byAuthor: boolean; messages: MessageEntry[] }) {
  return (
    <section className="group">
      <header className="group-head">
        <span className="group-avatar" data-reporter={byAuthor || undefined} title={byAuthor ? `${actorName(author)} opened this issue` : undefined}>
          <ActorAvatar actor={author} size={20} />
        </span>
        <ActorName actor={author} />
        <span className="group-time">
          <Time iso={messages[0]!.createdAt} />
        </span>
      </header>
      {messages.map((m) => {
        const loose = m.attachments.filter((a) => !m.body.includes(a.url))
        return (
          <div key={m.key} className="group-msg" data-pending={m.note ? "" : undefined}>
            <Markdown source={m.body} slug={slug} />
            {loose.length > 0 && <AttachmentList attachments={loose} />}
            {m.note && <div className="group-note">{m.note}</div>}
          </div>
        )
      })}
    </section>
  )
}

export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  return (
    <ul className="attachments">
      {attachments.map((a) => (
        <li key={a.id}>
          <a href={a.url} target="_blank" rel="noopener" className="attachment">
            {a.kind === "image" ? <ImageIcon size={14} /> : a.kind === "video" ? <VideoIcon size={14} /> : <PaperclipIcon size={14} />}
            <span className="attachment-name">{a.name}</span>
            <span className="mono attachment-size">{formatSize(a.size)}</span>
          </a>
        </li>
      ))}
    </ul>
  )
}

function IssueLink({ slug, issue }: { slug: string; issue: IssueRef }) {
  return (
    <AppLink slug={slug} href={appPath(slug, `/issues/${issue.number}`)} className="event-issue">
      <span className="state-icon" data-state={visibleState(issue)}>
        {(() => {
          const G = StatusIcon[visibleState(issue)]
          return <G size={14} />
        })()}
      </span>
      <span className="event-issue-title">{issue.title}</span> <span className="mono">#{issue.number}</span>
    </AppLink>
  )
}

const closeText: Record<CloseReason, string> = {
  completed: "closed this as completed",
  not_planned: "closed this as not planned",
  duplicate: "closed this as a duplicate",
}

function statusLine(from: IssueStatus, to: IssueStatus, reason: CloseReason | null): { text: string; tone: string } {
  if (to === "closed") {
    const r = reason ?? "completed"
    return { text: closeText[r], tone: r === "completed" ? "closed" : "not_planned" }
  }
  if (from === "closed") return { text: "reopened this", tone: "open" }
  if (to === "in_progress") return { text: "marked this as in progress", tone: "in_progress" }
  if (to === "waiting") return { text: "marked this as waiting on the reporter", tone: "waiting" }
  return { text: "moved this back to open", tone: "open" }
}

function relationText(rel: Relation, removed: boolean): string {
  const { type, direction } = rel
  if (type === "duplicate_of") {
    if (direction === "outgoing") return removed ? "unmarked this as a duplicate of" : "marked this as a duplicate of"
    return removed ? "unmarked as a duplicate of this:" : "marked as a duplicate of this:"
  }
  if (type === "blocks") {
    if (direction === "outgoing") return removed ? "removed that this blocks" : "marked this as blocking"
    return removed ? "removed that this is blocked by" : "marked this as blocked by"
  }
  return removed ? "removed the link to" : "linked this to"
}

/** What an event says (after the actor's name), its icon and its state tone. */
export function eventContent(slug: string, event: IssueEvent): { icon: ReactNode; tone?: string; body: ReactNode } {
  const d = event.data
  let icon: ReactNode = <LinkIcon size={14} />
  let tone: string | undefined
  let body: ReactNode = null

  switch (event.type) {
    case "status_changed": {
      const line = statusLine(d.from as IssueStatus, d.to as IssueStatus, (d.close_reason as CloseReason | null) ?? null)
      const G = StatusIcon[line.tone as keyof typeof StatusIcon]
      icon = <G size={14} />
      tone = line.tone
      body = line.text
      break
    }
    case "labeled":
    case "unlabeled": {
      const label = d.label as LabelType | undefined
      icon = <TagIcon size={14} />
      body = (
        <>
          {event.type === "labeled" ? "added" : "removed"} {label ? <Label name={label.name} color={label.color} /> : "a label"}
        </>
      )
      break
    }
    case "claimed":
      icon = <PersonIcon size={14} />
      body = "claimed this"
      break
    case "assigned": {
      const to = d.assignee as Actor | null
      icon = <PersonIcon size={14} />
      body = !to ? "removed the assignee" : to.id === event.actor.id ? "self-assigned this" : (
        <>
          assigned <strong>{actorName(to)}</strong>
        </>
      )
      break
    }
    case "related":
    case "unrelated": {
      const rel = d.relation as Relation | undefined
      icon = <LinkIcon size={14} />
      body = rel ? (
        <>
          {relationText(rel, event.type === "unrelated")} <IssueLink slug={slug} issue={rel.issue} />
        </>
      ) : (
        "changed a relation"
      )
      break
    }
    case "renamed":
      icon = <PencilGlyph />
      body = (
        <>
          changed the title <del>{String(d.from ?? "")}</del> <span className="event-strong">{String(d.to ?? "")}</span>
        </>
      )
      break
    default:
      body = "updated this"
  }
  return { icon, tone, body }
}

function PencilGlyph() {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.75 2.75 13.25 5.25 5.5 13H3v-2.5z" />
    </svg>
  )
}

export function EventLine({ slug, event }: { slug: string; event: IssueEvent }) {
  const { icon, tone, body } = eventContent(slug, event)
  return (
    <div className="event" data-tone={tone}>
      <span className="event-icon">{icon}</span>
      <span className="event-text">
        <ActorName actor={event.actor} badge={false} /> {body} · <Time iso={event.created_at} />
      </span>
    </div>
  )
}

/** More than two events in a row fold into one line saying who and when; it expands in place. */
export function EventBurst({ slug, events }: { slug: string; events: IssueEvent[] }) {
  const [open, setOpen] = useState(false)
  const names = [...new Set(events.map((e) => actorName(e.actor)))]
  const last = events[events.length - 1]!
  return (
    <div className="burst" data-open={open || undefined}>
      <button type="button" className="burst-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="burst-icons" aria-hidden="true">
          {events.slice(0, 3).map((e) => {
            const { icon, tone } = eventContent(slug, e)
            return (
              <span key={e.id} className="event-icon" data-tone={tone}>
                {icon}
              </span>
            )
          })}
        </span>
        <span className="burst-text">
          {events.length} updates by {names.join(", ")} · <Time iso={last.created_at} />
        </span>
        <ChevronDownIcon size={12} />
      </button>
      {open && events.map((e) => <EventLine key={e.id} slug={slug} event={e} />)}
    </div>
  )
}

/** The agent (or a member) at work, as the last line of the thread. */
export function TypingLine({ activity }: { activity: Activity | null }) {
  const live = useUntil(activity?.expires_at)
  if (!activity || !live) return null
  return (
    <div className="group typing" aria-live="polite">
      <header className="group-head">
        <span className="group-avatar">
          <ActorAvatar actor={activity.actor} size={20} />
        </span>
        <ActorName actor={activity.actor} />
        <Dots />
        {activity.text && <span className="typing-text">{activity.text}</span>}
      </header>
    </div>
  )
}
