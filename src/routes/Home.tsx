import { useState, type FormEvent } from "react"
import { Link, useLocation, useSearch } from "wouter"
import type { App, Config } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { setData, useResource } from "../lib/cache"
import { Header, Page, useMe } from "../ui/Shell"
import { Button, Logo } from "../ui/primitives"
import { appLabel, appPath, isAbsolute } from "../lib/site"
import { SiteLink } from "../ui/SiteLink"

export function Home() {
  const { data: me, error } = useMe()
  if (!me) {
    return (
      <>
        <Header />
        {error ? <p className="page muted-text">{errorMessage(error)}</p> : null}
      </>
    )
  }
  return me.user ? <Apps /> : <SignIn />
}

function SignIn() {
  const { data: config } = useResource<Config>(keys.config, api.config, 60_000)
  const search = useSearch()
  const raw = new URLSearchParams(search).get("next") ?? "/"
  // Absolute next URLs come from app subdomains; the Worker only follows them back onto this site.
  const next = (raw.startsWith("/") && !raw.startsWith("//")) || isAbsolute(raw) ? raw : "/"
  const [email, setEmail] = useState("")

  const devLogin = (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    window.location.assign(`/auth/dev?email=${encodeURIComponent(email.trim())}&next=${encodeURIComponent(next)}`)
  }

  return (
    <main className="signin">
      <div className="signin-inner">
        <Logo size={32} />
        <h1 className="signin-title">Sign in to Bellhop</h1>
        {(!config || config.google_enabled || !config.dev_login) && (
          <a className="btn" data-size="large" href={`/auth/google?next=${encodeURIComponent(next)}`}>
            <GoogleMark />
            Continue with Google
          </a>
        )}
        {config?.dev_login && (
          <form className="signin-dev" onSubmit={devLogin}>
            <label className="field-label" htmlFor="dev-email">
              Development sign-in
            </label>
            <div className="row">
              <div className="input" style={{ flex: 1 }}>
                <input
                  id="dev-email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                />
              </div>
              <Button type="submit">Sign in</Button>
            </div>
          </form>
        )}
        <p className="signin-note">Reporting an issue doesn't need an account.</p>
      </div>
    </main>
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

function Apps() {
  const { data: apps, error } = useResource<App[]>(keys.apps, api.apps, 5_000)
  return (
    <>
      <Header />
      <Page>
        <div className="home-grid">
          <section className="box">
            <div className="box-header">
              <h2 className="box-title">Your applications</h2>
            </div>
            {!apps && !error && <div className="box-row skeleton-row" />}
            {!!error && <div className="box-row muted-text">{errorMessage(error)}</div>}
            {apps?.length === 0 && <div className="box-row muted-text">No applications yet.</div>}
            {apps?.map((app) => (
              <SiteLink key={app.id} href={appPath(app.slug)} className="box-row app-row">
                <div className="app-row-main">
                  <div className="app-row-title">
                    <span className="issue-title">{app.name}</span>
                    <span className="mono app-row-slug">{appLabel(app.slug)}</span>
                  </div>
                  {app.description && <div className="issue-meta">{app.description}</div>}
                </div>
                <span className="role-badge">{app.role === "owner" ? "Owner" : "Member"}</span>
              </SiteLink>
            ))}
          </section>
          <NewApp />
        </div>
      </Page>
    </>
  )
}

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")

const reserved = new Set(["api", "auth", "media", "mcp", "new", "settings", "_design"])

function NewApp() {
  const [, navigate] = useLocation()
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const [description, setDescription] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const effectiveSlug = slugEdited ? slug : slugify(name)
  const slugProblem = !effectiveSlug
    ? null
    : !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(effectiveSlug)
      ? "Use 2–40 lowercase letters, digits and hyphens."
      : reserved.has(effectiveSlug)
        ? "That slug is reserved."
        : null

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !effectiveSlug || slugProblem) return
    setSaving(true)
    setError(null)
    try {
      const app = await api.createApp({ name: name.trim(), slug: effectiveSlug, description: description.trim() || undefined })
      setData(keys.app(app.slug), app)
      setData<App[]>(keys.apps, (apps) => [...(apps ?? []), app].sort((a, b) => a.name.localeCompare(b.name)))
      const settings = appPath(app.slug, "/settings")
      if (isAbsolute(settings)) window.location.assign(settings)
      else navigate(settings)
    } catch (err) {
      setError(err instanceof ApiFailure && err.status === 409 ? "That slug is taken." : errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <form className="new-app" onSubmit={submit}>
      <h2 className="section-title">New application</h2>
      <div className="field">
        <label className="field-label" htmlFor="app-name">
          Name
        </label>
        <div className="input">
          <input id="app-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="OpenCode" required maxLength={80} />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="app-slug">
          URL
        </label>
        <div className="input">
          <span className="input-prefix mono">{location.host}/</span>
          <input
            id="app-slug"
            className="mono"
            value={effectiveSlug}
            onChange={(e) => {
              setSlugEdited(true)
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40))
            }}
            placeholder="opencode"
            required
          />
        </div>
        {slugProblem && <p className="field-error">{slugProblem}</p>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="app-description">
          Description <span className="muted-text">(optional)</span>
        </label>
        <textarea
          id="app-description"
          className="textarea"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={500}
        />
      </div>
      {!!error && <p className="flash" data-tone="danger">{error}</p>}
      <div>
        <Button type="submit" variant="primary" disabled={saving || !name.trim() || !effectiveSlug || !!slugProblem}>
          {saving ? "Creating…" : "Create application"}
        </Button>
      </div>
    </form>
  )
}
