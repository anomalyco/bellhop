import { useState, type FormEvent, type ReactNode } from "react"
import { useSearch } from "wouter"
import type { AgentAccess, OAuthRequest } from "../../shared/api"
import { ApiFailure, api, errorMessage } from "../lib/api"
import { useResource } from "../lib/cache"
import { AccessEditor, emptyAccess, grantsAnything } from "../ui/agents/AccessEditor"
import { Button } from "../ui/primitives"
import { Header, useMe } from "../ui/Shell"
import { SignIn } from "./home/SignIn"
import { tr, useT } from "../i18n/core"

/** Pages an agent sends you to: sign in first, then return here. */
function SignedIn({ children }: { children: () => ReactNode }) {
  const { data: me } = useMe()
  if (!me) return <Header />
  if (!me.user) return <SignIn back={window.location.pathname + window.location.search} />
  return (
    <>
      <Header />
      <main className="oauth">{children()}</main>
    </>
  )
}

/** /oauth/consent?request=<id>: an agent asking for access to some of your workspaces. */
export function Consent() {
  const id = new URLSearchParams(useSearch()).get("request") ?? ""
  return <SignedIn>{() => (id ? <ConsentLoader id={id} /> : <Expired />)}</SignedIn>
}

function ConsentLoader({ id }: { id: string }) {
  const { data: request, error } = useResource<OAuthRequest>(`oauth:${id}`, () => api.oauthRequest(id), 60_000)
  if (error) return gone(error) ? <Expired /> : <p className="flash" data-tone="danger">{errorMessage(error)}</p>
  if (!request) return <div className="oauth-card skeleton" style={{ height: 240 }} />
  return <ConsentForm request={request} />
}

/** The Worker answers 404 for a request that expired, was already answered, or was started in another browser. */
const gone = (e: unknown) => e instanceof ApiFailure && e.status === 404

function Expired() {
  const t = useT()
  return (
    <div className="oauth-card oauth-done">
      <h1 className="oauth-title">{t("oauth.expired")}</h1>
      <p className="muted-text">{t("oauth.expiredText")}</p>
    </div>
  )
}

/** Who's asking, which workspaces to grant, what it can do there, then Allow or Deny. Shared by both pages. */
export function ConsentForm({ request }: { request: OAuthRequest }) {
  const t = useT()
  const [access, setAccess] = useState<AgentAccess>(emptyAccess)
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<"approved" | "denied" | "expired" | null>(null)
  const expired = new Date(request.expires_at).getTime() <= Date.now()

  const answer = async (approve: boolean) => {
    setBusy(approve ? "approve" : "deny")
    setError(null)
    try {
      const { redirect_to } = approve ? await api.approve(request.id, access) : await api.deny(request.id)
      if (redirect_to) return window.location.assign(redirect_to)
      setDone(approve ? "approved" : "denied")
    } catch (e) {
      if (gone(e)) setDone("expired")
      else if (e instanceof ApiFailure && (e.status === 403 || /exceeds/i.test(e.message)))
        setError(t("oauth.tooMuch"))
      else setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  if (expired || done === "expired") return <Expired />
  if (done)
    return (
      <div className="oauth-card oauth-done">
        <h1 className="oauth-title">{done === "approved" ? t("oauth.connected") : t("oauth.denied")}</h1>
        <p className="muted-text">{done === "approved" ? t("oauth.return") : t("oauth.deniedText", { name: request.client_name })}</p>
      </div>
    )

  return (
    <div className="oauth-card">
      <h1 className="oauth-title">{t("oauth.wants", { name: request.client_name })}</h1>
      {request.redirect_host && (
        <p className="oauth-sub">
          {tr("oauth.sentBack", { host: <span className="mono">{request.redirect_host}</span> })}
        </p>
      )}
      <p className="oauth-scope">{t("oauth.scope")}</p>
      <AccessEditor apps={request.apps} value={access} onChange={setAccess} name="consent" />
      {error && (
        <p className="flash" data-tone="danger">
          {error}
        </p>
      )}
      <div className="oauth-actions">
        <Button onClick={() => answer(false)} disabled={!!busy}>
          {busy === "deny" ? t("oauth.denying") : t("oauth.deny")}
        </Button>
        <Button variant="primary" onClick={() => answer(true)} disabled={!!busy || !grantsAnything(access)}>
          {busy === "approve" ? t("oauth.allowing") : t("oauth.allow")}
        </Button>
      </div>
    </div>
  )
}

/** Codes use digits 2–9 and letters without I and O, shown as XXXX-XXXX. */
const codeShape = /^[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/

/** XXXX-XXXX: letters and digits only, upper case, the dash after four. */
function formatCode(raw: string) {
  const chars = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8)
  return chars.length > 4 ? `${chars.slice(0, 4)}-${chars.slice(4)}` : chars
}

/** /device: a headless agent shows a code; enter it here, then grant access like the consent page. */
export function Device() {
  const initial = new URLSearchParams(useSearch()).get("code") ?? ""
  return <SignedIn>{() => <DeviceForm initial={formatCode(initial)} />}</SignedIn>
}

function DeviceForm({ initial }: { initial: string }) {
  const t = useT()
  const [code, setCode] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const complete = code.length === 9
  const invalid = t("device.invalid")

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!complete || busy) return
    if (!codeShape.test(code)) return setError(invalid)
    setBusy(true)
    setError(null)
    try {
      setRequestId((await api.deviceLookup(code)).request_id)
    } catch (err) {
      const status = err instanceof ApiFailure ? err.status : 0
      // Unknown and expired codes both come back as 404; the Worker doesn't tell them apart.
      setError(
        status === 404
          ? t("device.notFound")
          : status === 400
            ? invalid
            : errorMessage(err),
      )
    } finally {
      setBusy(false)
    }
  }

  if (requestId) return <ConsentLoader id={requestId} />

  return (
    <form className="oauth-card" onSubmit={submit}>
      <h1 className="oauth-title">{t("device.title")}</h1>
      <p className="oauth-sub">{t("device.sub")}</p>
      <div className="input device-code" data-size="large" data-invalid={error ? "" : undefined}>
        <input
          value={code}
          onChange={(e) => setCode(formatCode(e.target.value))}
          placeholder="XXXX-XXXX"
          aria-label={t("device.code")}
          aria-invalid={!!error}
          aria-describedby={error ? "device-error" : undefined}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          inputMode="text"
          autoFocus
        />
      </div>
      {error && (
        <p id="device-error" className="field-error">
          {error}
        </p>
      )}
      <div className="oauth-actions">
        <Button type="submit" variant="primary" disabled={!complete || busy}>
          {busy ? t("device.checking") : t("device.continue")}
        </Button>
      </div>
    </form>
  )
}
