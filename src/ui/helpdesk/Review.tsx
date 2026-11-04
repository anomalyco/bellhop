import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react"
import type { AppDetail, Approval, Comment, Issue, IssueList } from "../../../shared/api"
import { t as tc } from "../../i18n/core"
import { useLocale } from "../../i18n"
import { tr, useT } from "../../i18n/helpdesk"
import { decision, detailEntries, detailKey, detailValue, detailsHash, foreignLetters, lookalikeKeys, visibleText } from "../../lib/approvals"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { load, useResource } from "../../lib/cache"
import { isDesk } from "../../lib/helpdesk"
import { Time, useUntil } from "../../lib/time"
import { ActorAvatar, ActorName, actorName } from "../Actor"
import { Editor } from "../Editor"
import { Markdown } from "../Markdown"
import { Button } from "../primitives"
import "../../styles/helpdesk.css"

const reload = (slug: string, number: number) => load(keys.issue(slug, number), () => api.issue(slug, number)).catch(() => {})

// A short note about the thread that outlives the item it's about (a draft someone else sent is gone after the
// refresh), shown under the thread for a few seconds
const notices = new Map<string, string>()
const listeners = new Set<() => void>()
function notify(key: string, text: string | null) {
  if (text) notices.set(key, text)
  else notices.delete(key)
  for (const l of listeners) l()
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

/** The thread's review note, if any (e.g. "Someone else already sent or discarded this draft"). */
export function ReviewNotice({ slug, number }: { slug: string; number: number }) {
  const key = `${slug}#${number}`
  const text = useSyncExternalStore(subscribe, () => notices.get(key) ?? null)
  useEffect(() => {
    if (!text) return
    const timer = setTimeout(() => notify(key, null), 8_000)
    return () => clearTimeout(timer)
  }, [key, text])
  if (!text) return null
  return (
    <p className="flash review-notice" role="status">
      {text}
    </p>
  )
}

/** "Nov 11, 2026, 10:28 PM": an absolute moment, for expiries (relative times here only run backwards). */
function When({ iso }: { iso: string }) {
  const locale = useLocale()
  const text = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))
  return (
    <time className="time" dateTime={iso}>
      {text}
    </time>
  )
}

/**
 * An agent's held reply (autonomy "suggest"), in place in the thread for the team: marked as a draft waiting for
 * review, with Send, Edit and send (the editor, sent with its text) and Discard (confirmed inline). The requester
 * never receives it. When someone else got there first (409 reply_unavailable) the thread reloads with a note.
 */
