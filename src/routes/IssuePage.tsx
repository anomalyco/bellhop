import { useCallback, useEffect, useRef, useState } from "react"
import { Link, useSearch } from "wouter"
import type { Activity, Actor, AppDetail, Comment, Issue, IssueStatus, CloseReason, LiveEvent, Relation } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { load, peek, useResource } from "../lib/cache"
import { ensureHuman } from "../lib/human"
import { appendTimeline, applyActivity, applySummary, findSummary, stateText, storeIssue, visibleState } from "../lib/issues"
import { useLive } from "../lib/live"
import { Time } from "../lib/time"
import { ActorName } from "../ui/Actor"
import { PersonIcon } from "../ui/icons"
import { AppLayout, ErrorPage, Page, useMe } from "../ui/Shell"
import { Button, StateLabel } from "../ui/primitives"
import { relationRequest, Sidebar, type IssueActions, type RelationKind } from "./issue/Sidebar"
import { ActivityRow, CommentItem, EventItem, Message } from "./issue/Timeline"
import { appPath } from "../lib/site"
import { CardLayout } from "./issue/CardLayout"
import { ChatLayout } from "./issue/ChatLayout"
import { Composer } from "./issue/Composer"
import { BodyForm, TitleForm } from "./issue/Editing"
import type { IssueModel } from "./issue/model"

export function IssuePage({ slug, number }: { slug: string; number: number }) {
  return (
    <AppLayout slug={slug} tab="issues">
      {(app) => <IssueBody key={number} app={app} number={number} />}
    </AppLayout>
  )
}

interface Pending {
  id: string
  body: string
  attachmentIds: string[]
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
  // Temporary: ?layout=chat or ?layout=card tries an alternative issue page; no param keeps the current one.
  const layout = new URLSearchParams(useSearch()).get("layout")
  // The room's hello can beat the first fetch; hold its activity until the issue is known.
  const helloActivity = useRef<Activity | null | undefined>(undefined)
  const issueId = issue?.id

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
      }
    },
    (reconnected) => {
      if (reconnected) load(key, fetcher).catch(() => {})
    },
  )

  if (!issue) {
    if (error) return <ErrorPage error={error} />
    return <IssueLoading app={app} number={number} />
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

  const send = async (p: Pending) => {
    setPending((list) => list.map((x) => (x.id === p.id ? { ...x, error: undefined } : x)))
    try {
      await ensureHuman(member)
      const comment: Comment = await api.comment(slug, number, {
        body: p.body,
        attachment_ids: p.attachmentIds.length ? p.attachmentIds : undefined,
      })
      appendTimeline(slug, number, { kind: "comment", comment })
      setPending((list) => list.filter((x) => x.id !== p.id))
      return true
    } catch (e) {
      setPending((list) => list.map((x) => (x.id === p.id ? { ...x, error: errorMessage(e) } : x)))
      return false
    }
  }

  const postComment = (body: string, attachmentIds: string[]) => {
    const p: Pending = { id: `pending-${Date.now()}`, body, attachmentIds }
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
  }

  if (layout === "chat") return <ChatLayout model={model} />
  if (layout === "card") return <CardLayout model={model} />
  return <ClassicLayout model={model} />
}

function ClassicLayout({ model }: { model: IssueModel }) {
  const { app, issue, me, viewers, canEdit, viewer, actions, actionError } = model
  const slug = app.slug
  return (
    <Page>
      <IssueHeader app={app} issue={issue} viewers={viewers} canEdit={canEdit} />
      <div className="issue-layout">
        <div className="issue-main">
          <div className="thread">
            <IssueBodyBox app={app} issue={issue} canEdit={canEdit} />
            {issue.timeline.map((item) =>
              item.kind === "comment" ? (
                <CommentItem key={item.comment.id} slug={slug} comment={item.comment} />
              ) : (
                <EventItem key={item.event.id} slug={slug} event={item.event} />
              ),
            )}
            {viewer &&
              model.pending.map((p) => (
                <Message
                  key={p.id}
                  slug={slug}
                  author={viewer}
                  createdAt={new Date().toISOString()}
                  body={p.body}
                  attachments={[]}
                  byAuthor={issue.viewer_is_author}
                  pending={p.note}
                />
              ))}
            <ActivityRow activity={issue.activity} />
          </div>
          {actionError && (
            <p className="flash" data-tone="danger">
              {actionError}
            </p>
          )}
          <Composer app={app} issue={issue} onComment={model.onComment} onStatus={model.onStatus} onDuplicate={model.onDuplicate} />
        </div>
        <Sidebar app={app} issue={issue} me={me} actions={actions} />
      </div>
    </Page>
  )
}

