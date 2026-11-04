import type { NewAgentToken } from "../../../shared/api"
import { mcpUrl } from "../../lib/site"
import { Button } from "../primitives"
import { CopyField, Snippet } from "../onboarding/Snippet"
import "../../styles/agents.css"

/** A token agent's secret, shown once right after it's created or rotated, with a ready-to-paste OpenCode config. */
export function SecretReveal({ agent, rotated, onDone }: { agent: NewAgentToken; rotated?: boolean; onDone: () => void }) {
  const url = mcpUrl()
  const config = JSON.stringify({ mcp: { bellhop: { type: "remote", url, headers: { Authorization: `Bearer ${agent.token}` } } } }, null, 2)
  return (
    <section className="secret" aria-labelledby={`secret-${agent.id}`}>
      <div className="secret-head">
        <h3 id={`secret-${agent.id}`} className="secret-title">
          {rotated ? `New secret for ${agent.client_name}` : `${agent.client_name} is ready`}
        </h3>
        <p className="secret-warning">Copy it now. It won't be shown again{rotated ? ", and the old one has stopped working" : ""}.</p>
      </div>
      <div className="secret-field">
        <span className="secret-label">Secret</span>
        <CopyField value={agent.token} />
      </div>
      <div className="secret-field">
        <span className="secret-label">
          OpenCode: add to <code>opencode.json</code>
        </span>
        <Snippet code={config} label="opencode.json" />
      </div>
      <div className="secret-field">
        <span className="secret-label">Other agents: the MCP server, with the secret as a Bearer token</span>
        <CopyField value={url} />
      </div>
      <div className="secret-actions">
        <Button onClick={onDone}>Done</Button>
      </div>
    </section>
  )
}
