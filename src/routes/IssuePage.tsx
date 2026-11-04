import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Link } from "wouter"
import type { Activity, Actor, AppDetail, Attachment, CloseReason, Comment, Issue, IssueStatus, LiveEvent, Relation } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { load, peek, useResource } from "../lib/cache"
import { ensureHuman } from "../lib/human"
import { appendTimeline, applyActivity, applySummary, findSummary, stateText, storeIssue, visibleState } from "../lib/issues"
import { useLive } from "../lib/live"
import { Time } from "../lib/time"
import { ActorName } from "../ui/Actor"
import { Editor } from "../ui/Editor"
import { ChevronDownIcon, PersonIcon } from "../ui/icons"
import { Menu, MenuItem } from "../ui/Menu"
import { AppLayout, ErrorPage, Page, useMe } from "../ui/Shell"
import { Button, StateIcon, StateLabel } from "../ui/primitives"
import { relationRequest, Sidebar, type IssueActions, type RelationKind } from "./issue/Sidebar"
import { ActivityRow, CommentItem, EventItem, Message } from "./issue/Timeline"
import { appPath } from "../lib/site"

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

  return (
    <Page>
      <IssueHeader app={app} issue={issue} viewers={viewers} canEdit={member || issue.viewer_is_author} />
      <div className="issue-layout">
        <div className="issue-main">
          <div className="thread">
            <IssueBodyBox app={app} issue={issue} canEdit={member || issue.viewer_is_author} />
            {issue.timeline.map((item) =>
              item.kind === "comment" ? (
                <CommentItem key={item.comment.id} slug={slug} comment={item.comment} />
              ) : (
                <EventItem key={item.event.id} slug={slug} event={item.event} />
              ),
            )}
            {viewerActor &&
              pending.map((p) => (
                <Message
                  key={p.id}
                  slug={slug}
                  author={viewerActor}
                  createdAt={new Date().toISOString()}
                  body={p.body}
                  attachments={[]}
                  byAuthor={issue.viewer_is_author}
                  pending={
                    p.error ? (
                      <span className="pending-error">
                        Not sent: {p.error}{" "}
                        <button type="button" className="link-button" onClick={() => send(p)}>
                          Retry
                        </button>{" "}
                        <button type="button" className="link-button" onClick={() => setPending((l) => l.filter((x) => x.id !== p.id))}>
                          Discard
                        </button>
                      </span>
                    ) : (
                      "Sending…"
                    )
                  }
                />
              ))}
            <ActivityRow activity={issue.activity} />
          </div>
          {actionError && (
            <p className="flash" data-tone="danger">
              {actionError}
            </p>
          )}
          <Composer
            app={app}
            issue={issue}
            onComment={postComment}
            onStatus={(status, reason) => setStatus(status, reason)}
            onDuplicate={async (other) => {
              setActionError(null)
              await addRelation("duplicate_of", other)
              await setStatus("closed", "duplicate")
            }}
          />
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
  const [title, setTitle] = useState(issue.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const next = title.trim()
    if (!next || next === issue.title) return setEditing(false)
    setSaving(true)
    setError(null)
    try {
      storeIssue(app.slug, await api.patchIssue(app.slug, issue.number, { title: next }))
      setEditing(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const comments = issue.comment_count
  return (
    <div className="issue-header">
      {editing ? (
        <form className="issue-title-form" onSubmit={save}>
          <div className="input" data-size="large" style={{ flex: 1 }}>
            <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" autoFocus maxLength={256} />
          </div>
          <Button type="submit" disabled={saving}>
            Save
          </Button>
          <Button variant="invisible" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          {error && <p className="field-error">{error}</p>}
        </form>
      ) : (
        <div className="issue-title-row">
          <h1 className="issue-heading">
            <span className="issue-heading-title">{issue.title}</span> <span className="mono issue-heading-number">#{issue.number}</span>
          </h1>
          <div className="issue-title-actions">
            {canEdit && (
              <Button
                variant="invisible"
                onClick={() => {
                  setTitle(issue.title)
                  setEditing(true)
                }}
              >
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
  const [body, setBody] = useState(issue.body)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (busy) return
    setSaving(true)
    setError(null)
    try {
      storeIssue(app.slug, await api.patchIssue(app.slug, issue.number, { body }))
      setEditing(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

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
          <Button
            size="small"
            variant="invisible"
            onClick={() => {
              setBody(issue.body)
              setEditing(true)
            }}
          >
            Edit
          </Button>
        ) : undefined
      }
    >
      {editing ? (
        <div className="msg-edit">
          <Editor
            slug={app.slug}
            value={body}
            onChange={setBody}
            member={!!app.role}
            onAttachment={() => {}}
            onBusyChange={setBusy}
            onSubmit={save}
            autoFocus
            label="Description"
            actions={
              <>
                <Button variant="invisible" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={save} disabled={saving || busy}>
                  {saving ? "Saving…" : "Save"}
                </Button>
              </>
            }
          />
          {error && <p className="field-error">{error}</p>}
        </div>
      ) : undefined}
    </Message>
  )
}

const closeOptions: { reason: CloseReason; label: string; description: string }[] = [
  { reason: "completed", label: "Close as completed", description: "Done, closed, fixed, resolved" },
  { reason: "not_planned", label: "Close as not planned", description: "Won't fix, can't reproduce, stale" },
  { reason: "duplicate", label: "Close as duplicate", description: "Duplicate of another issue" },
]

const sendKey = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘↵" : "Ctrl ↵"

/** The reply box docked under the thread, with close/reopen beside Send. */
function Composer({
  app,
  issue,
  onComment,
  onStatus,
  onDuplicate,
}: {
  app: AppDetail
  issue: Issue
  onComment: (body: string, attachmentIds: string[]) => Promise<boolean>
  onStatus: (status: IssueStatus, reason?: CloseReason) => Promise<void>
  onDuplicate: (other: number) => Promise<void>
}) {
  const member = !!app.role
  const [body, setBody] = useState("")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState<CloseReason>("completed")
  const [dupOf, setDupOf] = useState("")
  const [dupError, setDupError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const hasText = !!body.trim()

  const comment = async () => {
    if (!hasText || busy) return true
    const text = body
    const ids = attachments.filter((a) => text.includes(a.url)).map((a) => a.id)
    setBody("")
    setAttachments([])
    return onComment(text, ids)
  }

  const close = async () => {
    setDupError(null)
    if (reason === "duplicate") {
      const n = Number(dupOf.replace(/^#/, ""))
      if (!Number.isInteger(n) || n < 1) return setDupError("Enter the issue this duplicates.")
      setWorking(true)
      try {
        if (!(await comment())) return
        await onDuplicate(n)
        setDupOf("")
        setReason("completed")
      } catch (e) {
        setDupError(e instanceof Error ? e.message : "Couldn't close as duplicate.")
      } finally {
        setWorking(false)
      }
      return
    }
    if (!(await comment())) return
    onStatus("closed", reason).catch(() => {})
  }

  const reopen = async () => {
    if (!(await comment())) return
    onStatus("open").catch(() => {})
  }

  const option = closeOptions.find((o) => o.reason === reason)!
  const closeLabel = reason === "completed" ? (hasText ? "Close with comment" : "Close issue") : option.label
  const reopenLabel = hasText ? "Reopen with comment" : "Reopen issue"

  const statusControl = !member ? null : issue.status === "closed" ? (
    <Button icon={<StateIcon state="open" size={14} />} onClick={reopen} disabled={busy} aria-label={reopenLabel} title={reopenLabel}>
      <span className="close-label">{reopenLabel}</span>
    </Button>
  ) : (
    <span className="split">
      <Button
        icon={<StateIcon state={reason === "completed" ? "closed" : "not_planned"} size={14} />}
        onClick={close}
        disabled={busy || working}
        aria-label={closeLabel}
        title={hasText ? `${closeLabel} (posts your reply first)` : closeLabel}
      >
        <span className="close-label">{closeLabel}</span>
      </Button>
      <Menu
        align="end"
        width={300}
        trigger={(p) => <Button iconOnly aria-label="More close options" icon={<ChevronDownIcon size={14} />} {...p} />}
      >
        {(dismiss) =>
          closeOptions.map((o) => (
            <MenuItem
              key={o.reason}
              checked={reason === o.reason}
              description={o.description}
              onSelect={() => {
                setReason(o.reason)
                setDupError(null)
                dismiss()
              }}
            >
              {o.label}
            </MenuItem>
          ))
        }
      </Menu>
    </span>
  )

  return (
    <div className="composer">
      <Editor
        variant="chat"
        slug={app.slug}
        value={body}
        onChange={setBody}
        member={member}
        onAttachment={(a) => setAttachments((l) => [...l, a])}
        onBusyChange={setBusy}
        onSubmit={() => void comment()}
        label="Reply"
        minHeight={44}
        extra={
          member &&
          reason === "duplicate" &&
          issue.status !== "closed" && (
            <div className="dup-form">
              <label className="field-label" htmlFor="dup-of">
                Duplicate of
              </label>
              <div className="input" data-size="small">
                <span className="input-prefix mono">#</span>
                <input id="dup-of" className="mono" inputMode="numeric" value={dupOf} onChange={(e) => setDupOf(e.target.value)} placeholder="123" autoFocus />
              </div>
              {dupError && <span className="field-error">{dupError}</span>}
            </div>
          )
        }
        actions={
          <>
            {statusControl}
            <Button variant="primary" onClick={() => void comment()} disabled={!hasText || busy} trailing={<kbd className="kbd">{sendKey}</kbd>}>
              {busy ? "Uploading…" : "Send"}
            </Button>
          </>
        }
      />
    </div>
  )
}
