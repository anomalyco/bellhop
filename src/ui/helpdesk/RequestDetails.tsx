import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react"
import type { Actor, AppDetail, Issue, IssueEvent, RequestField, RequestType } from "../../../shared/api"
import { t as tc } from "../../i18n/core"
import { tr, useT } from "../../i18n/helpdesk"
import { api, errorMessage, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { isDesk } from "../../lib/helpdesk"
import { storeIssue } from "../../lib/issues"
import { actorName } from "../Actor"
import { ChevronDownIcon } from "../icons"
import { Menu, MenuItem } from "../Menu"
import { Button } from "../primitives"
import { TypeFields, answersFor, serverFieldError, validate, type Answers, type FieldErrors } from "./RequestForm"
import "../../styles/helpdesk.css"

/** The workspace's request types, for field labels and the team's type menu (help desks only). */
export function useRequestTypes(app: AppDetail) {
  return useResource<RequestType[]>(isDesk(app) ? keys.requestTypes(app.slug) : null, () => api.requestTypes(app.slug), 30_000).data
}

/** The request a thread belongs to, for the `routed` event sentences (whose data names the type by id only). */
const RequestContext = createContext<{ app: AppDetail; issue: Issue } | null>(null)
export function RequestProvider({ app, issue, children }: { app: AppDetail; issue: Issue; children: ReactNode }) {
  return <RequestContext.Provider value={{ app, issue }}>{children}</RequestContext.Provider>
}

/**
 * A `routed` event's sentence. The one written with the request ("filed this as Billing, routed to Ada") is the
 * request's first routed event, committed together with it; any later one is a type change, however soon.
 */
export function useRoutedSentence() {
  const ctx = useContext(RequestContext)
  const types = useResource<RequestType[]>(ctx && isDesk(ctx.app) ? keys.requestTypes(ctx.app.slug) : null, () => api.requestTypes(ctx!.app.slug), 30_000).data
  const first = ctx?.issue.timeline.find((x) => x.kind === "event" && x.event.type === "routed")
  const firstId = first?.kind === "event" ? first.event.id : null
  return (event: IssueEvent) => {
    const data = event.data
    const id = data.request_type as string | undefined
    const name = types?.find((x) => x.id === id)?.name ?? (ctx?.issue.request_type?.id === id ? ctx?.issue.request_type?.name : undefined)
    const filed = !!ctx && event.id === firstId && Math.abs(Date.parse(event.created_at) - Date.parse(ctx.issue.created_at)) < 5_000
    const assignee = data.outcome === "assigned" ? (data.assignee as Actor | null) : null
    const type = <strong>{name ?? tr("event.someType")}</strong>
    if (data.request_type == null) return (actor: ReactNode) => tr("event.typeRemoved", { actor })
    return (actor: ReactNode) =>
      assignee
        ? tr(filed ? "event.filedAssigned" : "event.retypedAssigned", { actor, type, assignee: <strong>{actorName(assignee)}</strong> })
        : data.outcome === "target_unavailable"
          ? tr(filed ? "event.filedUnavailable" : "event.retypedUnavailable", { actor, type })
          : tr(filed ? "event.filed" : "event.retyped", { actor, type })
  }
}

/** "billing_email" → "Billing email": a label for an answer whose field definition isn't available. */
const humanize = (key: string) => {
  const s = key.replace(/_+/g, " ").trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** The request's type, as a quiet label near the title. */
export function RequestTypeLabel({ issue }: { issue: Issue }) {
  if (!issue.request_type) return null
  return <span className="request-type-label">{issue.request_type.name}</span>
}

/**
 * The answers to the type's fields, as a compact list under the request: the requester sees their own, the team
 * also the internal ones, marked. Labels come from the type; the list's layout doesn't depend on them arriving.
 */
export function RequestAnswers({ app, issue }: { app: AppDetail; issue: Issue }) {
  const t = useT()
  const types = useRequestTypes(app)
  const entries = Object.entries(issue.fields ?? {})
  if (!entries.length) return null
  const defs = types?.find((x) => x.id === issue.request_type?.id)?.fields ?? []
  const order = (k: string) => {
    const i = defs.findIndex((f) => f.key === k)
    return i === -1 ? defs.length : i
  }
  const def = (k: string): RequestField | undefined => defs.find((f) => f.key === k)
  return (
    <section className="request-answers" aria-label={t("request.details")}>
      <h2 className="request-answers-title">{t("request.details")}</h2>
      <dl>
        {entries
          .sort(([a], [b]) => order(a) - order(b))
          .map(([key, value]) => {
            const f = def(key)
            return (
              <div key={key} className="request-answer" data-internal={f?.internal || undefined}>
                <dt title={f?.label ?? key}>{f?.label ?? humanize(key)}</dt>
                <dd>
                  {f?.kind === "url" && /^https?:\/\//i.test(value) ? (
                    <a href={value} target="_blank" rel="noopener noreferrer nofollow">
                      {value}
                    </a>
                  ) : (
                    value
                  )}
                  {f?.internal && <span className="request-internal">{t("request.internal")}</span>}
                </dd>
              </div>
            )
          })}
      </dl>
    </section>
  )
}

/**
 * The team's sidebar section: the request's type, changed from a menu (re-routing it: the routed event lands in the
 * thread), and the agent mode that applies.
 */
export function RequestTypeSection({ app, issue, place }: { app: AppDetail; issue: Issue; place: "side" | "mobile" }) {
  const t = useT()
  const types = (useRequestTypes(app) ?? []).filter((x) => !x.archived).sort((a, b) => a.position - b.position)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A type whose required fields this request hasn't answered asks for them here before it's applied
  const [pending, setPending] = useState<{ type: RequestType; ask: RequestField[] } | null>(null)
  const [answers, setAnswers] = useState<Answers>({})
  const [errors, setErrors] = useState<FieldErrors>({})
  const prefix = `${place}-type-field`
  const put = async (type: RequestType | null, fields?: Answers, ask: RequestField[] = []) => {
    setBusy(true)
    setError(null)
    try {
      storeIssue(app.slug, await api.setRequestType(app.slug, issue.number, type?.id ?? null, fields))
      setPending(null)
    } catch (e) {
      const fieldError = type && serverFieldError(type, e, ask)
      if (fieldError) setErrors(fieldError)
      else setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const change = (type: RequestType | null) => {
    setPending(null)
    if ((type?.id ?? null) === (issue.request_type?.id ?? null)) return
    const ask = (type?.fields ?? []).filter((f) => f.required && !(issue.fields?.[f.key] ?? "").trim())
    if (type && ask.length) {
      setAnswers({})
      setErrors({})
      setPending({ type, ask })
    } else void put(type)
  }
  // The first missing answer takes focus once its field is on screen
  const first = pending?.ask[0]?.key
  useEffect(() => {
    if (first) document.getElementById(`${prefix}-${first}`)?.focus({ preventScroll: true })
  }, [pending, first, prefix])
  const apply = (e: FormEvent) => {
    e.preventDefault()
    if (!pending) return
    const problems = validate(pending.type, answers, pending.ask)
    setErrors(problems)
    if (Object.keys(problems).length) return document.getElementById(`${prefix}-${Object.keys(problems)[0]}`)?.focus()
    void put(pending.type, answersFor(pending.type, answers, pending.ask), pending.ask)
  }
  return (
    <section className="side-section request-type-section">
      <div className="side-head">
        <h3>{t("side.type")}</h3>
      </div>
      <Menu
        align="start"
        width={240}
        trigger={(p) => (
          <button type="button" className="btn side-select request-type-select" data-variant="default" aria-label={`${t("side.changeType")}: ${issue.request_type?.name ?? t("side.noType")}`} disabled={busy} {...p}>
            <span className="side-select-text">{issue.request_type?.name ?? t("side.noType")}</span>
            <ChevronDownIcon size={14} />
          </button>
        )}
      >
        {(close) => (
          <>
            {types.map((type) => (
              <MenuItem
                key={type.id}
                checked={issue.request_type?.id === type.id}
                description={type.description || undefined}
                onSelect={() => {
                  close()
                  change(type)
                }}
              >
                {type.name}
              </MenuItem>
            ))}
            <MenuItem
              checked={!issue.request_type}
              onSelect={() => {
                close()
                change(null)
              }}
            >
              {t("side.noType")}
            </MenuItem>
          </>
        )}
      </Menu>
      {pending && (
        <form className="request-type-ask" onSubmit={apply} noValidate>
          <p className="api-hint">{t("side.typeAsk", { type: pending.type.name })}</p>
          <TypeFields
            type={pending.type}
            fields={pending.ask}
            prefix={prefix}
            answers={answers}
            errors={errors}
            onChange={(key, value) => {
              setAnswers((a) => ({ ...a, [key]: value }))
              setErrors(({ [key]: _, ...rest }) => rest)
            }}
          />
          <div className="request-type-ask-actions">
            <Button size="small" variant="invisible" onClick={() => setPending(null)} disabled={busy}>
              {tc("common.cancel")}
            </Button>
            <Button size="small" type="submit" variant="primary" disabled={busy}>
              {t("side.changeType")}
            </Button>
          </div>
        </form>
      )}
      {issue.effective_autonomy && <p className="request-mode">{t("side.agentMode", { mode: t(`autonomy.${issue.effective_autonomy}`) })}</p>}
      {error && <p className="field-error">{error}</p>}
    </section>
  )
}
