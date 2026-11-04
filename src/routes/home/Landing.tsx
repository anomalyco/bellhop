import { useState, type FormEvent } from "react"
import type { Config } from "../../../shared/api"
import { api, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { addressParts } from "../../lib/site"
import { Button, Logo } from "../../ui/primitives"
import shot from "../../assets/landing-issue.webp"
import "../../styles/onboarding.css"

/** blhp.app signed out: what Bellhop is, the three things that make it different, and the way in. */
export function Landing({ next }: { next: string }) {
  const { prefix, suffix } = addressParts()
  return (
    <main className="landing">
      <div className="landing-inner">
        <div className="landing-copy">
          <Logo size={26} />
          <h1 className="landing-title">A live support site for your product</h1>
          <p className="landing-lede">Your AI agent answers issues as they come in, and your team steps in when it's needed.</p>
          <ul className="landing-points">
            <li>People report bugs and questions without an account.</li>
            <li>Your agent works them live over MCP: it replies, labels and closes.</li>
            <li>
              Every workspace gets its own address, like{" "}
              <code className="landing-address">
                {prefix}name{suffix}
              </code>
              .
            </li>
          </ul>
          <div className="landing-actions">
            <SignInActions next={next} />
          </div>
        </div>
        <figure className="landing-shot">
          <img
            src={shot}
            width={1200}
            height={600}
            alt="A Bellhop workspace: a guest's question about MCP servers, answered by the OpenCode agent, which then marks it as waiting on the reporter"
            decoding="async"
            loading="lazy"
          />
        </figure>
      </div>
    </main>
  )
}

/** Continue with Google (and the development sign-in when it's on), returning to `next`. */
export function SignInActions({ next }: { next: string }) {
  const { data: config } = useResource<Config>(keys.config, api.config, 60_000)
  const [email, setEmail] = useState("")

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
              <input id="dev-email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
            </div>
            <Button type="submit">Sign in</Button>
          </div>
        </form>
      )}
      <p className="signin-note">Reporting an issue doesn't need an account.</p>
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
