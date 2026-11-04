import { useCallback, useEffect, useRef, useState } from "react"
import type { Activity, Actor, AppDetail, Comment, Issue, IssueStatus, CloseReason, LiveEvent, Me, Relation } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { load, peek, setData, useResource } from "../lib/cache"
import { ensureHuman } from "../lib/human"
import { appendTimeline, applyActivity, applyActorUpdate, applySummary, findSummary, storeIssue } from "../lib/issues"
import { useLive } from "../lib/live"
import { AppLayout, ErrorPage, Page, useMe } from "../ui/Shell"
import { IssueView } from "./issue/IssueView"
import type { IssueModel } from "./issue/model"
import { relationRequest, type IssueActions, type RelationKind } from "./issue/Properties"

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
  /** Sent as guest_name by a guest naming themselves with this post. */
  guestName?: string
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
  const [askName, setAskName] = useState(false)
  const nameField = useRef<HTMLInputElement>(null)
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
        case "actor.updated":
          applyActorUpdate(slug, event.previous_id, event.actor)
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
    // A retry after "name required" picks up whatever is in the name field now.
    const guestName = nameField.current?.value.trim() || p.guestName
    try {
      await ensureHuman(member)
      const comment: Comment = await api.comment(slug, number, {
        body: p.body,
        attachment_ids: p.attachmentIds.length ? p.attachmentIds : undefined,
        guest_name: guestName,
      })
      appendTimeline(slug, number, { kind: "comment", comment })
      setPending((list) => list.filter((x) => x.id !== p.id))
      if (guestName) setData<Me>(keys.me, (m) => (m ? { ...m, guest: { ...m.guest, name: guestName } } : m))
      setAskName(false)
      return true
    } catch (e) {
      const nameRequired = e instanceof ApiFailure && e.code === "name_required"
      if (nameRequired) setAskName(true)
      const error = nameRequired ? "Add your name, then retry." : errorMessage(e)
      setPending((list) => list.map((x) => (x.id === p.id ? { ...x, error, guestName } : x)))
      return false
    }
  }

  const postComment = (body: string, attachmentIds: string[], guestName?: string) => {
    const p: Pending = { id: `pending-${Date.now()}`, body, attachmentIds, guestName }
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
    askName,
    pending: pending.map((p) => ({
      id: p.id,
      body: p.body,
      name: p.guestName,
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

  return <IssueView model={model} nameField={nameField} />
}

function IssueLoading({ app, number }: { app: AppDetail; number: number }) {
  const summary = findSummary(app.slug, number)
  return (
    <Page>
      <div className="issue">
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
    </Page>
  )
}