export function HeldReply({ app, issue, comment }: { app: AppDetail; issue: Issue; comment: Comment }) {
  const t = useT()
  const [mode, setMode] = useState<"idle" | "edit" | "discard">("idle")
  const [body, setBody] = useState(comment.body)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await run()
      await reload(app.slug, issue.number)
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "reply_unavailable") {
        notify(`${app.slug}#${issue.number}`, t("held.gone"))
        setMode("idle")
        await reload(app.slug, issue.number)
      } else setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const send = (text?: string) => act(() => api.sendHeld(app.slug, issue.number, comment.id, text))
  const discard = () => act(() => api.discardHeld(app.slug, issue.number, comment.id))
  return (
    <section className="held" data-key={comment.id} aria-label={t("held.label", { agent: actorName(comment.author) })}>
      <header className="held-head">
        <ActorAvatar actor={comment.author} size={20} />
        <span className="held-title">{tr("held.title", { agent: <ActorName actor={comment.author} /> })}</span>
        <span className="held-time">
          <Time iso={comment.created_at} />
        </span>
      </header>
      {mode === "edit" ? (
        <div className="msg-edit held-edit">
          <Editor
            slug={app.slug}
            value={body}
            onChange={setBody}
            member
            mentions
            onAttachment={() => {}}
            onBusyChange={setUploading}
            onSubmit={() => body.trim() && void send(body)}
            autoFocus
            label={t("held.editLabel")}
            actions={
              <>
                <Button variant="invisible" onClick={() => setMode("idle")} disabled={busy}>
                  {tc("common.cancel")}
                </Button>
                <Button variant="primary" onClick={() => void send(body)} disabled={busy || uploading || !body.trim()}>
                  {busy ? t("held.sending") : t("held.send")}
                </Button>
              </>
            }
          />
        </div>
      ) : (
        <div className="held-body">
          <Markdown source={comment.body} slug={app.slug} mentions={comment.mentions} />
        </div>
      )}
      {mode === "idle" && (
        <div className="held-actions">
          <Button variant="primary" size="small" onClick={() => void send()} disabled={busy}>
            {busy ? t("held.sending") : t("held.send")}
          </Button>
          <Button size="small" onClick={() => setMode("edit")} disabled={busy}>
            {t("held.editSend")}
          </Button>
          <Button size="small" variant="invisible" onClick={() => setMode("discard")} disabled={busy}>
            {t("held.discard")}
          </Button>
        </div>
      )}
      {mode === "discard" && (
        <div className="held-confirm" role="group" aria-label={t("held.discardTitle")}>
          <p>{t("held.discardText")}</p>
          <div className="held-actions">
            <Button size="small" variant="invisible" onClick={() => setMode("idle")} disabled={busy} autoFocus>
              {tc("common.cancel")}
            </Button>
            <Button size="small" variant="danger" onClick={() => void discard()} disabled={busy}>
              {t("held.discardConfirm")}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** The details exactly as the agent sent them (and as signed): every key and value, values as literals. */
function DetailsTable({ details }: { details: Approval["details"] }) {
  const t = useT()
  const rows = detailEntries(details)
  if (!rows.length) return <p className="approval-empty">{t("approval.noDetails")}</p>
  // Keys that read the same (amount / Cyrillic аmount, or the same after NFKC) get a warning above the table, and
  // any key with letters outside ASCII is marked with their spelling
  const alike = lookalikeKeys(details)
  return (
    <>
      {alike.length > 0 && (
        <p className="approval-lookalike" role="alert">
          <span aria-hidden="true">⚠</span> {t("approval.lookalike", { keys: alike.map((g) => g.map(detailKey).join(" / ")).join("; ") })}
        </p>
      )}
      <table className="approval-details">
        <caption className="sr-only">{t("approval.details")}</caption>
        <tbody>
          {rows.map(([k, v]) => {
            const foreign = foreignLetters(k)
            return (
              <tr key={k} data-foreign={foreign.length ? "" : undefined}>
                <th scope="row">
                  {foreign.length > 0 && (
                    <span className="approval-key-flag" title={t("approval.nonAscii", { chars: foreign.join(" ") })}>
                      ⚠{" "}
                    </span>
                  )}
                  {detailKey(k)}
                  {foreign.length > 0 && <span className="approval-key-spelling">{t("approval.nonAscii", { chars: foreign.join(" ") })}</span>}
                </th>
                <td>{detailValue(v)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </>
  )
}

/**
 * An approval an agent asked for, as a card in the thread (team only). The agent's summary is shown as its own
 * description; what's signed is `details`, shown verbatim, and the decision's hash is computed from that same object
 * after a confirm step that shows it again. A token never reaches the web UI.
 */
export function ApprovalCard({ app, issue, approval }: { app: AppDetail; issue: Issue; approval: Approval }) {
  const t = useT()
  const live = useUntil(approval.expires_at)
  const [step, setStep] = useState<{ decision: "approve" | "reject"; details: Approval["details"] } | null>(null)
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = approval.state === "pending" && live
  const decided = decision(approval)
  const id = `approval-${approval.id}`

  const decide = async () => {
    if (!step) return
    setBusy(true)
    setError(null)
    try {
      // The hash of exactly what the confirm step showed
      const details_hash = await detailsHash(step.details)
      await api.decideApproval(app.slug, issue.number, approval.id, { decision: step.decision, details_hash, ...(step.decision === "reject" && note.trim() && { note: note.trim() }) })
      setStep(null)
      setNote("")
      await reload(app.slug, issue.number)
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "details_changed") {
        setStep(null)
        setError(t("approval.changed"))
      } else if (e instanceof ApiFailure && (e.code === "approval_unavailable" || e.status === 410)) {
        setStep(null)
        setError(t("approval.unavailable"))
      } else setError(errorMessage(e))
      await reload(app.slug, issue.number)
    } finally {
      setBusy(false)
    }
  }

  let state: ReactNode
  if (approval.state === "pending")
    state = live ? (
      <>
        <span className="approval-pill" data-state="pending">
          {t("approval.pending")}
        </span>
        <span className="approval-when">{tr("approval.expires", { time: <When iso={approval.expires_at} /> })}</span>
      </>
    ) : (
      <span className="approval-pill" data-state="expired">
        {t("approval.expired")}
      </span>
    )
  else if (decided === "rejected")
    state = (
      <>
        <span className="approval-pill" data-state="rejected">
          {tr("approval.rejectedBy", { name: approval.decided_by ? actorName(approval.decided_by) : "" })}
        </span>
        {approval.decided_at && (
          <span className="approval-when">
            <Time iso={approval.decided_at} />
          </span>
        )}
      </>
    )
  else if (decided === "approved")
    state = (
      <>
        <span className="approval-pill" data-state="approved">
          {tr("approval.approvedBy", { name: approval.decided_by ? actorName(approval.decided_by) : "" })}
        </span>
        {approval.decided_at && (
          <span className="approval-when">
            <Time iso={approval.decided_at} />
          </span>
        )}
        {approval.state === "used" && <span className="approval-when">{t("approval.used")}</span>}
        {approval.state === "expired" && <span className="approval-when">{t("approval.tokenExpired")}</span>}
      </>
    )
  else
    state = (
      <span className="approval-pill" data-state="expired">
        {t("approval.expired")}
      </span>
    )

  return (
    <section className="approval" data-key={approval.id} data-state={pending ? "pending" : approval.state} aria-labelledby={`${id}-title`}>
      <header className="approval-head">
        <ActorAvatar actor={approval.requested_by} size={20} />
        <span className="approval-title" id={`${id}-title`}>
          {tr("approval.title", { agent: <ActorName actor={approval.requested_by} />, action: <code className="approval-action">{approval.action}</code> })}
        </span>
        <span className="approval-time">
          <Time iso={approval.created_at} />
        </span>
      </header>
      <div className="approval-summary">
        <span className="approval-label">{t("approval.summaryLabel")}</span>
        <p dir="auto">{visibleText(approval.summary)}</p>
      </div>
      <div className="approval-signed">
        <span className="approval-label">{t("approval.details")}</span>
        <DetailsTable details={approval.details} />
      </div>
      <div className="approval-state">{state}</div>
      {decided && approval.note && <p className="approval-meta">{tr("approval.note", { note: <q className="approval-note">{approval.note}</q> })}</p>}
      {pending && !step && (
        <div className="approval-actions">
          <Button variant="primary" size="small" onClick={() => (setError(null), setStep({ decision: "approve", details: approval.details }))}>
            {t("approval.approve")}
          </Button>
          <Button size="small" onClick={() => (setError(null), setStep({ decision: "reject", details: approval.details }))}>
            {t("approval.reject")}
          </Button>
        </div>
      )}
      {pending && step && (
        <div className="approval-confirm" role="group" aria-labelledby={`${id}-confirm`}>
          <p id={`${id}-confirm`} className="approval-confirm-title">
            {step.decision === "approve"
              ? tr("approval.confirmApprove", { action: <code className="approval-action">{approval.action}</code> })
              : tr("approval.confirmReject", { action: <code className="approval-action">{approval.action}</code> })}
          </p>
          <DetailsTable details={step.details} />
          {step.decision === "reject" && (
            <div className="field">
              <label className="field-label" htmlFor={`${id}-note`}>
                {t("approval.noteLabel")}
              </label>
              <textarea id={`${id}-note`} className="textarea" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
          <div className="approval-actions">
            <Button size="small" variant="invisible" onClick={() => setStep(null)} disabled={busy} autoFocus>
              {t("approval.back")}
            </Button>
            <Button size="small" variant={step.decision === "approve" ? "primary" : "danger"} onClick={() => void decide()} disabled={busy}>
              {busy ? t("approval.deciding") : step.decision === "approve" ? t("approval.approveConfirm") : t("approval.rejectConfirm")}
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** "Sent by Ada": who published a held reply (team only; the server sends null to anyone else). */
export function SentBy({ comment }: { comment: Comment }) {
  const t = useT()
  if (!comment.sent_by) return null
  return <p className="sent-by">{t("held.sentBy", { name: actorName(comment.sent_by) })}</p>
}

/**
 * The team's review queue on a help desk list: which requests have a held reply or a pending approval, and how many,
 * from the server's own qualifiers (first page of each). Null outside a help desk team.
 */
export function useReviewQueue(app: AppDetail, state: "open" | "closed") {
  const team = isDesk(app) && !!app.role
  const held = useResource<IssueList>(team ? `review:${app.slug}:held:${state}` : null, () => api.issues(app.slug, { state, q: "is:held" }), 30_000)
  const approvals = useResource<IssueList>(team ? `review:${app.slug}:approval:${state}` : null, () => api.issues(app.slug, { state, q: "is:awaiting-approval" }), 30_000)
  if (!team) return null
  return {
    /** Both answered (or failed): rows can show with their flags, so none appears later and moves the list. */
    ready: (!!held.data || !!held.error) && (!!approvals.data || !!approvals.error),
    held: new Set(held.data?.issues.map((i) => i.id)),
    approvals: new Set(approvals.data?.issues.map((i) => i.id)),
    heldCount: held.data ? held.data.counts[state] : null,
    approvalCount: approvals.data ? approvals.data.counts[state] : null,
  }
}

/** A list row's review flags (team only): a held reply, a pending approval. */
export function ReviewFlags({ held, approval, escalated = false }: { held: boolean; approval: boolean; escalated?: boolean }) {
  const t = useT()
  return (
    <>
      {escalated && (
        <span className="row-flag review-flag" data-kind="escalated" title={t("queue.escalatedTitle")}>
          {t("queue.escalatedFlag")}
        </span>
      )}
      {held && (
        <span className="row-flag review-flag" data-kind="held" title={t("queue.heldTitle")}>
          {t("queue.heldFlag")}
        </span>
      )}
      {approval && (
        <span className="row-flag review-flag" data-kind="approval" title={t("queue.approvalTitle")}>
          {t("queue.approvalFlag")}
        </span>
      )}
    </>
  )
}
