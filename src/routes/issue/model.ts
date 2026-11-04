import type { ReactNode } from "react"
import type { Actor, AppDetail, Approval, Attachment, CloseReason, Comment, Issue, IssueEvent, IssueStatus, Me, ModerationReason } from "../../../shared/api"
import type { IssueActions } from "./Properties"

/** Everything an issue layout needs: the data, the editors' actions and the composer's handlers. Layouts only differ in presentation. */
export interface IssueModel {
  app: AppDetail
  issue: Issue
  me: Me | undefined
  viewers: number | null
  member: boolean
  /** Members and the author may edit the title and body. */
  canEdit: boolean
  viewer: Actor | null
  actions: IssueActions
  /** Comments still on their way, each with a "Sending…" or "Not sent: … Retry · Discard" note. */
  pending: { id: string; body: string; note: ReactNode; name?: string; internal?: boolean }[]
  actionError: string | null
  /**
   * Posts a comment (or, for the team, an internal note); `guestName` goes along for guests naming themselves.
   * "name_required": the server has no name for this guest; the post is dropped so the composer can ask and resend.
   */
  onComment: (body: string, attachmentIds: string[], guestName?: string, internal?: boolean) => Promise<boolean | "name_required">
  onStatus: (status: IssueStatus, reason?: CloseReason) => Promise<void>
  onDuplicate: (other: number) => Promise<void>
  /** Team (or the reporter, when the workspace lets them choose): make the issue private or public. */
  onPrivacy: (next: boolean) => Promise<void>
  /** Team: hide with a reason, or unhide (null). */
  onHide: (reason: ModerationReason | null) => Promise<void>
  /** Admins: delete for good. */
  onDelete: () => Promise<void>
  /** "Me too": anyone (guests pass the human check). */
  onVote: (on: boolean) => Promise<void>
  /** Team: lock or unlock the conversation; pin or unpin (409 past three). Errors reach the caller. */
  onLock: (on: boolean) => Promise<void>
  onPin: (on: boolean) => Promise<void>
  /** Team: move to another workspace, then go there. */
  onTransfer: (to: string) => Promise<void>
}

export interface MessageEntry {
  kind: "message"
  key: string
  author: Actor
  createdAt: string
  body: string
  attachments: Attachment[]
  byAuthor: boolean
  note?: ReactNode
  /** The comment itself (absent while still sending), for its menu, hidden state and "edited". */
  comment?: Comment
  /** An internal note (team only). */
  internal: boolean
}

/** A hidden comment, as people outside the team see it: no author, no text. */
export interface HiddenEntry {
  kind: "hidden"
  key: string
  reason: ModerationReason
}

export interface EventEntry {
  kind: "event"
  key: string
  event: IssueEvent
}

/** Help desk team: an agent's reply held for review. */
export interface HeldEntry {
  kind: "held"
  key: string
  comment: Comment
}

/** Help desk team: an agent's approval request, in its latest state. */
export interface ApprovalEntry {
  kind: "approval"
  key: string
  approval: Approval
}

export type Entry = MessageEntry | EventEntry | HiddenEntry | HeldEntry | ApprovalEntry

/** The conversation after the report: the timeline, then comments still on their way. */
export function entries(model: IssueModel): Entry[] {
  const { issue, pending, viewer, member } = model
  // A help desk's requesters see no assignment events: who has the request stays with the team
  const deskRequester = model.app.mode === "helpdesk" && !member
  const list: Entry[] = []
  // Every approval event carries the approval's current state; the last one seen for an id is the newest
  const approvals = new Map<string, Approval>()
  for (const item of issue.timeline)
    if (item.kind === "event" && item.event.type.startsWith("approval.")) {
      const a = item.event.data.approval as Approval | undefined
      if (a) approvals.set(a.id, a)
    }
  for (const item of issue.timeline) {
    if (item.kind === "comment") {
      const c = item.comment
      // Held replies and approvals are the team's (the server sends them to nobody else)
      if (c.held) {
        if (member) list.push({ kind: "held", key: c.id, comment: c })
        continue
      }
      // Notes are the team's; the server never sends them to anyone else, and the page never shows one if it did.
      if (c.internal && !member) continue
      if (c.hidden && !member) list.push({ kind: "hidden", key: c.id, reason: c.hidden.reason })
      else
        list.push({
          kind: "message",
          key: c.id,
          author: c.author,
          createdAt: c.created_at,
          body: c.body,
          attachments: c.attachments,
          byAuthor: c.by_issue_author,
          comment: c,
          internal: !!c.internal,
        })
    } else if (deskRequester && (item.event.type === "assigned" || item.event.type === "claimed")) {
      continue
    } else if (item.event.type === "approval.requested") {
      const a = approvals.get((item.event.data.approval as Approval | undefined)?.id ?? "")
      if (member && a) list.push({ kind: "approval", key: item.event.id, approval: a })
    } else list.push({ kind: "event", key: item.event.id, event: item.event })
  }
  if (viewer)
    for (const p of pending)
      list.push({
        kind: "message",
        key: p.id,
        author: p.name && viewer.type === "guest" ? { ...viewer, name: p.name } : viewer,
        createdAt: new Date().toISOString(),
        body: p.body,
        attachments: [],
        byAuthor: issue.viewer_is_author,
        note: p.note,
        internal: !!p.internal,
      })
  return list
}

export type Block =
  | { kind: "run"; key: string; author: Actor; byAuthor: boolean; internal: boolean; messages: MessageEntry[] }
  | { kind: "events"; key: string; events: IssueEvent[] }
  | { kind: "hidden"; key: string; reason: ModerationReason }
  | HeldEntry
  | ApprovalEntry

const sameActor = (a: Actor, b: Actor) => a.type === b.type && a.id === b.id

/** Consecutive messages from one person become a run; consecutive events become one block. */
export function blocks(list: Entry[]): Block[] {
  const out: Block[] = []
  for (const e of list) {
    const last = out[out.length - 1]
    if (e.kind === "message") {
      // Notes and replies never share a run, so a note always reads as one.
      if (last?.kind === "run" && sameActor(last.author, e.author) && last.internal === e.internal) last.messages.push(e)
      else out.push({ kind: "run", key: e.key, author: e.author, byAuthor: e.byAuthor, internal: e.internal, messages: [e] })
    } else if (e.kind === "hidden" || e.kind === "held" || e.kind === "approval") out.push(e)
    else if (last?.kind === "events") last.events.push(e.event)
    else out.push({ kind: "events", key: e.key, events: [e.event] })
  }
  return out
}

/** Every file on the issue: the description's, then each comment's. */
export function allAttachments(issue: Issue): Attachment[] {
  return [...issue.attachments, ...issue.timeline.flatMap((t) => (t.kind === "comment" ? t.comment.attachments : []))]
}
