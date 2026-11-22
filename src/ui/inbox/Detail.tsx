import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react"
import type { Actor, AppDetail, Comment, Issue, IssueRef, IssueStatus, LiveEvent, Me } from "../../../shared/api"
import { t as tc } from "../../i18n/core"
import { useT } from "../../i18n/inbox"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { peek, useResource } from "../../lib/cache"
import { appendTimeline, applyActivity, removeComment, replaceComment, storeIssue, summaryOf, visibleState } from "../../lib/issues"
import { applyInboxSummary } from "../../lib/inbox"
import { useLive } from "../../lib/live"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { blocks, entries, type IssueModel } from "../../routes/issue/model"
import type { IssueActions } from "../../routes/issue/Properties"
import { AssignMenu, LabelMenu, StatusMenu } from "../../routes/issue/Properties"
import { AttachmentList, EventBurst, EventLine, MessageGroup } from "../../routes/issue/Timeline"
import { HiddenLine, type CommentContext } from "../../routes/issue/Moderation"
import { ApprovalCard, HeldReply } from "../helpdesk/Review"
import { ActorAvatar, actorName } from "../Actor"
import { Editor } from "../Editor"
import { ArrowUpIcon, ChevronDownIcon, PersonIcon, TagIcon, XIcon } from "../icons"
import { Markdown } from "../Markdown"
import { AppIcon, Button, Label, StateIcon } from "../primitives"
import { useApp, useMe } from "../Shell"
import { AppLink } from "../SiteLink"
import { EmailState, Facts, FbSection, Gallery, Metadata, SameInstall, screenshotsOf } from "./Feedback"
import "../../styles/inbox.css"

/** What the page's keyboard shortcuts ask of the open feedback. */
export interface DetailHandle {
  toggleClosed(): void
  openLabels(): void
  openAssignee(): void
  compose(mode: "reply" | "note"): void
}

/**
 * The open feedback, beside the list (wide screens) or as the whole screen (phones): its app and number, the
 * controls, the message, screenshots, app and device facts, metadata, other reports from the same install, whether
 * replies reach the sender, the conversation and a composer for replies and internal notes.
 */
export function InboxDetail({
  org,
  slug,
  number,
  handle,
  onBack,
  onStep,
  onFilter,
  onOpenRef,
  onClosedChange,
  wide,
}: {
  org: string
  slug: string
  number: number
  handle: Ref<DetailHandle>
  onBack: () => void
  onStep?: (by: 1 | -1) => void
  onFilter: (key: string, value: string) => void
  onOpenRef: (slug: string, ref: IssueRef) => void
  onClosedChange: (issue: Issue) => void
  wide: boolean
}) {
  const t = useT()
  const { data: app, error: appError } = useApp(slug)
  const key = keys.issue(slug, number)
  const fetcher = useCallback(() => api.issue(slug, number), [slug, number])
  const { data: issue, error } = useResource<Issue>(key, fetcher)
  const pane = useRef<HTMLDivElement>(null)

  // The open issue's own room: replies, notes and changes from anyone else land here as they happen
  useLive(
    `/api/live/apps/${encodeURIComponent(slug)}/issues/${number}`,
    (event: LiveEvent) => {
      if (event.type === "timeline.added") appendTimeline(slug, number, event.item)
      else if (event.type === "comment.updated") replaceComment(slug, event.issue_id, event.comment)
      else if (event.type === "comment.deleted") removeComment(slug, event.issue_id, event.comment_id)
      else if (event.type === "activity") applyActivity(slug, event.issue_id, event.activity)
      else if (event.type === "issue.updated") {
        const now = peek<Issue>(key)
        if (now) storeIssue(slug, { ...now, ...event.issue })
        applyInboxSummary(org, event.issue)
      }
    },
  )

  // A new feedback starts at its top
  useEffect(() => {
    pane.current?.scrollTo({ top: 0 })
  }, [slug, number])

  const failure = error ?? appError
  return (
    <article className="inbox-detail" ref={pane} aria-busy={!issue || !app || undefined} aria-label={issue?.title}>
      <div className="inbox-detail-bar">
        <button type="button" className="btn inbox-detail-back" data-variant="ghost-muted" data-size="small" onClick={onBack} aria-label={t("detail.back")} title={t("detail.back")}>
          {wide ? <XIcon size={14} /> : <ChevronDownIcon size={14} />}
          {!wide && <span>{t("detail.back")}</span>}
        </button>
        {app && (
          <span className="inbox-detail-where">
            <AppIcon src={app.icon_url} size={16} name={app.name} />
            <span className="inbox-detail-app">{app.name}</span>
            <span className="mono inbox-detail-number">#{number}</span>
          </span>
        )}
        <span className="spacer" />
        {onStep && (
          <span className="inbox-detail-steps">
            <Button iconOnly size="small" variant="ghost-muted" icon={<ArrowUpIcon size={14} />} aria-label={t("detail.prev")} title={`${t("detail.prev")} (k)`} onClick={() => onStep(-1)} />
            <Button
              iconOnly
              size="small"
              variant="ghost-muted"
              icon={<ArrowUpIcon size={14} style={{ transform: "rotate(180deg)" }} />}
              aria-label={t("detail.next")}
              title={`${t("detail.next")} (j)`}
              onClick={() => onStep(1)}
            />
          </span>
        )}
        {app && (
          <AppLink slug={slug} href={appPath(slug, `/issues/${number}`)} className="btn inbox-detail-open" data-variant="default" data-size="small">
            {t("detail.openIn", { app: app.name })}
          </AppLink>
        )}
      </div>
      {failure && !issue ? (
        <p className="inbox-detail-error">{t("detail.loadError", { error: errorMessage(failure) })}</p>
      ) : !issue || !app ? (
        <DetailSkeleton />
      ) : (
        <DetailBody key={issue.id} org={org} app={app} issue={issue} handle={handle} onFilter={onFilter} onOpenRef={onOpenRef} onClosedChange={onClosedChange} />
      )}
    </article>
  )
}

