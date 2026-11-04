import type { ReactNode } from "react"
import type { Actor, AppDetail, Attachment, CloseReason, Issue, IssueEvent, IssueStatus, Me } from "../../../shared/api"
import type { IssueActions } from "./Sidebar"

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
  pending: { id: string; body: string; note: ReactNode }[]
  actionError: string | null
  onComment: (body: string, attachmentIds: string[]) => Promise<boolean>
  onStatus: (status: IssueStatus, reason?: CloseReason) => Promise<void>
  onDuplicate: (other: number) => Promise<void>
}

export interface MessageEntry {
  kind: "message"
  key: string
  author: Actor
  createdAt: string
  body: string
  attachments: Attachment[]
  byAuthor: boolean
  /** The issue's own description. */
  opener?: boolean
  note?: ReactNode
}

export interface EventEntry {
  kind: "event"
  key: string
  event: IssueEvent
}

export type Entry = MessageEntry | EventEntry

/** The conversation in order: optionally the description first, then the timeline, then pending comments. */
export function entries(model: IssueModel, withOpener: boolean): Entry[] {
  const { issue, pending, viewer } = model
  const list: Entry[] = []
  if (withOpener)
    list.push({
      kind: "message",
      key: "opener",
      author: issue.author,
      createdAt: issue.created_at,
      body: issue.body,
      attachments: issue.attachments,
      byAuthor: true,
      opener: true,
    })
  for (const item of issue.timeline) {
    if (item.kind === "comment") {
      const c = item.comment
      list.push({ kind: "message", key: c.id, author: c.author, createdAt: c.created_at, body: c.body, attachments: c.attachments, byAuthor: c.by_issue_author })
    } else list.push({ kind: "event", key: item.event.id, event: item.event })
  }
  if (viewer)
    for (const p of pending)
      list.push({ kind: "message", key: p.id, author: viewer, createdAt: new Date().toISOString(), body: p.body, attachments: [], byAuthor: issue.viewer_is_author, note: p.note })
  return list
}

export type Block =
  | { kind: "run"; key: string; author: Actor; byAuthor: boolean; messages: MessageEntry[] }
  | { kind: "events"; key: string; events: IssueEvent[] }

const sameActor = (a: Actor, b: Actor) => a.type === b.type && a.id === b.id

/** Consecutive messages from one person become a run; consecutive events become one block. */
export function blocks(list: Entry[]): Block[] {
  const out: Block[] = []
  for (const e of list) {
    const last = out[out.length - 1]
    if (e.kind === "message") {
      if (last?.kind === "run" && sameActor(last.author, e.author)) last.messages.push(e)
      else out.push({ kind: "run", key: e.key, author: e.author, byAuthor: e.byAuthor, messages: [e] })
    } else if (last?.kind === "events") last.events.push(e.event)
    else out.push({ kind: "events", key: e.key, events: [e.event] })
  }
  return out
}

/** Every file on the issue: the description's, then each comment's. */
export function allAttachments(issue: Issue): Attachment[] {
  return [...issue.attachments, ...issue.timeline.flatMap((t) => (t.kind === "comment" ? t.comment.attachments : []))]
}

/** Uploaded images and videos shown inline get the full message width. */
export function hasMedia(body: string, attachments: Attachment[]) {
  return attachments.some((a) => a.kind !== "file" && body.includes(a.url)) || /\/media\/\S+\.(mp4|m4v|webm|mov|ogv|png|jpe?g|gif|webp)\b/i.test(body)
}
