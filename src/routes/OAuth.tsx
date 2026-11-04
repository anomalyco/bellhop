import { useState, type FormEvent, type ReactNode } from "react"
import { useSearch } from "wouter"
import type { OAuthRequest } from "../../shared/api"
import { ApiFailure, api, errorMessage } from "../lib/api"
import { useResource } from "../lib/cache"
import { AppIcon, Button } from "../ui/primitives"
import { Header, useMe } from "../ui/Shell"
import { SignIn } from "./Home"

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

/** A request the server no longer knows, or one already answered. */
const gone = (e: unknown) => e instanceof ApiFailure && (e.status === 404 || e.status === 409 || e.status === 410)

function Expired() {
  return (
    <div className="oauth-card oauth-done">
      <h1 className="oauth-title">This request has expired</h1>
      <p className="muted-text">It was already used or timed out. Start again from your agent.</p>
    </div>
  )
}

/** Who's asking, which workspaces to grant, what it can do there, then Allow or Deny. Shared by both pages. */
export function ConsentForm({ request }: { request: OAuthRequest }) {
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<"approved" | "denied" | "expired" | null>(null)
  const expired = new Date(request.expires_at).getTime() <= Date.now()

  const answer = async (approve: boolean) => {
    setBusy(approve ? "approve" : "deny")
    setError(null)
    try {
      const { redirect_to } = approve ? await api.approve(request.id, picked) : await api.deny(request.id)
      if (redirect_to) return window.location.assign(redirect_to)
      setDone(approve ? "approved" : "denied")
    } catch (e) {
      if (gone(e)) setDone("expired")
      else setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  if (expired || done === "expired") return <Expired />
  if (done)
    return (
      <div className="oauth-card oauth-done">
        <h1 className="oauth-title">{done === "approved" ? "You're connected" : "Request denied"}</h1>
        <p className="muted-text">{done === "approved" ? "Return to your agent." : `${request.client_name} didn't get access. You can close this page.`}</p>
      </div>
    )

  const toggle = (id: string) => setPicked((list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]))

  return (
    <div className="oauth-card">
      <h1 className="oauth-title">{request.client_name} wants to access your workspaces</h1>
      {request.redirect_host && (
        <p className="oauth-sub">
          You'll be sent back to <span className="mono">{request.redirect_host}</span>
        </p>
      )}

      {request.apps.length ? (
        <fieldset className="oauth-apps">
          <legend className="sr-only">Workspaces</legend>
          {request.apps.map((app) => (
            <label key={app.id} className="oauth-app">
              <input type="checkbox" checked={picked.includes(app.id)} onChange={() => toggle(app.id)} />
              <AppIcon src={app.icon_url} size={24} />
              <span className="oauth-app-name">{app.name}</span>
              <span className="role-badge">{app.role === "owner" ? "Owner" : "Member"}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="muted-text">You aren't on any workspace yet. Create one on the home page first.</p>
      )}

      <p className="oauth-scope">It can read and reply to issues, update status and labels, and manage webhooks where you're an owner.</p>
      {error && (
        <p className="flash" data-tone="danger">
          {error}
        </p>
      )}
      <div className="oauth-actions">
        <Button onClick={() => answer(false)} disabled={!!busy}>
          {busy === "deny" ? "Denying…" : "Deny"}
        </Button>
        <Button variant="primary" onClick={() => answer(true)} disabled={!!busy || picked.length === 0}>
          {busy === "approve" ? "Allowing…" : picked.length > 1 ? `Allow ${picked.length} workspaces` : "Allow"}
        </Button>
      </div>
    </div>
  )
}

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
  const [code, setCode] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const complete = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!complete || busy) return
    setBusy(true)
    setError(null)
    try {
      setRequestId((await api.deviceLookup(code)).request_id)
    } catch (err) {
      const status = err instanceof ApiFailure ? err.status : 0
      setError(
        status === 404
          ? "That code doesn't match any request. Check it on your agent and try again."
          : status === 410 || (err instanceof ApiFailure && /expired/.test(err.code))
            ? "That code has expired. Ask your agent for a new one."
            : errorMessage(err),
      )
    } finally {
      setBusy(false)
    }
  }

  if (requestId) return <ConsentLoader id={requestId} />

  return (
    <form className="oauth-card" onSubmit={submit}>
      <h1 className="oauth-title">Connect an agent</h1>
      <p className="oauth-sub">Enter the code your agent shows.</p>
      <div className="input device-code" data-size="large" data-invalid={error ? "" : undefined}>
        <input
          value={code}
          onChange={(e) => setCode(formatCode(e.target.value))}
          placeholder="XXXX-XXXX"
          aria-label="Device code"
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
          {busy ? "Checking…" : "Continue"}
        </Button>
      </div>
    </form>
  )
}
