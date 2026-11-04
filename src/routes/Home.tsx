import { useEffect, useState } from "react"
import { useSearch } from "wouter"
import type { App, ConnectedAgent } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { useResource } from "../lib/cache"
import { appLabel, appPath, homeUrl, isAbsolute } from "../lib/site"
import { PlusIcon } from "../ui/icons"
import { AgentAvatar, AppIcon, Button } from "../ui/primitives"
import { Header, Page, useMe } from "../ui/Shell"
import { SiteLink } from "../ui/SiteLink"
import { AgentSetup } from "../ui/onboarding/AgentSetup"
import { accessSummary } from "../ui/agents/access"
import { RoleBadge } from "../ui/roles/RoleSelect"
import "../styles/agents.css"
import { CreateWorkspace } from "./home/CreateWorkspace"
import { Landing, SignInActions } from "./home/Landing"
import "../styles/onboarding.css"

/** Where ?next= may send you after signing in: a path here, or an absolute URL (an app subdomain) the Worker vets. */
function safeNext(raw: string | null) {
  const next = raw ?? "/"
  return (next.startsWith("/") && !next.startsWith("//")) || isAbsolute(next) ? next : "/"
}

export function Home() {
  const { data: me, error } = useMe()
  const back = new URLSearchParams(useSearch()).get("next")
  // Already signed in and sent here to sign in (e.g. from an app subdomain): go straight back.
  useEffect(() => {
    if (!me?.user || !back) return
    const url = new URL(back, window.location.href)
    const host = window.location.hostname
    if (url.hostname === host || url.hostname.endsWith(`.${host}`)) window.location.replace(url.href)
  }, [me?.user, back])
  if (!me) {
    return (
      <>
        <Header />
        {error ? <p className="page muted-text">{errorMessage(error)}</p> : null}
      </>
    )
  }
  if (me.user) return <Workspaces />
  // Sent here to sign in from somewhere else: just the sign-in. A first visit: the landing.
  return back ? <SignIn /> : <Landing next="/" />
}

/** The plain sign-in page. `back` overrides ?next= (pages like the OAuth consent sign in and return to themselves). */
export function SignIn({ back }: { back?: string }) {
  const search = useSearch()
  const next = safeNext(back ?? new URLSearchParams(search).get("next"))
  return (
    <main className="signin">
      <div className="signin-inner">
        <AgentAvatar size={36} />
        <h1 className="signin-title">Sign in to Bellhop</h1>
        <SignInActions next={next} />
      </div>
    </main>
  )
}

/** Signed in: the first-workspace step for a new account, otherwise the workspace list and connected agents. */
function Workspaces() {
  const { data: apps, error } = useResource<App[]>(keys.apps, api.apps, 5_000)
  const [creating, setCreating] = useState(false)

  if (apps && (apps.length === 0 || creating))
    return (
      <>
        <Header />
        <main className="create-page">
          <CreateWorkspace first={apps.length === 0} onCancel={apps.length ? () => setCreating(false) : undefined} />
        </main>
      </>
    )

  return (
    <>
      <Header />
      <Page narrow>
        <div className="home-head">
          <h1 className="page-title home-title">Your workspaces</h1>
          <Button variant="primary" icon={<PlusIcon size={14} />} onClick={() => setCreating(true)} disabled={!apps}>
            New workspace
          </Button>
        </div>
        <div className="box">
          {!apps && !error && <div className="box-row skeleton-row" />}
          {!!error && <div className="box-row muted-text">{errorMessage(error)}</div>}
          {apps?.map((app) => (
            <SiteLink key={app.id} href={appPath(app.slug)} className="box-row app-row">
              <AppIcon src={app.icon_url} size={28} />
              <div className="app-row-main">
                <div className="app-row-title">
                  <span className="app-row-name">{app.name}</span>
                  <span className="mono app-row-slug">{appLabel(app.slug)}</span>
                </div>
                {app.description && <div className="issue-meta">{app.description}</div>}
              </div>
              {app.role && <RoleBadge role={app.role} />}
            </SiteLink>
          ))}
        </div>
        <ConnectedAgents />
      </Page>
    </>
  )
}

/** A short list of the account's agents with a link to manage them; how to connect one when there are none. */
function ConnectedAgents() {
  const { data: agents, error } = useResource<ConnectedAgent[]>(keys.agents, api.agents, 10_000)
  const manage = homeUrl("/agents")
  return (
    <section className="home-agents">
      <div className="home-agents-head">
        <h2 className="section-title">Agents</h2>
        {!!agents?.length && (
          <SiteLink href={manage} className="home-agents-link">
            Manage agents
          </SiteLink>
        )}
      </div>
      {!agents && !error && (
        <div className="box">
          <div className="box-row skeleton-row" />
        </div>
      )}
      {!!error && (
        <div className="box">
          <div className="box-row muted-text">{errorMessage(error)}</div>
        </div>
      )}
      {agents?.length === 0 && (
        <div className="home-agents-empty">
          <p className="muted-text">
            Connect your agent so it can answer issues in your workspaces, or <SiteLink href={manage}>create a token agent</SiteLink>.
          </p>
          <AgentSetup />
        </div>
      )}
      {!!agents?.length && (
        <div className="box">
          {agents.slice(0, 4).map((agent) => (
            <SiteLink key={agent.id} href={manage} className="box-row agent-row home-agent-row">
              <AgentAvatar size={28} />
              <div className="app-row-main">
                <div className="app-row-title">
                  <span className="app-row-name">{agent.client_name}</span>
                  <span className="agent-kind">{agent.kind === "token" ? "Token agent" : "Connected app"}</span>
                </div>
                <div className="issue-meta">{accessSummary(agent)}</div>
              </div>
            </SiteLink>
          ))}
          {agents.length > 4 && (
            <SiteLink href={manage} className="box-row home-agents-more">
              {agents.length - 4} more
            </SiteLink>
          )}
        </div>
      )}
    </section>
  )
}
