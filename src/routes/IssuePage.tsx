import { useCallback, useEffect, useRef, useState } from "react"
import { useLocation } from "wouter"
import type { Activity, Actor, AppDetail, Comment, Issue, IssueStatus, CloseReason, LiveEvent, Me, Relation } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { load, peek, useResource } from "../lib/cache"
import { setGuestNameLocally } from "../lib/guest"
import { ensureHuman } from "../lib/human"
import {
  appendTimeline,
  applyActivity,
  applyActorUpdate,
  applySummary,
  dropIssue,
  findSummary,
  isDeleted,
  onDeleted,
  removeComment,
  removeIssue,
  replaceComment,
  storeIssue,
} from "../lib/issues"
import { useLive } from "../lib/live"
import { appPath, isAbsolute } from "../lib/site"
import { loadMarkdown } from "../ui/Markdown"
import { AppLayout, ErrorPage, Page, useMe } from "../ui/Shell"
import { IssueView } from "./issue/IssueView"
import { DeletedIssue, MovedIssue } from "./issue/Moderation"
import type { IssueModel } from "./issue/model"
import { relationRequest, type IssueActions, type RelationKind } from "./issue/Properties"

export function IssuePage({ slug, number }: { slug: string; number: number }) {
  useEffect(() => {
    void loadMarkdown()
  }, [])
  return (
    <AppLayout
      slug={slug}
      tab="issues"
      crumb={{ label: `#${number}`, href: appPath(slug, `/issues/${number}`), mono: true }}
      loading={<IssueLoading slug={slug} number={number} />}
    >
      {(app) => <IssueBody key={number} app={app} number={number} />}
    </AppLayout>
  )
}

interface Pending {
  id: string
  body: string
  attachmentIds: string[]
  /** Sent as guest_name by a guest naming themselves with this post. */
  guestName?: string
  /** A team note rather than a reply. */
  internal?: boolean
  error?: string
}

