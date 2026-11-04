import { createContext, useContext, useState, type ReactNode } from "react"
import type { AppDetail, Contact, Issue, Verification } from "../../../shared/api"
import { tr, useT } from "../../i18n/helpdesk"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { load, setData } from "../../lib/cache"
import { isDesk, maskEmail } from "../../lib/helpdesk"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { actorName } from "../Actor"
import { CheckIcon, MailIcon, PlusIcon } from "../icons"
import { Button } from "../primitives"
import { AppLink } from "../SiteLink"

type ContactLike = Pick<Contact, "name" | "email" | "unverified_email" | "external_id" | "verified_via">

/** A contact's display name: their name, else their verified email, else the host's id. Never the unverified email. */
export function contactName(c: ContactLike) {
  return c.name || c.email || c.external_id || "—"
}

/** How the team knows who this is: "Verified by email", "Verified by {Workspace} sign-in", or "Not verified". */
export function ContactBadge({ contact, workspace, compact }: { contact: ContactLike; workspace?: string; compact?: boolean }) {
  const t = useT()
  if (!contact.verified_via) return compact ? null : <span className="requester-badge">{t("side.unverified")}</span>
  const text = contact.verified_via === "host" && workspace ? t("side.verifiedHost", { workspace }) : t("side.verifiedEmail")
  return (
    <span className="requester-badge" data-verified="" title={compact ? text : undefined} aria-label={compact ? text : undefined}>
      <CheckIcon size={12} />
      {!compact && text}
    </span>
  )
}

/** The request's verifications for the thread's `verified` event sentences (which only carry an id). */
const VerificationsContext = createContext<{ list: Verification[]; member: boolean }>({ list: [], member: false })
export function VerificationsProvider({ issue, member, children }: { issue: Issue; member: boolean; children: ReactNode }) {
  return <VerificationsContext.Provider value={{ list: issue.verifications ?? [], member }}>{children}</VerificationsContext.Provider>
}

/** A `verified` event's sentence: the address in full for the team, masked for the requester. */
export function useVerifiedSentence() {
  const { list, member } = useContext(VerificationsContext)
  return (id: unknown) => {
    const v = list.find((x) => x.id === id)
    return (actor: ReactNode) =>
      v ? tr("event.verified", { actor, email: <strong>{member ? v.email : maskEmail(v.email)}</strong> }) : tr("event.verifiedEmail", { actor })
  }
}

/** Puts a verification the server just answered with into the cached issue, then refreshes it (events, live state). */
function putVerification(slug: string, number: number, v: Verification) {
  const key = keys.issue(slug, number)
  setData<Issue>(key, (issue) => {
    if (!issue) return issue
    const list = issue.verifications ?? []
    return { ...issue, verifications: list.some((x) => x.id === v.id) ? list.map((x) => (x.id === v.id ? v : x)) : [...list, v] }
  })
  load(key, () => api.issue(slug, number)).catch(() => {})
}

const stateKey = { pending: "verify.pending", verified: "verify.verified", failed: "verify.failedState", expired: "verify.expiredState" } as const

function VerifyState({ v }: { v: Verification }) {
  const t = useT()
  return (
    <span className="verify-state" data-state={v.state}>
      {v.state === "verified" && <CheckIcon size={12} />}
      {t(stateKey[v.state])}
    </span>
  )
}

/** The team's line for one verification: who asked, which address, and where it stands. */
export function VerificationLine({ v }: { v: Verification }) {
  return (
    <div className="verify-line">
      <MailIcon size={14} />
      <span>{tr("verify.line", { email: <strong>{v.email}</strong>, name: actorName(v.requested_by) })}</span>
      <span aria-hidden="true">·</span>
      <VerifyState v={v} />
      <span aria-hidden="true">·</span>
      <Time iso={v.verified_at ?? v.created_at} />
    </div>
  )
}

/**
 * The sidebar's Requester (help desks) or Verifications (trackers) section, for the team: who the requester is and
 * how we know, their external id, every verification on the request, and Request verification.
 */
