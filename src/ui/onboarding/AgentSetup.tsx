import { useState } from "react"
import { mcpUrl } from "../../lib/site"
import { CopyField, Snippet } from "./Snippet"
import "../../styles/onboarding.css"
import { tr, useT } from "../../i18n/core"

type Client = "opencode" | "claude" | "other"

const clients: { id: Client; label: string }[] = [
  { id: "opencode", label: "OpenCode" },
  { id: "claude", label: "Claude Code" },
  { id: "other", label: "" },
]

/** How to point an agent at Bellhop's MCP server: one tab per client, every snippet copyable. */
export function AgentSetup() {
  const t = useT()
  const [client, setClient] = useState<Client>("opencode")
  const url = mcpUrl()
  const config = JSON.stringify({ mcp: { bellhop: { type: "remote", url } } }, null, 2)

  return (
    <div className="agent-setup">
      <div className="segmented agent-setup-tabs" role="tablist" aria-label={t("agentSetup.label")}>
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
            {c.label || t("agentSetup.other")}
          </button>
        ))}
      </div>
      <div className="agent-setup-panel" id="agent-setup-panel" role="tabpanel" aria-labelledby={`agent-tab-${client}`}>
        {client === "opencode" && (
          <>
            <p className="agent-setup-step">{tr("agentSetup.opencodeAdd", { file: <code>opencode.json</code> })}</p>
            <Snippet code={config} label="opencode.json" />
            <p className="agent-setup-step">{t("agentSetup.thenSignIn")}</p>
            <Snippet code="opencode mcp auth bellhop" />
          </>
        )}
        {client === "claude" && (
          <>
            <p className="agent-setup-step">{t("agentSetup.claudeAdd")}</p>
            <Snippet code={`claude mcp add --transport http bellhop ${url}`} />
            <p className="agent-setup-step">{tr("agentSetup.claudeThen", { command: <code>/mcp</code> })}</p>
          </>
        )}
        {client === "other" && (
          <>
            <p className="agent-setup-step">{t("agentSetup.otherText")}</p>
            <CopyField value={url} />
          </>
        )}
      </div>
    </div>
  )
}
