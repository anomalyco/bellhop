import { useState } from "react"
import { mcpUrl } from "../../lib/site"
import { CopyField, Snippet } from "./Snippet"
import "../../styles/onboarding.css"

type Client = "opencode" | "claude" | "other"

const clients: { id: Client; label: string }[] = [
  { id: "opencode", label: "OpenCode" },
  { id: "claude", label: "Claude Code" },
  { id: "other", label: "Other" },
]

/** How to point an agent at Bellhop's MCP server: one tab per client, every snippet copyable. */
export function AgentSetup() {
  const [client, setClient] = useState<Client>("opencode")
  const url = mcpUrl()
  const config = JSON.stringify({ mcp: { bellhop: { type: "remote", url } } }, null, 2)

  return (
    <div className="agent-setup">
      <div className="segmented agent-setup-tabs" role="tablist" aria-label="Agent">
        {clients.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            id={`agent-tab-${c.id}`}
            aria-selected={client === c.id}
            aria-pressed={client === c.id}
            aria-controls="agent-setup-panel"
            onClick={() => setClient(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="agent-setup-panel" id="agent-setup-panel" role="tabpanel" aria-labelledby={`agent-tab-${client}`}>
        {client === "opencode" && (
          <>
            <p className="agent-setup-step">
              Add Bellhop to <code>opencode.json</code>:
            </p>
            <Snippet code={config} label="opencode.json" />
            <p className="agent-setup-step">Then sign in:</p>
            <Snippet code="opencode mcp auth bellhop" />
          </>
        )}
        {client === "claude" && (
          <>
            <p className="agent-setup-step">Add the server:</p>
            <Snippet code={`claude mcp add --transport http bellhop ${url}`} />
            <p className="agent-setup-step">
              Then run <code>/mcp</code> in Claude Code and choose Bellhop to sign in.
            </p>
          </>
        )}
        {client === "other" && (
          <>
            <p className="agent-setup-step">Add this MCP server to your agent. It signs in with Bellhop the first time it connects.</p>
            <CopyField value={url} />
          </>
        )}
      </div>
    </div>
  )
}
