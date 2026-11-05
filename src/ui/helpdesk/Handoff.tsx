import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import type { Actor, AppDetail, Escalation, Group, Issue, IssueEvent, IssueList } from "../../../shared/api"
import { t as tc } from "../../i18n/core"
import { getLocale, useLocale } from "../../i18n"
import { tr, useT } from "../../i18n/helpdesk"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { load, setData, useResource } from "../../lib/cache"
import { isDesk } from "../../lib/helpdesk"
import { storeIssue } from "../../lib/issues"
import { clockNow, useUntil } from "../../lib/time"
import { ActorAvatar, ActorName, actorName } from "../Actor"
import { Button } from "../primitives"
import { useMe } from "../Shell"
import "../../styles/helpdesk.css"

/** The workspace's groups (help desk team only). */
export function useGroups(app: AppDetail) {
  return useResource<Group[]>(isDesk(app) && !!app.role ? keys.groups(app.slug) : null, () => api.groups(app.slug), 30_000)
}

/** "in 23 minutes" / "in 2 hours": a time ahead, relative, in the active language. */
function ahead(iso: string, now = clockNow()) {
  const f = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" })
  const s = Math.max(0, (Date.parse(iso) - now) / 1000)
  if (s < 3600) return f.format(Math.max(1, Math.round(s / 60)), "minute")
  if (s < 86400) return f.format(Math.round(s / 3600), "hour")
  return f.format(Math.round(s / 86400), "day")
}

export function AvailabilitySwitch({ app, compact = false }: { app: AppDetail; compact?: boolean }) {
  const t = useT()
  const me = useMe().data?.user
  const key = me && isDesk(app) && app.role && app.role !== "viewer" ? keys.availability(app.slug, me.id) : null
  const { data, error: readError } = useResource(key, () => api.availability(app.slug), -1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!key || busy) return
    const refresh = () => { if (document.visibilityState === "visible") load(key, () => api.availability(app.slug)).catch(() => {}) }
    window.addEventListener("focus", refresh)
    document.addEventListener("visibilitychange", refresh)
    return () => { window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh) }
  }, [key, app.slug, busy])
  if (!key) return null
  const flip = async (next: boolean) => {
    setBusy(true)
    setError(null)
    try {
      const saved = await api.setAvailability(app.slug, next)
      // Finish any older focus read before publishing the confirmed write to both switch locations.
      await load(key, () => Promise.resolve(saved)).catch(() => {})
      setData(key, saved)
      load(keys.groups(app.slug), () => api.groups(app.slug)).catch(() => {})
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const id = `availability-${app.slug}${compact ? "-side" : ""}`
  return (
    <div className="availability" data-compact={compact || undefined}>
      <label className="availability-row" htmlFor={id}>
        <span className="availability-text">
          <span className="availability-title">{t("availability.title")}</span>
          <span className="availability-state" data-away={data?.available === false || undefined}>
            {/* A non-breaking space holds the line until the read lands, so the row never grows. */}
            {data ? (data.available ? t("availability.available") : t("availability.away")) : "\u00a0"}
          </span>
        </span>
        <input id={id} type="checkbox" role="switch" className="switch" checked={data?.available ?? false} disabled={busy || !data} onChange={(e) => void flip(e.target.checked)} />
      </label>
      {!compact && <p className="api-hint">{t("availability.text")}</p>}
      {(error || readError) ? <p className="field-error">{error || errorMessage(readError)}</p> : null}
    </div>
  )
}

/** Who started a handoff, as a sentence. */
function sourceText(e: Escalation) {
  const name = e.by ? actorName(e.by) : ""
  if (e.source === "agent") return tr("handoff.sourceAgent", { name: <strong>{name}</strong> })
  if (e.source === "team") return tr("handoff.sourceTeam", { name: <strong>{name}</strong> })
  if (e.source === "requester") return tr("handoff.sourceRequester")
  return tr("handoff.sourceRouting")
}

/** The reply deadline, counting down; "overdue" once it passes (the sweep moves it on within a minute). */
function Due({ iso }: { iso: string }) {
  const t = useT()
  useLocale()
  const live = useUntil(iso)
  const [, tick] = useState(0)
  // Re-render every half minute so the countdown moves
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(timer)
  }, [])
  return <span className="handoff-due" data-overdue={!live || undefined}>{live ? t("handoff.due", { time: ahead(iso) }) : t("handoff.overdue")}</span>
}

/**
 * The team's sidebar section on a help desk request: with agents (Escalate, with a group and a reason) or with a
 * person (the escalation's source, reason, group, assignee, waiting state and reply deadline, and Hand back).
 */
