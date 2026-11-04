import type { ReactNode } from "react"
import { useLocation } from "wouter"
import type { App, ConnectedAgent } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { useResource } from "../lib/cache"
import { appLabel, appPath, homeUrl } from "../lib/site"
import { PlusIcon } from "../ui/icons"
import { AgentAvatar, AppIcon } from "../ui/primitives"
import { Header, Page, useMe } from "../ui/Shell"
import { SiteLink } from "../ui/SiteLink"
import { AgentSetup } from "../ui/onboarding/AgentSetup"
import { accessSummary } from "../ui/agents/access"
import { RoleBadge } from "../ui/roles/RoleSelect"
import { InvitationsSection, useInvitations } from "../ui/features/Invitations"
import "../styles/agents.css"
import { CreateWorkspace } from "./home/CreateWorkspace"
import { SignIn } from "./home/SignIn"
import "../styles/onboarding.css"

/** Pages for signed-in accounts only: the sign-in panel (returning here) until then. */
function Account({ back, children }: { back: string; children: () => ReactNode }) {
  const { data: me, error } = useMe()
  if (!me)
    return (
      <>
        <Header />
        {error ? <p className="page muted-text">{errorMessage(error)}</p> : null}
      </>
    )
  if (!me.user) return <SignIn back={back} />
  return <>{children()}</>
}

/** /workspaces: your workspaces and agents. A new account with none gets the create step right here. */
export function WorkspacesPage() {
  return <Account back="/workspaces">{() => <Workspaces />}</Account>
}

/** /new: create a workspace, then land on its issue list. */
export function NewWorkspacePage() {
  return <Account back="/new">{() => <NewWorkspace />}</Account>
}

function NewWorkspace() {
  const { data: apps } = useResource<App[]>(keys.apps, api.apps, 5_000)
  const [, navigate] = useLocation()
  return (
    <>
      <Header />
      <main className="create-page">
        {apps && <CreateWorkspace first={apps.length === 0} onCancel={() => (history.length > 1 ? history.back() : navigate("/workspaces"))} />}
      </main>
    </>
  )
}

function Workspaces() {
  const { data: fetched, error: appsError } = useResource<App[]>(keys.apps, api.apps, 5_000)
  // Invitations sit above the list; it waits for them (an error reads as none) so they never push it down.
  const { data: invitations, error: invitationsError } = useInvitations()
  const settled = !!invitations || !!invitationsError
  const apps = settled ? fetched : undefined
  const error = settled ? appsError : undefined

  if (apps && apps.length === 0 && !invitations?.length)
    return (
      <>
        <Header />
        <main className="create-page">
          <CreateWorkspace first />
        </main>
      </>
    )

  return (
    <>
      <Header />
      <Page narrow>
        <div className="home-head">
          <h1 className="page-title home-title">Your workspaces</h1>
          <SiteLink href="/new" className="btn" data-variant="primary">
            <PlusIcon size={14} />
            New workspace
          </SiteLink>
        </div>
        {invitations && <InvitationsSection invitations={invitations} />}
        <div className="box home-apps">
          {!apps && !error && <div className="box-row skeleton-row" />}
          {!!error && <div className="box-row muted-text">{errorMessage(error)}</div>}
          {apps?.length === 0 && <div className="box-empty">No workspaces yet. Accept an invitation above, or create one.</div>}
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
        {/* Below the list, so it waits for the list rather than being pushed down by it */}
        {(!!apps || !!error) && <ConnectedAgents />}
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