function DetailSkeleton() {
  return (
    <div className="inbox-detail-body" aria-hidden="true">
      <span className="skeleton" style={{ width: "60%", height: 22 }} />
      <span className="skeleton" style={{ width: 220, height: 12, marginTop: 10 }} />
      <span className="skeleton" style={{ width: "100%", height: 84, marginTop: 24 }} />
    </div>
  )
}

function DetailBody({
  org,
  app,
  issue,
  handle,
  onFilter,
  onOpenRef,
  onClosedChange,
}: {
  org: string
  app: AppDetail
  issue: Issue
  handle: Ref<DetailHandle>
  onFilter: (key: string, value: string) => void
  onOpenRef: (slug: string, ref: IssueRef) => void
  onClosedChange: (issue: Issue) => void
}) {
  const t = useT()
  const slug = app.slug
  const number = issue.number
  const key = keys.issue(slug, number)
  const { data: me } = useMe()
  const [actionError, setActionError] = useState<string | null>(null)
  const [mode, setMode] = useState<"reply" | "note">("reply")
  const [body, setBody] = useState("")
  const [attachments, setAttachments] = useState<string[]>([])
  const [uploading, setUploading] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const composer = useRef<HTMLDivElement>(null)
  const controls = useRef<HTMLDivElement>(null)
  const fb = issue.feedback
  const member = !!app.role

  const current = () => peek<Issue>(key) ?? issue
  const run = async (optimistic: Partial<Issue>, request: () => Promise<Issue>) => {
    const before = current()
    setActionError(null)
    storeIssue(slug, { ...before, ...optimistic })
    applyInboxSummary(org, { id: issue.id, ...optimistic })
    try {
      const next = await request()
      storeIssue(slug, next)
      applyInboxSummary(org, summaryOf(next))
      return next
    } catch (e) {
      const restore = Object.fromEntries(Object.keys(optimistic).map((k) => [k, before[k as keyof Issue]])) as Partial<Issue>
      storeIssue(slug, { ...current(), ...restore })
      applyInboxSummary(org, { id: issue.id, ...restore })
      setActionError(errorMessage(e))
      return null
    }
  }
  const setStatus = async (status: IssueStatus) => {
    const next = await run(
      { status, close_reason: status === "closed" ? "completed" : null },
      () => api.patchIssue(slug, number, status === "closed" ? { status, close_reason: "completed" } : { status }),
    )
    if (next && (status === "closed") !== (issue.status === "closed")) onClosedChange(next)
  }
  const actions: IssueActions = {
    setStatus: (s) => void setStatus(s),
    toggleLabel: (id) => {
      const now = current()
      const labels = now.labels.some((l) => l.id === id) ? now.labels.filter((l) => l.id !== id) : [...now.labels, ...app.labels.filter((l) => l.id === id)]
      labels.sort((a, b) => a.name.localeCompare(b.name))
      void run({ labels }, () => api.patchIssue(slug, number, { label_ids: labels.map((l) => l.id) }))
    },
    assign: (actor: Actor | null) => void run({ assignee: actor }, () => api.patchIssue(slug, number, { assignee_id: actor ? actor.id : null })),
    addRelation: async () => {},
    removeRelation: () => {},
  }

  const focusComposer = (m: "reply" | "note") => {
    setMode(m)
    requestAnimationFrame(() => {
      composer.current?.scrollIntoView({ block: "nearest" })
      composer.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus()
    })
  }
  const clickControl = (name: string) => controls.current?.querySelector<HTMLElement>(`[data-control=${name}]`)?.click()
  useImperativeHandle(handle, () => ({
    toggleClosed: () => void setStatus(current().status === "closed" ? "open" : "closed"),
    openLabels: () => clickControl("labels"),
    openAssignee: () => clickControl("assignee"),
    compose: focusComposer,
  }))

  const send = async () => {
    const text = body.trim()
    if ((!text && !attachments.length) || sending || uploading) return
    setSending(true)
    setSendError(null)
    try {
      const comment: Comment = await api.comment(slug, number, { body: text, attachment_ids: attachments.length ? attachments : undefined, internal: mode === "note" || undefined })
      appendTimeline(slug, number, { kind: "comment", comment })
      setBody("")
      setAttachments([])
    } catch (e) {
      setSendError(e instanceof ApiFailure ? e.message : errorMessage(e))
    } finally {
      setSending(false)
    }
  }

  // The thread, rendered as on the issue page
  const viewer: Actor | null = me?.user ? { type: "member", id: me.user.id, name: me.user.name, avatar_url: me.user.avatar_url } : null
  const model = threadModel(app, issue, me, viewer, actions)
  const ctx: CommentContext = { app, issue, member, viewerId: viewer?.id ?? null, signedIn: !!me?.user }
  const thread = blocks(entries(model))
  const shots = fb ? screenshotsOf(fb, issue.attachments) : []
  const shotIds = new Set(shots.map((s) => s.id))
  // Logs and other files the form sent, as file chips (screenshots are in the gallery)
  const files = issue.attachments.filter((a) => !shotIds.has(a.id) && !issue.body.includes(a.url))
  const closed = issue.status === "closed"
  const author = fb?.anonymous ? t("row.anon") : fb?.user?.name || actorName(issue.author)
  const replyHint = !fb
    ? null
    : fb.anonymous
      ? t("composer.toAnonymous")
      : !fb.email
        ? t("composer.toNobody")
        : fb.email.confirmed
          ? t("composer.toConfirmed", { email: fb.email.address })
          : t("composer.toWaiting", { email: fb.email.address })

  return (
    <div className="inbox-detail-body">
      <h1 className="inbox-detail-title">{issue.title}</h1>
      <p className="inbox-detail-by">
        <span className="inbox-detail-author">{author}</span>
        <span aria-hidden="true">·</span>
        <Time iso={issue.created_at} />
      </p>

      <div className="inbox-controls" ref={controls}>
        <StatusMenu
          issue={issue}
          onSet={(s) => void setStatus(s)}
          trigger={(p) => (
            <button type="button" className="btn inbox-control" data-variant="default" data-size="small" data-control="status" title={t("control.status")} {...p}>
              <StateIcon state={visibleState(issue)} size={14} />
              {tc(`state.${issue.status === "closed" ? "closed" : issue.status}`)}
              <ChevronDownIcon size={12} />
            </button>
          )}
        />
        <Button size="small" onClick={() => void setStatus(closed ? "open" : "closed")} title={`${closed ? t("control.reopen") : t("control.close")} (e)`}>
          {closed ? t("control.reopen") : t("control.close")}
        </Button>
        <LabelMenu
          app={app}
          selected={issue.labels.map((l) => l.id)}
          onToggle={actions.toggleLabel}
          trigger={(p) => (
            <button type="button" className="btn inbox-control" data-variant="default" data-size="small" data-control="labels" title={`${t("control.labels")} (l)`} {...p}>
              {issue.labels.length ? (
                issue.labels.map((l) => <Label key={l.id} name={l.name} color={l.color} />)
              ) : (
                <>
                  <TagIcon size={14} />
                  {t("control.addLabels")}
                </>
              )}
            </button>
          )}
        />
        <AssignMenu
          app={app}
          issue={issue}
          onAssign={actions.assign}
          trigger={(p) => (
            <button type="button" className="btn inbox-control" data-variant="default" data-size="small" data-control="assignee" title={`${t("control.assignee")} (a)`} {...p}>
              {issue.assignee ? <ActorAvatar actor={issue.assignee} size={16} /> : <PersonIcon size={14} />}
              {issue.assignee ? actorName(issue.assignee) : t("control.unassigned")}
            </button>
          )}
        />
      </div>
      {actionError && <p className="field-error">{actionError}</p>}

      <div className="inbox-message">
        {issue.body.trim() ? <Markdown source={issue.body} slug={slug} mentions={issue.mentions} /> : <p className="muted-text">{t("detail.noMessage")}</p>}
      </div>

      {shots.length > 0 && (
        <FbSection title={t("detail.screenshots")}>
          <Gallery shots={shots} />
        </FbSection>
      )}
      {files.length > 0 && <AttachmentList attachments={files} />}

      {fb && (
        <>
          <FbSection title={t("email.label")}>
            <EmailState feedback={fb} />
          </FbSection>
          <div className="fb-columns">
            <FbSection title={t("detail.facts")}>
              <Facts feedback={fb} received={issue.created_at} />
            </FbSection>
            {Object.keys(fb.metadata ?? {}).length > 0 && (
              <FbSection title={t("detail.metadata")}>
                <Metadata metadata={fb.metadata} onFilter={onFilter} />
              </FbSection>
            )}
          </div>
          {fb.same_install.length > 0 && (
            <FbSection title={t("detail.sameInstall")}>
              <SameInstall
                refs={fb.same_install}
                link={(r) => (
                  <button type="button" className="link-button fb-same-link" onClick={() => onOpenRef(slug, r)}>
                    <span className="mono">#{r.number}</span> {r.title}
                  </button>
                )}
              />
            </FbSection>
          )}
        </>
      )}

      <FbSection title={t("detail.thread")}>
        {thread.length === 0 ? (
          <p className="muted-text inbox-thread-empty">{t("detail.noReplies")}</p>
        ) : (
          <div className="thread inbox-thread">
            {thread.map((b) =>
              b.kind === "hidden" ? (
                <HiddenLine key={b.key} reason={b.reason} />
              ) : b.kind === "held" ? (
                <HeldReply key={b.key} app={app} issue={issue} comment={b.comment} />
              ) : b.kind === "approval" ? (
                <ApprovalCard key={b.key} app={app} issue={issue} approval={b.approval} />
              ) : b.kind === "events" ? (
                b.events.length > 2 ? (
                  <EventBurst key={b.key} slug={slug} events={b.events} />
                ) : (
                  b.events.map((e) => <EventLine key={e.id} slug={slug} event={e} />)
                )
              ) : (
                <MessageGroup key={b.key} slug={slug} author={b.author} byAuthor={b.byAuthor} messages={b.messages} ctx={ctx} internal={b.internal} />
              ),
            )}
          </div>
        )}
      </FbSection>

      {member && (
        <div className="inbox-composer" ref={composer} data-mode={mode}>
          <div className="segmented inbox-composer-mode" role="radiogroup" aria-label={t("composer.reply")}>
            <button type="button" role="radio" aria-checked={mode === "reply"} onClick={() => setMode("reply")} title="r">
              {t("composer.reply")}
            </button>
            <button type="button" role="radio" aria-checked={mode === "note"} onClick={() => setMode("note")} title="n">
              {t("composer.note")}
            </button>
          </div>
          <Editor
            slug={slug}
            value={body}
            onChange={setBody}
            member
            mentions
            minHeight={88}
            onAttachment={(a) => setAttachments((list) => [...list, a.id])}
            onBusyChange={setUploading}
            onSubmit={() => void send()}
            placeholder={mode === "note" ? t("composer.notePlaceholder") : t("composer.replyPlaceholder")}
            label={mode === "note" ? t("composer.note") : t("composer.reply")}
            actions={
              <Button variant="primary" size="small" onClick={() => void send()} disabled={sending || uploading || (!body.trim() && !attachments.length)}>
                {sending ? t("composer.sending") : mode === "note" ? t("composer.addNote") : t("composer.send")}
              </Button>
            }
          />
          <p className="inbox-composer-hint" data-tone={mode === "reply" && fb && !(fb.email?.confirmed && !fb.anonymous) ? "warn" : undefined}>
            {mode === "note" ? t("composer.noteHint") : replyHint}
          </p>
          {sendError && <p className="field-error">{sendError}</p>}
        </div>
      )}
    </div>
  )
}

/** The issue page's thread model, with only what rendering the thread needs. */
function threadModel(app: AppDetail, issue: Issue, me: Me | undefined, viewer: Actor | null, actions: IssueActions): IssueModel {
  const noop = async () => {}
  return {
    app,
    issue,
    me,
    viewers: null,
    member: !!app.role,
    canEdit: !!app.role,
    viewer,
    actions,
    pending: [],
    actionError: null,
    onComment: async () => false,
    onStatus: noop,
    onDuplicate: noop,
    onPrivacy: noop,
    onHide: noop,
    onDelete: noop,
    onVote: noop,
    onLock: noop,
    onPin: noop,
    onTransfer: noop,
  }
}
