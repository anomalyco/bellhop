import { useState, type FormEvent } from "react"
import type { AgentAccess, App, ConnectedAgent, NewAgentToken } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { setData, useResource } from "../lib/cache"
import { Time } from "../lib/time"
import { KebabIcon, PlusIcon } from "../ui/icons"
import { Menu, MenuItem } from "../ui/Menu"
import { AgentAvatar, Button } from "../ui/primitives"
import { Header, Page, useMe } from "../ui/Shell"
import { AccessEditor, emptyAccess, grantsAnything, type AccessApp } from "../ui/agents/AccessEditor"
import { accessApps, accessOf, accessSummary } from "../ui/agents/access"
import { SecretReveal } from "../ui/agents/SecretReveal"
import { AgentSetup } from "../ui/onboarding/AgentSetup"
import { SignIn } from "./Home"
import "../styles/agents.css"

/** The account's agents (/agents on the home domain): OAuth connections and token agents, their access, secrets. */
export function AgentsPage() {
  const { data: me } = useMe()
  if (!me) return <Header />
  if (!me.user) return <SignIn back="/agents" />
  return (
    <>
      <Header />
      <Page narrow>
        <Agents />
      </Page>
    </>
  )
}

function Agents() {
  const { data: agents, error } = useResource<ConnectedAgent[]>(keys.agents, api.agents, 5_000)
  const { data: apps } = useResource<App[]>(keys.apps, api.apps, 10_000)
  const [creating, setCreating] = useState(false)
  const [secret, setSecret] = useState<{ agent: NewAgentToken; rotated: boolean } | null>(null)
  const workspaces = accessApps(apps)

  const store = (next: ConnectedAgent) =>
    setData<ConnectedAgent[]>(keys.agents, (list) => (list?.some((a) => a.id === next.id) ? list.map((a) => (a.id === next.id ? next : a)) : [next, ...(list ?? [])]))

  return (
    <div className="agents-page">
      <div className="agents-head">
        <h1 className="page-title agents-title">Agents</h1>
        {!creating && (
          <Button variant="primary" icon={<PlusIcon size={14} />} onClick={() => setCreating(true)}>
            New token agent
          </Button>
        )}
      </div>
      <p className="agents-intro">Agents act for your account, only in the workspaces you choose and never above your own role there.</p>

      {secret && <SecretReveal agent={secret.agent} rotated={secret.rotated} onDone={() => setSecret(null)} />}

      {creating && (
        <NewTokenAgent
          apps={workspaces}
          onCancel={() => setCreating(false)}
          onCreated={(agent) => {
            const { token: _secret, ...stored } = agent
            store(stored)
            setCreating(false)
            setSecret({ agent, rotated: false })
          }}
        />
      )}

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
      {agents?.length === 0 && !creating && (
        <div className="agents-empty">
          <p className="muted-text">No agents yet. Connect one over MCP, or create a token agent for scripts and CI.</p>
          <AgentSetup />
        </div>
      )}
      {!!agents?.length && (
        <div className="box agents-list">
          {agents.map((agent) => (
            <AgentItem
              key={agent.id}
              agent={agent}
              apps={workspaces}
              onChange={store}
              onRemoved={() => setData<ConnectedAgent[]>(keys.agents, (list) => list?.filter((a) => a.id !== agent.id))}
              onRotated={(next) => {
                const { token: _secret, ...stored } = next
                store(stored)
                setSecret({ agent: next, rotated: true })
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function NewTokenAgent({ apps, onCreated, onCancel }: { apps: AccessApp[]; onCreated: (a: NewAgentToken) => void; onCancel: () => void }) {
  const [name, setName] = useState("")
  const [access, setAccess] = useState<AgentAccess>(emptyAccess)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = !!name.trim() && grantsAnything(access)

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.createAgent({ ...access, name: name.trim() }))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="agent-create" onSubmit={create}>
      <h2 className="agent-create-title">New token agent</h2>
      <p className="agents-intro">For scripts, CI or any agent you configure with a secret. It posts under this name, with an AI badge.</p>
      <div className="field">
        <label className="field-label" htmlFor="agent-name">
          Name
        </label>
        <div className="input">
          <input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Release bot" maxLength={100} autoFocus autoComplete="off" />
        </div>
      </div>
      <div className="field">
        <span className="field-label">Access</span>
        <AccessEditor apps={apps} value={access} onChange={setAccess} name="new-agent" />
      </div>
      {error && (
        <p className="flash" data-tone="danger">
          {error}
        </p>
      )}
      <div className="agent-actions">
        <Button variant="invisible" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!ready || busy}>
          {busy ? "Creating…" : "Create agent"}
        </Button>
      </div>
    </form>
  )
}

type Mode = "edit" | "rename" | "revoke" | "rotate" | null

function AgentItem({
  agent,
  apps,
  onChange,
  onRemoved,
  onRotated,
}: {
  agent: ConnectedAgent
  apps: AccessApp[]
  onChange: (a: ConnectedAgent) => void
  onRemoved: () => void
  onRotated: (a: NewAgentToken) => void
}) {
  const [mode, setMode] = useState<Mode>(null)
  const [access, setAccess] = useState<AgentAccess>(() => accessOf(agent))
  const [name, setName] = useState(agent.client_name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const token = agent.kind === "token"

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setMode(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const open = (next: Mode) => {
    setError(null)
    if (next === "edit") setAccess(accessOf(agent))
    if (next === "rename") setName(agent.client_name)
    setMode(next)
  }

  return (
    <div className="agent-item" data-open={mode === "edit" || undefined}>
      <div className="box-row agent-row">
        <AgentAvatar size={28} />
        <div className="agent-main">
          {mode === "rename" ? (
            <form
              className="agent-rename"
              onSubmit={(e) => {
                e.preventDefault()
                if (name.trim()) void run(async () => onChange(await api.patchAgent(agent.id, { name: name.trim() })))
              }}
            >
              <div className="input" data-size="small">
                <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Agent name" maxLength={100} autoFocus />
              </div>
              <Button type="submit" size="small" variant="primary" disabled={busy || !name.trim()}>
                Save
              </Button>
              <Button size="small" variant="invisible" onClick={() => setMode(null)}>
                Cancel
              </Button>
            </form>
          ) : (
            <div className="agent-name-line">
              <span className="agent-name">{agent.client_name}</span>
              <span className="agent-kind">
                {token ? (
                  <>
                    Token agent{agent.preview && <span className="mono agent-preview"> {agent.preview}</span>}
                  </>
                ) : (
                  "Connected app"
                )}
              </span>
            </div>
          )}
          <div className="agent-access">{accessSummary(agent)}</div>
          <div className="agent-meta">
            {agent.create_workspaces && "Can create workspaces · "}Added <Time iso={agent.created_at} /> ·{" "}
            {agent.last_used_at ? (
              <>
                last used <Time iso={agent.last_used_at} />
              </>
            ) : (
              "not used yet"
            )}
          </div>
          {error && <p className="field-error">{error}</p>}
        </div>

        {mode === "revoke" || mode === "rotate" ? (
          <div className="agent-confirm-inline">
            <span className="agent-confirm-text">{mode === "revoke" ? (token ? "Revoke it? It stops working at once." : "Disconnect it? It loses access at once.") : "The current secret stops working at once."}</span>
            <Button size="small" variant="invisible" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </Button>
            {mode === "revoke" ? (
              <Button size="small" variant="danger" disabled={busy} onClick={() => run(async () => (await api.disconnectAgent(agent.id), onRemoved()))}>
                {busy ? "…" : token ? "Revoke" : "Disconnect"}
              </Button>
            ) : (
              <Button size="small" variant="danger" disabled={busy} onClick={() => run(async () => onRotated(await api.rotateAgent(agent.id)))}>
                {busy ? "…" : "Rotate secret"}
              </Button>
            )}
          </div>
        ) : (
          mode !== "rename" && (
            <div className="agent-row-actions">
              <Button size="small" onClick={() => open(mode === "edit" ? null : "edit")} aria-expanded={mode === "edit"} aria-label={`Edit access for ${agent.client_name}`}>
                Edit<span className="wide-only"> access</span>
              </Button>
              <Menu
                align="end"
                width={220}
                trigger={(p) => <Button iconOnly size="small" variant="invisible" aria-label={`More for ${agent.client_name}`} icon={<KebabIcon />} {...p} />}
              >
                {(close) => (
                  <>
                    {token && (
                      <MenuItem
                        onSelect={() => {
                          close()
                          open("rename")
                        }}
                      >
                        Rename
                      </MenuItem>
                    )}
                    {token && (
                      <MenuItem
                        description="Get a new secret; the old one stops"
                        onSelect={() => {
                          close()
                          open("rotate")
                        }}
                      >
                        Rotate secret
                      </MenuItem>
                    )}
                    <MenuItem
                      danger
                      onSelect={() => {
                        close()
                        open("revoke")
                      }}
                    >
                      {token ? "Revoke" : "Disconnect"}
                    </MenuItem>
                  </>
                )}
              </Menu>
            </div>
          )
        )}
      </div>

      {mode === "edit" && (
        <div className="agent-panel">
          <AccessEditor apps={apps} value={access} onChange={setAccess} name={`agent-${agent.id}`} />
          {!grantsAnything(access) && <p className="agent-warning">With nothing chosen it can't work anywhere until you give it access again.</p>}
          <div className="agent-actions">
            <Button variant="invisible" onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => run(async () => onChange(await api.patchAgent(agent.id, access)))}>
              {busy ? "Saving…" : "Save access"}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
