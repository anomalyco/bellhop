import { useEffect, useState, type FormEvent } from "react"
import { useLocation, useSearch } from "wouter"
import type { Config, Me } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { isAbsolute } from "../../lib/site"
import { AgentAvatar, Button } from "../../ui/primitives"
import { useMe } from "../../ui/Shell"
import "../../styles/onboarding.css"
import { useT } from "../../i18n/core"
import { tr, useT as useDeskT } from "../../i18n/helpdesk"
import { EmailCode } from "../../ui/helpdesk/EmailCode"
import { MailIcon } from "../../ui/icons"
import { ApiFailure } from "../../lib/api"

/** Where ?next= may send you after signing in: a path here, or an absolute URL (an app subdomain) the Worker vets. */
function safeNext(raw: string | null) {
  const next = raw ?? "/"
  return (next.startsWith("/") && !next.startsWith("//")) || isAbsolute(next) ? next : "/"
}

/** /signin: sign in, then back to ?next= (or the feed). Already signed in: straight there. */
export function SignInPage() {
  const { data: me, error } = useMe()
  const [, navigate] = useLocation()
  const back = new URLSearchParams(useSearch()).get("next")
  useEffect(() => {
    if (!me?.user) return
    if (!back) return navigate("/", { replace: true })
    const url = new URL(back, window.location.href)
    const host = window.location.hostname
    if (url.hostname === host || url.hostname.endsWith(`.${host}`)) window.location.replace(url.href)
  }, [me?.user, back, navigate])
  if (error && !me) return <p className="page muted-text">{errorMessage(error)}</p>
  // Signed in: on the way back (the effect above). Loading: nothing yet, the panel is centred on its own.
  if (!me || me.user) return null
  return <SignIn />
}

/** The sign-in panel. `back` overrides ?next= (pages like the OAuth consent sign in and return to themselves). */
export function SignIn({ back }: { back?: string }) {
  const t = useT()
  const search = useSearch()
  const next = safeNext(back ?? new URLSearchParams(search).get("next"))
  // Which sign-in methods show depends on the config; the panel is centred, so wait for it rather than re-centre.
  const { data: config, error } = useResource<Config>(keys.config, api.config, 60_000)
  if (!config && !error) return <main className="signin" />
  return (
    <main className="signin">
      <div className="signin-inner">
        <AgentAvatar size={36} />
        <h1 className="signin-title">{t("signin.title")}</h1>
        <SignInActions next={next} />
      </div>
    </main>
  )
}

/** Continue with Google (and the development sign-in when it's on), returning to `next`. */
export function SignInActions({ next }: { next: string }) {
  const t = useT()
  const td = useDeskT()
  const { data: config } = useResource<Config>(keys.config, api.config, 60_000)
  const [email, setEmail] = useState("")
  const [byEmail, setByEmail] = useState(false)

  if (byEmail)
    return (
      <div className="signin-actions">
        <EmailCode<Me>
          id="account-email"
          autoFocus
          start={(address) => api.emailStart(address)}
          // Both steps always answer ok (nothing reveals how an address signs in): the session tells
          verify={async (address, code) => {
            await api.emailVerify(address, code)
            const me = await api.me()
            if (!me.user) throw new ApiFailure(400, "invalid_code", "")
            return me
          }}
          sentTo={(address) => tr("account.sentTo", { email: address })}
          invalidMessage={td("account.invalid")}
          onVerified={() => window.location.assign(next)}
        />
        <button type="button" className="link-button signin-back" onClick={() => setByEmail(false)}>
          {td("account.otherWays")}
        </button>
      </div>
    )

  const devLogin = (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    window.location.assign(`/auth/dev?email=${encodeURIComponent(email.trim())}&next=${encodeURIComponent(next)}`)
  }

  return (
    <div className="signin-actions">
      {(!config || config.google_enabled || !config.dev_login) && (
        <a className="btn signin-google" data-variant="primary" data-size="large" href={`/auth/google?next=${encodeURIComponent(next)}`}>
          <GoogleMark />
          {t("signin.google")}
        </a>
      )}
      {config?.email_sign_in && (
        <Button size="large" className="btn signin-email" onClick={() => setByEmail(true)} icon={<MailIcon size={16} />}>
          {td("account.continueEmail")}
        </Button>
      )}
      {config?.dev_login && (
        <form className="signin-dev" onSubmit={devLogin}>
          <label className="field-label" htmlFor="dev-email">
            {t("signin.dev")}
          </label>
          <div className="row">
            <div className="input" style={{ flex: 1 }}>
              <input id="dev-email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </div>
            <Button type="submit">{t("common.signIn")}</Button>
          </div>
        </form>
      )}
      <p className="signin-note">{t("signin.note")}</p>
    </div>
  )
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  )
}
