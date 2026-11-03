import type { ReactNode } from "react"
import { Link } from "wouter"
import type { Activity, Actor, Attachment, CloseReason, Comment, IssueEvent, IssueRef, IssueStatus, Label as LabelType, Relation } from "../../../shared/api"
import { Time, useUntil } from "../../lib/time"
import { formatSize } from "../../lib/upload"
import { ActorAvatar, ActorName, actorName } from "../../ui/Actor"
import { LinkIcon, PaperclipIcon, PersonIcon, StatusIcon, TagIcon, VideoIcon, ImageIcon } from "../../ui/icons"
import { Markdown } from "../../ui/Markdown"
import { Dots, Label } from "../../ui/primitives"
import { visibleState } from "../../lib/issues"
import { appPath } from "../../lib/site"

/** One message in the conversation: avatar, name, time, then the text. Agent messages sit on a faint layer. */
export function Message({
  slug,
  author,
  createdAt,
  body,
  attachments,
  byAuthor,
  verb,
  actions,
  children,
  pending,
}: {
  slug: string
  author: Actor
  createdAt: string
  body: string
  attachments: Attachment[]
  byAuthor: boolean
  verb?: string
  actions?: ReactNode
  children?: ReactNode
  pending?: ReactNode
}) {
  const loose = attachments.filter((a) => !body.includes(a.url))
  return (
    <article className="msg" data-agent={author.type === "agent" || undefined} data-pending={pending ? "" : undefined}>
      <span className="msg-avatar">
        <ActorAvatar actor={author} size={28} />
      </span>
      <div className="msg-main">
        <header className="msg-head">
          <ActorName actor={author} />
          {byAuthor && <span className="role-badge">Reporter</span>}
          {author.type === "member" && (
            <span className="role-badge" data-role="member">
              Member
            </span>
          )}
          <span className="msg-time">
            {pending ?? (
              <>
                {verb && `${verb} `}
                <Time iso={createdAt} />
              </>
            )}
          </span>
          {actions && <span className="msg-actions">{actions}</span>}
        </header>
        {children ?? (
          <div className="msg-body">
            <Markdown source={body} slug={slug} />
            {loose.length > 0 && <AttachmentList attachments={loose} />}
          </div>
        )}
      </div>
    </article>
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

export function CommentItem({ slug, comment }: { slug: string; comment: Comment }) {
  return (
    <Message
      slug={slug}
      author={comment.author}
      createdAt={comment.created_at}
      body={comment.body}
      attachments={comment.attachments}
      byAuthor={comment.by_issue_author}
    />
  )
}

function IssueLink({ slug, issue }: { slug: string; issue: IssueRef }) {
  return (
    <Link href={appPath(slug, `/issues/${issue.number}`)} className="event-issue">
      <span className="state-icon" data-state={visibleState(issue)}>
        {(() => {
          const G = StatusIcon[visibleState(issue)]
          return <G size={14} />
        })()}
      </span>
      <span className="event-issue-title">{issue.title}</span> <span className="mono">#{issue.number}</span>
    </Link>
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

export function EventItem({ slug, event }: { slug: string; event: IssueEvent }) {
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

  return (
    <div className="event" data-tone={tone}>
      <span className="event-icon">{icon}</span>
      <span className="event-text">
        <ActorName actor={event.actor} /> {body} <span className="event-time">· <Time iso={event.created_at} /></span>
      </span>
    </div>
  )
}

function PencilGlyph() {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.75 2.75 13.25 5.25 5.5 13H3v-2.5z" />
    </svg>
  )
}

/** The agent (or a member) at work, as the last line of the thread: avatar, name, typing dots and its status. */
export function ActivityRow({ activity }: { activity: Activity | null }) {
  const live = useUntil(activity?.expires_at)
  if (!activity || !live) return null
  return (
    <div className="msg typing" data-agent={activity.actor.type === "agent" || undefined} aria-live="polite">
      <span className="msg-avatar">
        <ActorAvatar actor={activity.actor} size={28} />
      </span>
      <div className="msg-main">
        <div className="msg-head">
          <ActorName actor={activity.actor} />
          <Dots />
          {activity.text && <span className="typing-text">{activity.text}</span>}
        </div>
      </div>
    </div>
  )
}