function IssueLoading({ app, number }: { app: AppDetail; number: number }) {
  const summary = findSummary(app.slug, number)
  return (
    <Page>
      <div className="issue-header">
        <h1 className="issue-heading">
          {summary ? <span className="issue-heading-title">{summary.title}</span> : <span className="skeleton" style={{ width: 320, height: 20 }} />}{" "}
          <span className="mono issue-heading-number">#{number}</span>
        </h1>
        <div className="issue-state-row">
          {summary ? <StateLabel state={visibleState(summary)} text={stateText(summary)} /> : <span className="skeleton" style={{ width: 80, height: 24, borderRadius: 12 }} />}
        </div>
      </div>
      <div className="issue-layout">
        <div className="issue-main">
          <div className="thread">
            <div className="msg">
              <span className="msg-avatar">
                <span className="skeleton" style={{ width: 28, height: 28, borderRadius: 14 }} />
              </span>
              <div className="msg-main skeleton-lines">
                <span className="skeleton" style={{ width: 160, height: 12 }} />
                <span className="skeleton" style={{ width: "80%", height: 12 }} />
                <span className="skeleton" style={{ width: "60%", height: 12 }} />
              </div>
            </div>
          </div>
        </div>
        <aside className="issue-sidebar" />
      </div>
    </Page>
  )
}

function IssueHeader({ app, issue, viewers, canEdit }: { app: AppDetail; issue: Issue; viewers: number | null; canEdit: boolean }) {
  const [editing, setEditing] = useState(false)
  const comments = issue.comment_count
  return (
    <div className="issue-header">
      {editing ? (
        <TitleForm app={app} issue={issue} onDone={() => setEditing(false)} />
      ) : (
        <div className="issue-title-row">
          <h1 className="issue-heading">
            <span className="issue-heading-title">{issue.title}</span> <span className="mono issue-heading-number">#{issue.number}</span>
          </h1>
          <div className="issue-title-actions">
            {canEdit && (
              <Button variant="invisible" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            <Link href={appPath(app.slug, "/new")} className="btn issue-new-link" data-variant="default">
              New issue
            </Link>
          </div>
        </div>
      )}
      <div className="issue-state-row">
        <StateLabel state={visibleState(issue)} text={stateText(issue)} />
        <span className="issue-state-meta">
          <ActorName actor={issue.author} badge={false} /> opened this <Time iso={issue.created_at} /> · {comments}{" "}
          {comments === 1 ? "comment" : "comments"}
          {viewers !== null && viewers > 0 && (
            <span className="viewers" title="People on this page now">
              {" "}
              · <PersonIcon size={14} /> {viewers} viewing
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

function IssueBodyBox({ app, issue, canEdit }: { app: AppDetail; issue: Issue; canEdit: boolean }) {
  const [editing, setEditing] = useState(false)
  return (
    <Message
      slug={app.slug}
      author={issue.author}
      createdAt={issue.created_at}
      body={issue.body}
      attachments={issue.attachments}
      byAuthor
      verb="opened"
      actions={
        canEdit && !editing ? (
          <Button size="small" variant="invisible" onClick={() => setEditing(true)}>
            Edit
          </Button>
        ) : undefined
      }
    >
      {editing ? <BodyForm app={app} issue={issue} onDone={() => setEditing(false)} /> : undefined}
    </Message>
  )
}