export function HandoffSection({ app, issue }: { app: AppDetail; issue: Issue }) {
  const t = useT()
  const { data: groups } = useGroups(app)
  const [mode, setMode] = useState<"idle" | "escalate" | "handBack">("idle")
  const [group, setGroup] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const e = issue.escalation
  const id = `handoff-${issue.number}`
  const run = async (call: () => Promise<Issue>) => {
    setBusy(true)
    setError(null)
    try {
      storeIssue(app.slug, await call())
      setMode("idle")
      setReason("")
      setGroup("")
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const escalate = (ev: FormEvent) => {
    ev.preventDefault()
    void run(() => api.escalate(app.slug, issue.number, { ...(reason.trim() && { reason: reason.trim() }), ...(group && { group_id: group }) }))
  }

  return (
    <section className="side-section handoff-section" data-escalated={e ? "" : undefined}>
      <div className="side-head">
        <h3>{t("handoff.title")}</h3>
      </div>
      {e ? (
        <div className="handoff-panel">
          <p className="handoff-state">{t("handoff.escalated")}</p>
          <p className="handoff-source">{sourceText(e)}</p>
          {e.reason && <p className="handoff-reason">“{e.reason}”</p>}
          <dl className="handoff-facts">
            <div>
              <dt>{t("handoff.group")}</dt>
              <dd>{e.group?.name ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("handoff.assignee")}</dt>
              <dd>
                {issue.assignee ? (
                  <span className="handoff-assignee">
                    <ActorAvatar actor={issue.assignee} size={16} />
                    <ActorName actor={issue.assignee} />
                  </span>
                ) : (
                  t("handoff.nobodyYet")
                )}
              </dd>
            </div>
          </dl>
          {e.waiting && <p className="handoff-waiting">{e.waiting === "hours" ? t("handoff.waitingHours") : t("handoff.waitingNobody")}</p>}
          {e.respond_by && <Due iso={e.respond_by} />}
          {mode === "handBack" ? (
            <div className="handoff-confirm" role="group" aria-label={t("handoff.handBack")}>
              <p>{t("handoff.handBackText")}</p>
              <div className="handoff-actions">
                <Button size="small" variant="invisible" onClick={() => setMode("idle")} disabled={busy} autoFocus>
                  {tc("common.cancel")}
                </Button>
                <Button size="small" variant="primary" onClick={() => void run(() => api.handBack(app.slug, issue.number))} disabled={busy}>
                  {busy ? t("handoff.working") : t("handoff.handBackConfirm")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="handoff-actions">
              <Button size="small" onClick={() => setMode("handBack")}>
                {t("handoff.handBack")}
              </Button>
            </div>
          )}
        </div>
      ) : mode === "escalate" ? (
        <form className="handoff-form" onSubmit={escalate}>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-group`}>
              {t("handoff.groupLabel")}
            </label>
            <select id={`${id}-group`} className="select" value={group} onChange={(ev) => setGroup(ev.target.value)}>
              <option value="">{t("handoff.defaultGroup")}</option>
              {(groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-reason`}>
              {t("handoff.reasonLabel")}
            </label>
            <textarea id={`${id}-reason`} className="textarea" rows={2} maxLength={1000} value={reason} onChange={(ev) => setReason(ev.target.value)} />
          </div>
          <div className="handoff-actions">
            <Button size="small" variant="invisible" onClick={() => setMode("idle")} disabled={busy}>
              {tc("common.cancel")}
            </Button>
            <Button size="small" type="submit" variant="primary" disabled={busy}>
              {busy ? t("handoff.working") : t("handoff.escalateConfirm")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="handoff-panel">
          <p className="handoff-state" data-agents="">
            {t("handoff.withAgents")}
          </p>
          <div className="handoff-actions">
            <Button size="small" onClick={() => setMode("escalate")}>
              {t("handoff.escalate")}
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

/**
 * "Talk to a person", for the requester under their thread: once per request, with an optional reason. After it
 * (or when a person already has the request) it says a person will take it from here.
 */
// The ask works once per request, ever (even after a hand-back): this browser remembers it, and a refusal from the
// server means it was used elsewhere
const askedKey = (slug: string, number: number) => `bellhop:asked:${slug}:${number}`
function asked(slug: string, number: number) {
  try {
    return localStorage.getItem(askedKey(slug, number)) === "1"
  } catch {
    return false
  }
}
function markAsked(slug: string, number: number) {
  try {
    localStorage.setItem(askedKey(slug, number), "1")
  } catch {
    /* private mode */
  }
}

export function TalkToPerson({ app, issue }: { app: AppDetail; issue: Issue }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [used, setUsed] = useState(() => asked(app.slug, issue.number))
  if (issue.status === "closed" && !issue.escalated_to_person && !used) return null
  if (issue.escalated_to_person || used)
    return (
      <div className="talk" data-done="">
        <p className="talk-done" role="status">
          {t("talk.done")}
        </p>
      </div>
    )
  const send = async (ev: FormEvent) => {
    ev.preventDefault()
    setBusy(true)
    setError(null)
    try {
      storeIssue(app.slug, await api.escalate(app.slug, issue.number, reason.trim() ? { reason: reason.trim() } : {}))
      markAsked(app.slug, issue.number)
      setUsed(true)
      setOpen(false)
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 429) setError(t("talk.limited"))
      else if (e instanceof ApiFailure && e.status >= 400 && e.status < 500) {
        // Already asked on this request (from another device, or before a hand-back)
        markAsked(app.slug, issue.number)
        setUsed(true)
      } else setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="talk">
      {open ? (
        <form className="talk-form" onSubmit={send}>
          <div className="field">
            <label className="field-label" htmlFor={`talk-${issue.number}`}>
              {t("talk.reasonLabel")}
            </label>
            <textarea id={`talk-${issue.number}`} className="textarea" rows={2} maxLength={1000} value={reason} onChange={(ev) => setReason(ev.target.value)} autoFocus />
          </div>
          <div className="talk-actions">
            <Button size="small" variant="invisible" onClick={() => setOpen(false)} disabled={busy}>
              {tc("common.cancel")}
            </Button>
            <Button size="small" type="submit" variant="primary" disabled={busy}>
              {busy ? t("handoff.working") : t("talk.send")}
            </Button>
          </div>
        </form>
      ) : (
        <p className="talk-prompt">
          <span>{t("talk.prompt")}</span>
          <button type="button" className="link-button talk-button" onClick={() => setOpen(true)}>
            {t("talk.button")}
          </button>
        </p>
      )}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** The handoff events' sentences. The requester's `escalated` has no data: the neutral line. */
export function handoffSentence(event: IssueEvent): ((actor: ReactNode) => ReactNode) | null {
  const d = event.data as Record<string, unknown>
  const name = (a: unknown) => <strong>{a ? actorName(a as Actor) : tr("event.someone")}</strong>
  if (event.type === "escalated") {
    if (!d || !("source" in d)) return () => tr("event.withPerson")
    const group = (d.group as { name: string } | null)?.name
    const assignee = (d.assignee ?? d.to) as Actor | null
    const g = group ? <strong>{group}</strong> : null
    return (actor) =>
      assignee
        ? g
          ? tr("event.escalatedAssigned", { actor, group: g, assignee: name(assignee) })
          : tr("event.escalatedAssignedNoGroup", { actor, assignee: name(assignee) })
        : d.waiting === "hours" && g
          ? tr("event.escalatedWaitingHours", { actor, group: g })
          : d.waiting
            ? tr("event.escalatedWaitingNobody", { actor })
            : g
              ? tr("event.escalatedGroup", { actor, group: g })
              : tr("event.escalated", { actor })
  }
  if (event.type === "handed_back") return (actor) => tr("event.handedBack", { actor })
  if (event.type === "reassigned") {
    if (d?.cause === "group_deleted") return () => tr("event.groupDeleted")
    const from = d?.from as Actor | null
    const to = (d?.to ?? d?.assignee) as Actor | null
    if (!from && to) return () => tr("event.reassignedAssigned", { to: name(to) })
    return () => (to ? tr("event.reassigned", { from: name(from), to: name(to) }) : tr("event.reassignedNobody", { from: name(from) }))
  }
  return null
}

/** The team's handoff queue on the list (first page of each): which requests a person has. */
export function useHandoffQueue(app: AppDetail, state: "open" | "closed") {
  const team = isDesk(app) && !!app.role
  const withPerson = useResource<IssueList>(team ? `review:${app.slug}:with-person:${state}` : null, () => api.issues(app.slug, { state, q: "is:with-person" }), 30_000)
  const waiting = useResource<IssueList>(team ? `review:${app.slug}:waiting-person:${state}` : null, () => api.issues(app.slug, { state, q: "is:waiting-for-person" }), 30_000)
  if (!team) return null
  return {
    ready: (!!withPerson.data || !!withPerson.error) && (!!waiting.data || !!waiting.error),
    escalated: new Set(withPerson.data?.issues.map((i) => i.id)),
    withPersonCount: withPerson.data ? withPerson.data.counts[state] : null,
    waitingCount: waiting.data ? waiting.data.counts[state] : null,
  }
}

/** Keeps a group's cached list in step after a save or delete. */
export function putGroup(slug: string, group: Group | { id: string; deleted: true }) {
  setData<Group[]>(keys.groups(slug), (list) =>
    "deleted" in group ? list?.filter((g) => g.id !== group.id) : list?.some((g) => g.id === group.id) ? list.map((g) => (g.id === group.id ? group : g)) : [...(list ?? []), group],
  )
}
