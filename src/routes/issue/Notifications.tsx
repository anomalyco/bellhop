import { useEffect, useRef, useState, type FormEvent } from "react"
import type { IssueSubscription } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { load, setData, useResource } from "../../lib/cache"
import { ensureHuman } from "../../lib/human"
import { Button } from "../../ui/primitives"
import type { IssueModel } from "./model"
import "../../styles/features.css"
import { tKey, tr, useT, type PlainKey } from "../../i18n/core"
import { tr as trDesk, useT as useDeskT } from "../../i18n/helpdesk"

const reasonText: Record<NonNullable<IssueSubscription["reason"]>, PlainKey> = {
  opened: "notify.opened",
  replied: "notify.replied",
  mentioned: "notify.mentioned",
  assigned: "notify.assigned",
  manual: "notify.manual",
}

/**
 * Email about this issue. Accounts follow or unfollow (and see why they follow); guests give an email, confirm it
 * from their inbox, and can stop it later. Every state is a button over one or two lines of text in a fixed-height
 * slot, so loading and switching states never move the sidebar.
 */
export function NotificationsSection({ model }: { model: IssueModel }) {
  const t = useT()
  useDeskT()
  const { app, issue, me } = model
  const slug = app.slug
  const key = keys.subscription(slug, issue.number)
  const { data: sub, error } = useResource<IssueSubscription>(key, () => api.subscription(slug, issue.number), 5_000)
  const account = me ? !!me.user : null
  const [asking, setAsking] = useState(false)
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  // A guest confirms in another tab (the email's link): check again when they come back, and now and then meanwhile.
  const pending = !!sub?.pending
  useEffect(() => {
    if (!pending) return
    const check = () => load(key, () => api.subscription(slug, issue.number)).catch(() => {})
    const onVisible = () => document.visibilityState === "visible" && check()
    const timer = setInterval(check, 10_000)
    window.addEventListener("focus", check)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(timer)
      window.removeEventListener("focus", check)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [pending, key, slug, issue.number])

  useEffect(() => {
    if (asking) input.current?.focus()
  }, [asking])

  const put = async (subscribed: boolean, address?: string) => {
    setBusy(true)
    setFailure(null)
    try {
      await ensureHuman(!!me?.user)
      setData(key, await api.subscribe(slug, issue.number, subscribed, address))
      setAsking(false)
      setEmail("")
    } catch (e) {
      setFailure(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const address = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setFailure(t("notify.enterEmail"))
      input.current?.focus()
      return
    }
    void put(true, address)
  }

  let body
  if (!sub || account === null) {
    body = error ? (
      <p className="notify-text">{errorMessage(error)}</p>
    ) : (
      <>
        <span className="skeleton notify-skeleton-button" />
        <span className="skeleton notify-skeleton-line" />
      </>
    )
  } else if (me?.contact?.email) {
    // A help desk contact follows at their verified email, like an account: no address to give, nothing to confirm.
    // Their own requests are followed from the start.
    const address = <span className="notify-address">{me.contact.email}</span>
    body = sub.subscribed ? (
      <>
        <Button size="small" className="btn notify-button" onClick={() => void put(false)} disabled={busy}>
          {t("notify.stop")}
        </Button>
        <p className="notify-text">{tr("notify.repliesTo", { email: address })}</p>
      </>
    ) : (
      <>
        <Button size="small" className="btn notify-button" onClick={() => void put(true)} disabled={busy}>
          {t("notify.byEmail")}
        </Button>
        <p className="notify-text">{trDesk("notify.contactOff", { email: address })}</p>
      </>
    )
  } else if (account) {
    body = sub.subscribed ? (
      <>
        <Button size="small" className="btn notify-button" onClick={() => void put(false)} disabled={busy}>
          {t("notify.unfollow")}
        </Button>
        <p className="notify-text">{tKey(reasonText[sub.reason ?? "manual"])}</p>
      </>
    ) : (
      <>
        <Button size="small" className="btn notify-button" onClick={() => void put(true)} disabled={busy}>
          {t("notify.follow")}
        </Button>
        <p className="notify-text">{t("notify.followText")}</p>
      </>
    )
  } else if (asking) {
    body = (
      <form className="notify-form" onSubmit={submit} noValidate>
        <div className="notify-form-row">
          <div className="input" data-size="small" data-invalid={failure ? "" : undefined}>
            <input
              ref={input}
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setFailure(null)
              }}
              placeholder="you@example.com"
              aria-label={t("notify.yourEmail")}
              autoComplete="email"
              enterKeyHint="send"
              aria-invalid={!!failure}
            />
          </div>
          <Button type="submit" size="small" variant="primary" disabled={busy}>
            {busy ? t("notify.sending") : t("notify.sendLink")}
          </Button>
        </div>
        <p className="notify-text">
          {t("notify.confirmText")}{" "}
          <button type="button" className="link-button notify-cancel" onClick={() => (setAsking(false), setFailure(null))}>
            {t("common.cancel")}
          </button>
        </p>
      </form>
    )
  } else if (sub.pending) {
    body = (
      <>
        <p className="notify-status">{t("notify.checkInbox")}</p>
        <p className="notify-text">
          {tr("notify.sentTo", { email: <span className="notify-address">{sub.email}</span> })}{" "}
          <button type="button" className="link-button" onClick={() => void put(false)} disabled={busy}>
            {t("common.cancel")}
          </button>
        </p>
      </>
    )
  } else if (sub.subscribed) {
    body = (
      <>
        <Button size="small" className="btn notify-button" onClick={() => void put(false)} disabled={busy}>
          {t("notify.stop")}
        </Button>
        <p className="notify-text">{tr("notify.repliesTo", { email: <span className="notify-address">{sub.email}</span> })}</p>
      </>
    )
  } else {
    body = (
      <>
        <Button size="small" className="btn notify-button" onClick={() => setAsking(true)}>
          {t("notify.byEmail")}
        </Button>
        <p className="notify-text">{t("notify.byEmailText")}</p>
      </>
    )
  }

  return (
    <section className="side-section notify">
      <div className="side-head">
        <h3>{t("notify.title")}</h3>
      </div>
      <div className="notify-body" aria-live="polite">
        {body}
      </div>
      {failure && <p className="field-error notify-error">{failure}</p>}
    </section>
  )
}
