import { useState, type ReactNode } from "react"
import type { Activity, Actor, ActorTier, Attachment, CloseReason, IssueEvent, IssueRef, IssueStatus, Label as LabelType, ModerationReason, Relation } from "../../../shared/api"
import { visibleState } from "../../lib/issues"
import { appPath } from "../../lib/site"
import { Time, useUntil } from "../../lib/time"
import { formatSize } from "../../lib/upload"
import { ActorAvatar, ActorName, TierBadge, actorName } from "../../ui/Actor"
import {
  ArrowUpIcon,
  ChevronDownIcon,
  CommentIcon,
  EyeOffIcon,
  ImageIcon,
  LinkIcon,
  LockIcon,
  PaperclipIcon,
  PersonIcon,
  PinIcon,
  StatusIcon,
  TagIcon,
  VideoIcon,
} from "../../ui/icons"
import { Markdown } from "../../ui/Markdown"
import { Dots, Label } from "../../ui/primitives"
import { AppLink } from "../../ui/SiteLink"
import type { MessageEntry } from "./model"
import { CommentBody, reasonText, type CommentContext } from "./Moderation"
import { DiagnosticsChip } from "../../ui/features/Diagnostics"
import { arrivalRef } from "../../lib/motion"

/** Consecutive messages from one person under one name. The reporter's avatar gets a thin ring instead of a badge. */
export function MessageGroup({
  slug,
  author,
  byAuthor,
  messages,
  ctx,
  internal,
}: {
  slug: string
  author: Actor
  byAuthor: boolean
  messages: MessageEntry[]
  ctx: CommentContext
  internal?: boolean
}) {
  return (
    <section className="group" data-internal={internal || undefined} data-key={`group:${messages[0]!.key}`} ref={arrivalRef(messages[0]!.key)}>
      <header className="group-head">
        <span className="group-avatar" data-reporter={byAuthor || undefined} title={byAuthor ? `${actorName(author)} opened this issue` : undefined}>
          <ActorAvatar actor={author} size={20} />
        </span>
        <ActorName actor={author} />
        <span className="group-time">
          <Time iso={messages[0]!.createdAt} />
        </span>
        {messages[0]!.comment?.via === "email" && <ViaEmail />}
        {internal && (
          <span className="note-label">
            Internal note<span className="note-label-more"> · only the team and agents see this</span>
          </span>
        )}
      </header>
      {messages.map((m, i) => {
        // Report metadata on this comment: a Diagnostics chip instead of its logs as loose files.
        const diagnostics = m.comment ? ctx.issue.metadata?.find((d) => d.attached_to?.comment_id === m.comment!.id) : undefined
        const logs = new Set(diagnostics?.logs.map((l) => l.id))
        const loose = m.attachments.filter((a) => !m.body.includes(a.url) && !logs.has(a.id))
        const content = (
          <>
            {i > 0 && m.comment?.via === "email" && <ViaEmail />}
            <Markdown source={m.body} slug={slug} mentions={m.comment?.mentions} />
            {loose.length > 0 && <AttachmentList attachments={loose} />}
            {diagnostics && <DiagnosticsChip metadata={diagnostics} />}
          </>
        )
        return (
          <div key={m.key} className="group-msg" data-pending={m.note ? "" : undefined} data-key={m.key} ref={i > 0 ? arrivalRef(m.key) : undefined}>
            {m.comment ? (
              <CommentBody ctx={ctx} comment={m.comment}>
                {content}
              </CommentBody>
            ) : (
              content
            )}
            {m.note && <div className="group-note">{m.note}</div>}
          </div>
        )
      })}
    </section>
  )
}

/** Written by replying to a notification email. */
function ViaEmail() {
  return (
    <span className="via-email" title="Posted by replying to an email">
      via email
    </span>
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
    case "hidden":
      icon = <EyeOffIcon size={14} />
      body = `hid ${d.comment_id ? "a comment" : "this"} as ${reasonText[d.reason as ModerationReason] ?? "spam"}`
      break
    case "unhidden":
      icon = <EyeOffIcon size={14} />
      body = d.comment_id ? "unhid a comment" : "unhid this"
      break
    case "made_private":
      icon = <LockIcon size={14} />
      body = "made this private"
      break
    case "made_public":
      icon = <LockIcon size={14} />
      body = "made this public"
      break
    case "locked":
      icon = <CommentIcon size={14} />
      body = "locked the conversation to the team"
      break
    case "unlocked":
      icon = <CommentIcon size={14} />
      body = "unlocked the conversation"
      break
    case "pinned":
      icon = <PinIcon size={14} />
      body = "pinned this"
      break
    case "unpinned":
      icon = <PinIcon size={14} />
      body = "unpinned this"
      break
    case "transferred": {
      const from = d.from as { slug?: string; number?: number } | undefined
      icon = <ArrowUpIcon size={14} style={{ transform: "rotate(90deg)" }} />
      body = from?.slug ? (
        <>
          moved this from <span className="mono">{from.slug}</span> #{from.number}
        </>
      ) : (
        "moved this here from another workspace"
      )
      break
    }
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

/** A tier rule's own doing ("VIP rule added bug"): team-only events whose data names the tier. */
const ruleOf = (event: IssueEvent) => (event.data.rule as { tier_id: string; tier_name: string } | undefined) ?? null

export function EventLine({ slug, event, authorTier }: { slug: string; event: IssueEvent; authorTier?: ActorTier | null }) {
  const { icon, tone, body } = eventContent(slug, event)
  const rule = ruleOf(event)
  // The rule's tier is the reporter's (it fired when they opened the issue); its colour comes from there when it
  // still matches, otherwise the badge stays neutral.
  const color = rule && authorTier?.id === rule.tier_id ? authorTier.color : "878d96"
  return (
    <div className="event" data-tone={tone} data-rule={rule ? "" : undefined} data-key={event.id} ref={arrivalRef(event.id)}>
      <span className="event-icon">{icon}</span>
      <span className="event-text">
        {rule ? (
          <>
            <TierBadge tier={{ name: rule.tier_name, color }} /> rule {body}
          </>
        ) : (
          <>
            <ActorName actor={event.actor} badge={false} /> {body}
          </>
        )}{" "}
        · <Time iso={event.created_at} />
      </span>
    </div>
  )
}

/** More than two events in a row fold into one line saying who and when; it expands in place. */
export function EventBurst({ slug, events, authorTier }: { slug: string; events: IssueEvent[]; authorTier?: ActorTier | null }) {
  const [open, setOpen] = useState(false)
  const names = [...new Set(events.map((e) => (ruleOf(e) ? `${ruleOf(e)!.tier_name} rule` : actorName(e.actor))))]
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
      {open && events.map((e) => <EventLine key={e.id} slug={slug} event={e} authorTier={authorTier} />)}
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
