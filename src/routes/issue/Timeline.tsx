import { useState, type ReactNode } from "react"
import type { Activity, Actor, ActorTier, Approval, Attachment, CloseReason, IssueEvent, IssueRef, IssueStatus, Label as LabelType, ModerationReason, Relation } from "../../../shared/api"
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
import { t, tr, useT } from "../../i18n/core"
import { formatList } from "../../i18n"
import { useVerifiedSentence } from "../../ui/helpdesk/Requester"
import { tr as trd, useT as useDeskT } from "../../i18n/helpdesk"
import { CheckIcon } from "../../ui/icons"
import { useRoutedSentence } from "../../ui/helpdesk/RequestDetails"
import { SentBy } from "../../ui/helpdesk/Review"
import { decision } from "../../lib/approvals"
import { handoffSentence } from "../../ui/helpdesk/Handoff"

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
        <span className="group-avatar" data-reporter={byAuthor || undefined} title={byAuthor ? t("group.reporter", { name: actorName(author) }) : undefined}>
          <ActorAvatar actor={author} size={20} />
        </span>
        <ActorName actor={author} />
        <span className="group-time">
          <Time iso={messages[0]!.createdAt} />
        </span>
        {messages[0]!.comment?.via === "email" && <ViaEmail />}
        {internal && (
          <span className="note-label">
            {t("note.label")}
            <span className="note-label-more">{t("note.more")}</span>
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
            {ctx.member && m.comment?.sent_by && <SentBy comment={m.comment} />}
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

type Sentence = (actor: ReactNode) => ReactNode

function statusLine(from: IssueStatus, to: IssueStatus, reason: CloseReason | null): { key: PlainEventKey; tone: string } {
  if (to === "closed") {
    const r = reason ?? "completed"
    return { key: r === "completed" ? "event.closedCompleted" : r === "not_planned" ? "event.closedNotPlanned" : "event.closedDuplicate", tone: r === "completed" ? "closed" : "not_planned" }
  }
  if (from === "closed") return { key: "event.reopened", tone: "open" }
  if (to === "in_progress") return { key: "event.inProgress", tone: "in_progress" }
  if (to === "waiting") return { key: "event.waiting", tone: "waiting" }
  return { key: "event.backToOpen", tone: "open" }
}

/** Sentences whose only placeholder is {actor}. */
type PlainEventKey =
  | "event.closedCompleted"
  | "event.closedNotPlanned"
  | "event.closedDuplicate"
  | "event.reopened"
  | "event.inProgress"
  | "event.waiting"
  | "event.backToOpen"
  | "event.labeledUnknown"
  | "event.unlabeledUnknown"
  | "event.claimed"
  | "event.unassigned"
  | "event.selfAssigned"
  | "event.relationChanged"
  | "event.unhidComment"
  | "event.unhid"
  | "event.madePrivate"
  | "event.madePublic"
  | "event.locked"
  | "event.unlocked"
  | "event.pinned"
  | "event.unpinned"
  | "event.movedHere"
  | "event.updated"
const plain =
  (key: PlainEventKey): Sentence =>
  (actor) =>
    tr(key, { actor })

function relationKey(rel: Relation, removed: boolean) {
  const { type, direction } = rel
  if (type === "duplicate_of") {
    if (direction === "outgoing") return removed ? "event.undupOf" : "event.dupOf"
    return removed ? "event.undupBy" : "event.dupBy"
  }
  if (type === "blocks") {
    if (direction === "outgoing") return removed ? "event.unblocks" : "event.blocks"
    return removed ? "event.unblockedBy" : "event.blockedBy"
  }
  return removed ? "event.unlinked" : "event.linked"
}

/** What an event says, as a sentence around its actor (word order is the language's), its icon and its tone. */
export function eventContent(
  slug: string,
  event: IssueEvent,
  verified?: (id: unknown) => Sentence,
  routed?: (event: IssueEvent) => Sentence,
): { icon: ReactNode; tone?: string; say: Sentence } {
  const d = event.data
  let icon: ReactNode = <LinkIcon size={14} />
  let tone: string | undefined
  let say: Sentence = plain("event.updated")

  switch (event.type) {
    case "status_changed": {
      const line = statusLine(d.from as IssueStatus, d.to as IssueStatus, (d.close_reason as CloseReason | null) ?? null)
      const G = StatusIcon[line.tone as keyof typeof StatusIcon]
      icon = <G size={14} />
      tone = line.tone
      say = plain(line.key)
      break
    }
    case "labeled":
    case "unlabeled": {
      const label = d.label as LabelType | undefined
      icon = <TagIcon size={14} />
      say = label
        ? (actor) => tr(event.type === "labeled" ? "event.labeled" : "event.unlabeled", { actor, label: <Label name={label.name} color={label.color} /> })
        : plain(event.type === "labeled" ? "event.labeledUnknown" : "event.unlabeledUnknown")
      break
    }
    case "claimed":
      icon = <PersonIcon size={14} />
      say = plain("event.claimed")
      break
    case "assigned": {
      const to = d.assignee as Actor | null
      icon = <PersonIcon size={14} />
      say = !to
        ? plain("event.unassigned")
        : to.id === event.actor?.id
          ? plain("event.selfAssigned")
          : (actor) => tr("event.assigned", { actor, assignee: <strong>{actorName(to)}</strong> })
      break
    }
    case "related":
    case "unrelated": {
      const rel = d.relation as Relation | undefined
      icon = <LinkIcon size={14} />
      say = rel ? (actor) => tr(relationKey(rel, event.type === "unrelated"), { actor, issue: <IssueLink slug={slug} issue={rel.issue} /> }) : plain("event.relationChanged")
      break
    }
    case "renamed":
      icon = <PencilGlyph />
      say = (actor) =>
        tr("event.renamed", { actor, from: <del>{String(d.from ?? "")}</del>, to: <span className="event-strong">{String(d.to ?? "")}</span> })
      break
    case "hidden":
      icon = <EyeOffIcon size={14} />
      say = (actor) => tr(d.comment_id ? "event.hidComment" : "event.hid", { actor, reason: reasonText[d.reason as ModerationReason] ?? reasonText.spam })
      break
    case "unhidden":
      icon = <EyeOffIcon size={14} />
      say = plain(d.comment_id ? "event.unhidComment" : "event.unhid")
      break
    case "made_private":
      icon = <LockIcon size={14} />
      say = plain("event.madePrivate")
      break
    case "made_public":
      icon = <LockIcon size={14} />
      say = plain("event.madePublic")
      break
    case "locked":
      icon = <CommentIcon size={14} />
      say = plain("event.locked")
      break
    case "unlocked":
      icon = <CommentIcon size={14} />
      say = plain("event.unlocked")
      break
    case "pinned":
      icon = <PinIcon size={14} />
      say = plain("event.pinned")
      break
    case "unpinned":
      icon = <PinIcon size={14} />
      say = plain("event.unpinned")
      break
    case "verified":
      icon = <CheckIcon size={14} />
      tone = "closed"
      if (verified) say = verified(d.verification_id)
      break
    case "approval.decided": {
      const a = d.approval as Approval | undefined
      const verdict = a ? decision(a) : null
      icon = <CheckIcon size={14} />
      tone = verdict === "approved" ? "closed" : undefined
      if (a && verdict) say = (actor) => trd(verdict === "approved" ? "event.approvalApproved" : "event.approvalRejected", { actor, action: <code className="approval-action">{a.action}</code> })
      break
    }
    case "escalated":
    case "handed_back":
    case "reassigned": {
      icon = <PersonIcon size={14} />
      tone = event.type === "escalated" ? "in_progress" : undefined
      const sentence = handoffSentence(event)
      if (sentence) say = sentence
      break
    }
    case "routed":
      icon = <TagIcon size={14} />
      if (routed) say = routed(event)
      break
    case "transferred": {
      const from = d.from as { slug?: string; number?: number } | undefined
      icon = <ArrowUpIcon size={14} style={{ transform: "rotate(90deg)" }} />
      say = from?.slug
        ? (actor) =>
            tr("event.movedFrom", {
              actor,
              place: (
                <>
                  <span className="mono">{from.slug}</span> #{from.number}
                </>
              ),
            })
        : plain("event.movedHere")
      break
    }
  }
  return { icon, tone, say }
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
  useT()
  useDeskT()
  const { icon, tone, say } = eventContent(slug, event, useVerifiedSentence(), useRoutedSentence())
  const rule = ruleOf(event)
  // The rule's tier is the reporter's (it fired when they opened the issue); its colour comes from there when it
  // still matches, otherwise the badge stays neutral.
  const color = rule && authorTier?.id === rule.tier_id ? authorTier.color : "878d96"
  return (
    <div className="event" data-tone={tone} data-rule={rule ? "" : undefined} data-key={event.id} ref={arrivalRef(event.id)}>
      <span className="event-icon">{icon}</span>
      <span className="event-text">
        {say(rule ? tr("event.rule", { tier: <TierBadge tier={{ name: rule.tier_name, color }} /> }) : event.actor && <ActorName actor={event.actor} badge={false} />)} ·{" "}
        <Time iso={event.created_at} />
      </span>
    </div>
  )
}

/** More than two events in a row fold into one line saying who and when; it expands in place. */
export function EventBurst({ slug, events, authorTier }: { slug: string; events: IssueEvent[]; authorTier?: ActorTier | null }) {
  useT()
  const [open, setOpen] = useState(false)
  const names = [...new Set(events.flatMap((e) => ruleOf(e) ? [t("event.rule", { tier: ruleOf(e)!.tier_name })] : e.actor ? [actorName(e.actor)] : []))]
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
          {t("event.burst", { count: events.length, names: formatList(names) })} · <Time iso={last.created_at} />
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
