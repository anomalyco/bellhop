import type { ReactNode } from "react"
import type { Actor, AppDetail, Attachment, CloseReason, Comment, Issue, IssueEvent, IssueStatus, Me, ModerationReason } from "../../../shared/api"
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
  pending: { id: string; body: string; note: ReactNode; name?: string }[]
  actionError: string | null
  /** The server asked for a guest name (400 name_required); the composer shows and focuses the field. */
  askName: boolean
  /** Posts a comment; `guestName` goes along for guests who are naming themselves. */
  onComment: (body: string, attachmentIds: string[], guestName?: string) => Promise<boolean>
  onStatus: (status: IssueStatus, reason?: CloseReason) => Promise<void>
  onDuplicate: (other: number) => Promise<void>
  /** Team (or the reporter, when the workspace lets them choose): make the issue private or public. */
  onPrivacy: (next: boolean) => Promise<void>
  /** Team: hide with a reason, or unhide (null). */
  onHide: (reason: ModerationReason | null) => Promise<void>
  /** Admins: delete for good. */
  onDelete: () => Promise<void>
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

export type Entry = MessageEntry | EventEntry | HiddenEntry

/** The conversation after the report: the timeline, then comments still on their way. */
export function entries(model: IssueModel): Entry[] {
  const { issue, pending, viewer, member } = model
  const list: Entry[] = []
  for (const item of issue.timeline) {
    if (item.kind === "comment") {
      const c = item.comment
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
        })
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
      })
  return list
}

export type Block =
  | { kind: "run"; key: string; author: Actor; byAuthor: boolean; messages: MessageEntry[] }
  | { kind: "events"; key: string; events: IssueEvent[] }
  | { kind: "hidden"; key: string; reason: ModerationReason }

const sameActor = (a: Actor, b: Actor) => a.type === b.type && a.id === b.id

/** Consecutive messages from one person become a run; consecutive events become one block. */
export function blocks(list: Entry[]): Block[] {
  const out: Block[] = []
  for (const e of list) {
    const last = out[out.length - 1]
    if (e.kind === "message") {
      if (last?.kind === "run" && sameActor(last.author, e.author)) last.messages.push(e)
      else out.push({ kind: "run", key: e.key, author: e.author, byAuthor: e.byAuthor, messages: [e] })
    } else if (e.kind === "hidden") out.push(e)
    else if (last?.kind === "events") last.events.push(e.event)
    else out.push({ kind: "events", key: e.key, events: [e.event] })
  }
  return out
}

/** Every file on the issue: the description's, then each comment's. */
export function allAttachments(issue: Issue): Attachment[] {
  return [...issue.attachments, ...issue.timeline.flatMap((t) => (t.kind === "comment" ? t.comment.attachments : []))]
}