function IssueBody({ app, number }: { app: AppDetail; number: number }) {
  const slug = app.slug
  const key = keys.issue(slug, number)
  const fetcher = useCallback(() => api.issue(slug, number), [slug, number])
  const { data: issue, error } = useResource<Issue>(key, fetcher)
  const { data: me } = useMe()
  const [viewers, setViewers] = useState<number | null>(null)
  const [pending, setPending] = useState<Pending[]>([])
  const [actionError, setActionError] = useState<string | null>(null)
  const member = !!app.role
  // The room's hello can beat the first fetch; hold its activity until the issue is known.
  const helloActivity = useRef<Activity | null | undefined>(undefined)
  const issueId = issue?.id
  const [, navigate] = useLocation()
  // Deleted while open (live) or by us: say so in place of the issue.
  const [gone, setGone] = useState(() => isDeleted(slug, number))
  // Moved to another workspace while open: offer the new place rather than pulling the page away.
  const [movedTo, setMovedTo] = useState<{ slug: string; number: number; url: string } | null>(null)
  useEffect(() => onDeleted(() => setGone(isDeleted(slug, number))), [slug, number])

  useEffect(() => {
    if (issueId && helloActivity.current !== undefined) {
      applyActivity(slug, issueId, helloActivity.current)
      helloActivity.current = undefined
    }
  }, [slug, issueId])

  useLive(
    `/api/live/apps/${encodeURIComponent(slug)}/issues/${number}`,
    (event: LiveEvent) => {
      switch (event.type) {
        case "hello":
          setViewers(event.viewers)
          if (issue) applyActivity(slug, issue.id, event.activity)
          else helloActivity.current = event.activity
          break
        case "viewers":
          setViewers(event.count)
          break
        case "issue.updated":
          applySummary(slug, event.issue)
          break
        case "timeline.added":
          appendTimeline(slug, number, event.item)
          break
        case "activity":
          applyActivity(slug, event.issue_id, event.activity)
          break
        case "actor.updated":
          applyActorUpdate(slug, event.previous_id, event.actor)
          // Maybe this browser's guest, renamed in another tab: refresh who's posting (guest ids differ per app,
          // so /api/me is the way to tell).
          if (event.actor.type === "guest" && !peek<Me>(keys.me)?.user) load(keys.me, api.me).catch(() => {})
          break
        case "comment.updated":
          replaceComment(slug, event.issue_id, event.comment)
          break
        case "comment.deleted":
          removeComment(slug, event.issue_id, event.comment_id)
          break
        case "issue.deleted":
          removeIssue(slug, event.issue_id, event.number)
          break
        case "issue.moved":
          dropIssue(slug, event.issue_id, number)
          setMovedTo(event.to)
          break
      }
    },
    (reconnected) => {
      if (reconnected) load(key, fetcher).catch(() => {})
    },
  )

  if (gone || (error instanceof ApiFailure && (error.status === 410 || error.code === "deleted"))) return <DeletedIssue slug={slug} number={number} />
  if (movedTo) return <MovedIssue number={number} to={movedTo} />
  if (error instanceof ApiFailure && error.code === "moved" && error.movedTo) return <MovedIssue number={number} to={error.movedTo} redirect />
  if (!issue) {
    if (error) return <ErrorPage error={error} />
    return <IssueLoading slug={slug} number={number} />
  }

  const current = () => peek<Issue>(key) ?? issue

  const run = async (optimistic: Partial<Issue> | null, request: () => Promise<Issue>) => {
    const before = current()
    setActionError(null)
    if (optimistic) storeIssue(slug, { ...before, ...optimistic })
    try {
      storeIssue(slug, await request())
    } catch (e) {
      if (optimistic) {
        const now = current()
        const restore = Object.fromEntries(Object.keys(optimistic).map((k) => [k, before[k as keyof Issue]]))
        storeIssue(slug, { ...now, ...restore })
      }
      setActionError(errorMessage(e))
      throw e
    }
  }
  const quiet = (p: Promise<unknown>) => p.catch(() => {})

  const setStatus = (status: IssueStatus, close_reason?: CloseReason) =>
    run({ status, close_reason: status === "closed" ? (close_reason ?? "completed") : null }, () =>
      api.patchIssue(slug, number, status === "closed" ? { status, close_reason: close_reason ?? "completed" } : { status }),
    )

  const addRelation = async (kind: RelationKind, other: number) => {
    if (other === number) throw new Error("An issue can't relate to itself.")
    const { type, outgoing } = relationRequest(kind)
    try {
      if (outgoing) storeIssue(slug, await api.addRelation(slug, number, type, other))
      else {
        storeIssue(slug, await api.addRelation(slug, other, type, number))
        storeIssue(slug, await api.issue(slug, number))
      }
    } catch (e) {
      throw new Error(e instanceof ApiFailure && e.status === 404 ? `There's no issue #${other}.` : errorMessage(e))
    }
  }

  const actions: IssueActions = {
    setStatus: (s) => quiet(setStatus(s)),
    toggleLabel: (id) => {
      const now = current()
      const has = now.labels.some((l) => l.id === id)
      const labels = has ? now.labels.filter((l) => l.id !== id) : [...now.labels, ...app.labels.filter((l) => l.id === id)]
      labels.sort((a, b) => a.name.localeCompare(b.name))
      quiet(run({ labels }, () => api.patchIssue(slug, number, { label_ids: labels.map((l) => l.id) })))
    },
    assign: (actor: Actor | null) =>
      quiet(run({ assignee: actor }, () => api.patchIssue(slug, number, { assignee_id: actor ? actor.id : null }))),
    addRelation,
    removeRelation: (r: Relation) =>
      quiet(
        run({ relations: current().relations.filter((x) => x.id !== r.id) }, async () => {
          // A relation is stored on its source issue; removing it from either side works through this endpoint.
          return api.removeRelation(slug, number, r.id)
        }),
      ),
  }

  const send = async (p: Pending): Promise<boolean | "name_required"> => {
    setPending((list) => list.map((x) => (x.id === p.id ? { ...x, error: undefined } : x)))
    const guestName = p.guestName
    try {
      await ensureHuman(member)
      const comment: Comment = await api.comment(slug, number, {
        body: p.body,
        attachment_ids: p.attachmentIds.length ? p.attachmentIds : undefined,
        guest_name: guestName,
        internal: p.internal || undefined,
      })
      appendTimeline(slug, number, { kind: "comment", comment })
      setPending((list) => list.filter((x) => x.id !== p.id))
      if (guestName) setGuestNameLocally(guestName)
      return true
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "name_required") {
        // The composer asks for the name and posts again; drop this attempt rather than show an error.
        setGuestNameLocally(null)
        setPending((list) => list.filter((x) => x.id !== p.id))
        return "name_required"
      }
      setPending((list) => list.map((x) => (x.id === p.id ? { ...x, error: errorMessage(e) } : x)))
      return false
    }
  }

  const postComment = (body: string, attachmentIds: string[], guestName?: string, internal?: boolean) => {
    const p: Pending = { id: `pending-${Date.now()}`, body, attachmentIds, guestName, internal }
    setPending((list) => [...list, p])
    return send(p)
  }

  const viewerActor: Actor | null = me
    ? me.user
      ? { type: "member", id: me.user.id, name: me.user.name, avatar_url: me.user.avatar_url }
      : { type: "guest", id: me.guest.id, handle: me.guest.handle, name: me.guest.name ?? null }
    : null

  const discard = (id: string) => setPending((l) => l.filter((x) => x.id !== id))
  const model: IssueModel = {
    app,
    issue,
    me,
    viewers,
    member,
    canEdit: member || issue.viewer_is_author,
    viewer: viewerActor,
    actions,
    actionError,
    pending: pending.map((p) => ({
      id: p.id,
      body: p.body,
      name: p.guestName,
      internal: p.internal,
      note: p.error ? (
        <span className="pending-error">
          Not sent: {p.error}{" "}
          <button type="button" className="link-button" onClick={() => send(p)}>
            Retry
          </button>{" "}
          <button type="button" className="link-button" onClick={() => discard(p.id)}>
            Discard
          </button>
        </span>
      ) : (
        "Sending…"
      ),
    })),
    onComment: postComment,
    onStatus: (status, reason) => setStatus(status, reason),
    onDuplicate: async (other) => {
      setActionError(null)
      await addRelation("duplicate_of", other)
      await setStatus("closed", "duplicate")
    },
    onPrivacy: (next) => run({ private: next }, () => api.patchIssue(slug, number, { private: next })),
    onHide: (reason) => run(null, () => (reason ? api.hideIssue(slug, number, reason) : api.unhideIssue(slug, number))),
    onVote: async (on) => {
      const before = current()
      setActionError(null)
      storeIssue(slug, { ...before, viewer_voted: on, votes: Math.max(0, (before.votes ?? 0) + (on ? 1 : -1)) })
      try {
        await ensureHuman(!!me?.user)
        const r = await api.vote(slug, number, on)
        storeIssue(slug, { ...current(), ...r })
      } catch (e) {
        storeIssue(slug, { ...current(), viewer_voted: before.viewer_voted, votes: before.votes })
        setActionError(errorMessage(e))
      }
    },
    onLock: async (on) => storeIssue(slug, await api.patchIssue(slug, number, { locked: on })),
    onPin: async (on) => storeIssue(slug, await api.patchIssue(slug, number, { pinned: on })),
    onTransfer: async (to) => {
      const moved = await api.transferIssue(slug, number, to)
      dropIssue(slug, issue.id, number)
      const href = appPath(to, `/issues/${moved.number}`)
      if (isAbsolute(href)) window.location.assign(href)
      else {
        storeIssue(to, moved)
        navigate(href)
      }
    },
    onDelete: async () => {
      setActionError(null)
      try {
        await api.deleteIssue(slug, number)
      } catch (e) {
        setActionError(errorMessage(e))
        throw e
      }
      removeIssue(slug, issue.id, number)
      navigate(appPath(slug))
    },
  }

  return <IssueView model={model} />
}

function IssueLoading({ slug, number }: { slug: string; number: number }) {
  const summary = findSummary(slug, number)
  return (
    <Page>
      <div className="issue">
        <div className="issue-main">
          <header className="report">
            <div className="report-head">
              <h1 className="report-title">
                {summary ? summary.title : <span className="skeleton" style={{ width: 320, height: 20 }} />}{" "}
                <span className="mono report-number">#{number}</span>
              </h1>
            </div>
            <div className="report-body skeleton-lines">
              <span className="skeleton" style={{ width: "80%", height: 12 }} />
              <span className="skeleton" style={{ width: "60%", height: 12 }} />
            </div>
          </header>
        </div>
      </div>
    </Page>
  )
}
