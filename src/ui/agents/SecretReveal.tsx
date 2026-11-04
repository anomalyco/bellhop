import type { NewAgentToken } from "../../../shared/api"
import { mcpUrl } from "../../lib/site"
import { Button } from "../primitives"
import { CopyField, Snippet } from "../onboarding/Snippet"
import "../../styles/agents.css"
import { tr, useT } from "../../i18n/core"

/** A token agent's secret, shown once right after it's created or rotated, with a ready-to-paste OpenCode config. */
export function SecretReveal({ agent, rotated, onDone }: { agent: NewAgentToken; rotated?: boolean; onDone: () => void }) {
  const t = useT()
  const url = mcpUrl()
  const config = JSON.stringify({ mcp: { bellhop: { type: "remote", url, headers: { Authorization: `Bearer ${agent.token}` } } } }, null, 2)
  return (
    <section className="secret" aria-labelledby={`secret-${agent.id}`}>
      <div className="secret-head">
        <h3 id={`secret-${agent.id}`} className="secret-title">
          {rotated ? t("secret.new", { name: agent.client_name }) : t("secret.ready", { name: agent.client_name })}
        </h3>
        <p className="secret-warning">{rotated ? t("secret.warningRotated") : t("secret.warning")}</p>
      </div>
      <div className="secret-field">
        <span className="secret-label">{t("secret.label")}</span>
        <CopyField value={agent.token} />
      </div>
      <div className="secret-field">
        <span className="secret-label">{tr("secret.opencode", { file: <code>opencode.json</code> })}</span>
        <Snippet code={config} label="opencode.json" />
      </div>
      <div className="secret-field">
        <span className="secret-label">{t("secret.other")}</span>
        <CopyField value={url} />
      </div>
      <div className="secret-actions">
        <Button onClick={onDone}>{t("secret.done")}</Button>
      </div>
    </section>
  )
}