export function RequesterSection({ app, issue }: { app: AppDetail; issue: Issue }) {
  const t = useT()
  const desk = isDesk(app)
  const contact = issue.contact
  const verifications = issue.verifications ?? []
  const [asking, setAsking] = useState(false)
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    const address = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return setError(t("error.invalidEmail"))
    setBusy(true)
    setError(null)
    try {
      putVerification(app.slug, issue.number, await api.requestVerification(app.slug, issue.number, address))
      setAsking(false)
      setEmail("")
    } catch (e) {
      setError(e instanceof ApiFailure && e.status === 429 ? t("error.limitLater") : errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="side-section">
      <div className="side-head">
        <h3>{desk ? t("side.requester") : t("side.verifications")}</h3>
        <Button
          iconOnly
          size="small"
          variant="ghost-muted"
          aria-label={t("side.requestVerification")}
          title={t("side.requestVerification")}
          aria-expanded={asking}
          icon={<PlusIcon size={14} />}
          onClick={() => setAsking(!asking)}
        />
      </div>
      {desk && (
        <div className="requester">
          {contact ? (
            <>
              <AppLink slug={app.slug} href={appPath(app.slug, `/contacts/${encodeURIComponent(contact.id)}`)} className="requester-name">
                <span>{contactName(contact)}</span>
              </AppLink>
              {contact.email && contact.email !== contactName(contact) && <span className="requester-email">{contact.email}</span>}
              {!contact.email && contact.unverified_email && (
                <span className="requester-email muted-text">{t("side.unverifiedEmail", { email: contact.unverified_email })}</span>
              )}
              <ContactBadge contact={contact} workspace={app.name} />
              {contact.external_id && (
                <span className="requester-id">
                  {t("side.externalId")}
                  <span className="mono" title={contact.external_id}>
                    {contact.external_id}
                  </span>
                </span>
              )}
            </>
          ) : (
            <span className="requester-badge">{t("side.guest")}</span>
          )}
        </div>
      )}
      {verifications.length > 0 && (
        <div className="requester-verifications">
          {verifications.map((v) => (
            <VerificationLine key={v.id} v={v} />
          ))}
        </div>
      )}
      {!desk && verifications.length === 0 && !asking && <div className="side-empty">—</div>}
      {asking && (
        <div className="requester-verify">
          <div className="requester-verify-row">
            <div className="input" data-size="small" data-invalid={error ? "" : undefined}>
              <input
                type="email"
                inputMode="email"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                value={email}
                placeholder={t("side.verifyEmail")}
                aria-label={t("side.verifyEmail")}
                onChange={(e) => {
                  setEmail(e.target.value)
                  setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void send()
                  }
                }}
              />
            </div>
            <Button size="small" variant="primary" onClick={() => void send()} disabled={busy}>
              {busy ? t("side.sending") : t("side.sendCode")}
            </Button>
          </div>
          {error ? <p className="field-error">{error}</p> : <p className="muted-text side-hint">{t("side.verifyHint")}</p>}
        </div>
      )}
    </section>
  )
}

/**
 * In the thread. The requester gets a card per verification: a code field while it's pending, then confirmed,
 * failed or expired (with Send a new code). The team gets one line each.
 */
export function VerificationThread({ app, issue, member }: { app: AppDetail; issue: Issue; member: boolean }) {
  const list = issue.verifications ?? []
  if (!list.length) return null
  if (member)
    return (
      <div className="verify-lines">
        {list.map((v) => (
          <VerificationLine key={v.id} v={v} />
        ))}
      </div>
    )
  if (!issue.viewer_is_author) return null
  // A replaced code leaves an expired row behind; once a later one for that address exists, only that one shows
  const latest = list.filter((v, i) => !list.slice(i + 1).some((w) => w.email === v.email))
  return (
    <>
      {latest.map((v) => (
        <VerificationCard key={v.id} app={app} issue={issue} v={v} />
      ))}
    </>
  )
}

function VerificationCard({ app, issue, v }: { app: AppDetail; issue: Issue; v: Verification }) {
  const t = useT()
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const masked = <strong>{maskEmail(v.email)}</strong>

  const confirm = async (value = code) => {
    if (busy || value.length !== 6) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.confirmVerification(app.slug, issue.number, v.id, value)
      putVerification(app.slug, issue.number, next)
    } catch (e) {
      if (e instanceof ApiFailure && e.code === "invalid_code") {
        setError(t("error.invalidCode"))
        // The server may have ended it (too many tries, or it expired): show where it stands
        load(keys.issue(app.slug, issue.number), () => api.issue(app.slug, issue.number)).catch(() => {})
      } else setError(e instanceof ApiFailure && e.status === 429 ? t("error.limitLater") : errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const again = async () => {
    setBusy(true)
    setError(null)
    try {
      putVerification(app.slug, issue.number, await api.requestVerification(app.slug, issue.number, v.email))
      setCode("")
    } catch (e) {
      setError(e instanceof ApiFailure && e.status === 429 ? t("error.limitLater") : errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (v.state === "verified")
    return (
      <div className="verify-card" data-state="verified">
        <p className="verify-card-title">
          <CheckIcon size={14} />
          <span>{tr("verify.done", { email: masked })}</span>
        </p>
      </div>
    )
  if (v.state !== "pending")
    return (
      <div className="verify-card" data-state={v.state}>
        <p className="verify-card-title">
          <MailIcon size={14} />
          <span>{tr(v.state === "failed" ? "verify.failed" : "verify.expired", { email: masked })}</span>
        </p>
        <div>
          <Button size="small" onClick={() => void again()} disabled={busy}>
            {t("verify.sendNew")}
          </Button>
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
    )
  return (
    <div className="verify-card" data-state="pending" role="group" aria-label={t("verify.asked", { workspace: app.name, email: maskEmail(v.email) })}>
      <p className="verify-card-title">
        <MailIcon size={14} />
        <span>{tr("verify.asked", { workspace: app.name, email: masked })}</span>
      </p>
      <p className="verify-card-text">{t("verify.askedText")}</p>
      <div className="verify-card-form">
        <div className="input" data-invalid={error ? "" : undefined}>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            placeholder="000000"
            aria-label={t("code.code")}
            value={code}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 6)
              setCode(digits)
              setError(null)
              if (digits.length === 6) void confirm(digits)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                void confirm()
              }
            }}
          />
        </div>
        <Button variant="primary" onClick={() => void confirm()} disabled={busy || code.length !== 6}>
          {busy ? t("verify.confirming") : t("verify.confirm")}
        </Button>
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}
