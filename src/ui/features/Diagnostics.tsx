import { useState } from "react"
import type { Attachment, ReportMetadata } from "../../../shared/api"
import { formatSize } from "../../lib/upload"
import { ChevronDownIcon, PaperclipIcon, XIcon } from "../icons"
import { Button } from "../primitives"
import { LogSheet } from "./LogSheet"
import "../../styles/features.css"
import { t, useT } from "../../i18n/core"

export type DiagnosticsKind = "system" | "logs" | "context"

/** "OpenCode Desktop 1.4.2", or null when the app didn't say. */
export function sourceText(m: Pick<ReportMetadata, "source">) {
  if (!m.source) return null
  return [m.source.name, m.source.version].filter(Boolean).join(" ")
}

/** "2 logs · 5 specs": what's in it, for collapsed headers and chips. */
export function contentsText(m: ReportMetadata) {
  const specs = Object.keys(m.system ?? {}).length
  const context = Object.keys(m.context ?? {}).length
  const parts = [
    m.logs.length && t("diag.logs", { count: m.logs.length }),
    specs && t("diag.specs", { count: specs }),
    context && t("diag.context", { count: context }),
  ].filter(Boolean)
  return parts.join(" · ")
}

/** Ids of the log files metadata adds to a post, so attachment lists can leave them to the diagnostics view. */
export function logIds(metadata: ReportMetadata[] | undefined) {
  return new Set((metadata ?? []).flatMap((m) => m.logs.map((l) => l.id)))
}

/**
 * What an app sent with a report: the error message, system specs, logs (each opens in a viewer) and context. With
 * `onRemove`, every item gets a remove button (the person reviewing it before submitting).
 */
export function DiagnosticsBody({
  metadata,
  onRemove,
  busy,
}: {
  metadata: ReportMetadata
  onRemove?: (kind: DiagnosticsKind, key: string) => void
  /** "kind:key" of an item being removed. */
  busy?: string | null
}) {
  const t = useT()
  const [viewing, setViewing] = useState<Attachment | null>(null)
  const system = Object.entries(metadata.system ?? {})
  const context = Object.entries(metadata.context ?? {})
  const empty = !metadata.message && system.length === 0 && context.length === 0 && metadata.logs.length === 0
  return (
    <div className="diag">
      {metadata.message && (
        <div className="diag-group">
          <h4 className="diag-label">{t("diag.message")}</h4>
          <pre className="diag-message">{metadata.message}</pre>
        </div>
      )}
      {system.length > 0 && (
        <div className="diag-group">
          <h4 className="diag-label">{t("diag.system")}</h4>
          <dl className="diag-kv">
            {system.map(([k, v]) => (
              <Row key={k} name={k} value={v} onRemove={onRemove && (() => onRemove("system", k))} busy={busy === `system:${k}`} />
            ))}
          </dl>
        </div>
      )}
      {metadata.logs.length > 0 && (
        <div className="diag-group">
          <h4 className="diag-label">{t("diag.logsTitle")}</h4>
          <ul className="diag-logs">
            {metadata.logs.map((log) => (
              <li key={log.id} className="diag-log" data-busy={busy === `logs:${log.name}` || undefined}>
                <button type="button" className="diag-log-open" onClick={() => setViewing(log)} aria-label={t("diag.viewLog", { name: log.name })}>
                  <PaperclipIcon size={14} />
                  <span className="diag-log-name">{log.name}</span>
                  <span className="mono diag-log-size">{formatSize(log.size)}</span>
                  <span className="diag-log-view">{t("diag.view")}</span>
                </button>
                {onRemove && <Remove label={t("diag.dontSendItem", { name: log.name })} onClick={() => onRemove("logs", log.name)} disabled={busy === `logs:${log.name}`} />}
              </li>
            ))}
          </ul>
        </div>
      )}
      {context.length > 0 && (
        <div className="diag-group">
          <h4 className="diag-label">{t("diag.contextTitle")}</h4>
          <dl className="diag-kv">
            {context.map(([k, v]) => (
              <Row key={k} name={k} value={v} onRemove={onRemove && (() => onRemove("context", k))} busy={busy === `context:${k}`} />
            ))}
          </dl>
        </div>
      )}
      {empty && <p className="diag-empty">{t("diag.nothingLeft")}</p>}
      {viewing && <LogSheet log={viewing} onClose={() => setViewing(null)} />}
    </div>
  )
}

function Row({ name, value, onRemove, busy }: { name: string; value: string; onRemove?: () => void; busy?: boolean }) {
  return (
    <div className="diag-row" data-busy={busy || undefined}>
      <dt className="diag-key">{name}</dt>
      <dd className="diag-value">{value}</dd>
      {onRemove && <Remove label={t("diag.dontSendItem", { name })} onClick={onRemove} disabled={busy} />}
    </div>
  )
}

function Remove({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="diag-remove" aria-label={label} title={t("diag.dontSend")} onClick={onClick} disabled={disabled}>
      <XIcon size={12} />
    </button>
  )
}

/**
 * On an issue, for the team and the reporter: the diagnostics attached to the report, folded into one line under
 * it ("Diagnostics · OpenCode Desktop 1.4.2 · 2 logs") that opens in place.
 */
export function DiagnosticsBlock({ metadata }: { metadata: ReportMetadata[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  if (metadata.length === 0) return null
  const first = metadata[0]!
  const source = sourceText(first)
  return (
    <section className="diag-block" data-open={open || undefined}>
      <button type="button" className="diag-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="diag-toggle-title">{t("diag.title")}</span>
        <span className="diag-toggle-meta">
          {[source, contentsText(first)].filter(Boolean).join(" · ")}
          {metadata.length > 1 && ` · ${t("diag.more", { count: metadata.length - 1 })}`}
        </span>
        <span className="diag-toggle-note">{t("diag.note")}</span>
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="diag-block-body">
          {metadata.map((m) => (
            <div key={m.id} className="diag-block-item">
              {metadata.length > 1 && <p className="diag-item-head">{sourceText(m) ?? t("diag.title")}</p>}
              <DiagnosticsBody metadata={m} />
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/** On a comment that came with diagnostics: a small chip that opens them under the comment. */
export function DiagnosticsChip({ metadata }: { metadata: ReportMetadata }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const source = sourceText(metadata)
  return (
    <div className="diag-chip-wrap" data-open={open || undefined}>
      <Button size="small" className="btn diag-chip" aria-expanded={open} onClick={() => setOpen(!open)} trailing={<ChevronDownIcon size={12} />}>
        {t("diag.title")}
        <span className="diag-chip-meta">{[source, contentsText(metadata)].filter(Boolean).join(" · ")}</span>
      </Button>
      {open && (
        <div className="diag-chip-body">
          <DiagnosticsBody metadata={metadata} />
        </div>
      )}
    </div>
  )
}
