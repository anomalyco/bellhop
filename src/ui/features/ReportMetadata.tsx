import { useState } from "react"
import type { AppDetail, ReportMetadata } from "../../../shared/api"
import { ApiFailure, api, errorMessage } from "../../lib/api"
import { visibleState } from "../../lib/issues"
import { appPath } from "../../lib/site"
import { StateIcon } from "../primitives"
import { Page } from "../Shell"
import { AppLink } from "../SiteLink"
import { DiagnosticsBody, sourceText, type DiagnosticsKind } from "./Diagnostics"
import "../../styles/features.css"

/** The new-issue form's "Attached from …" panel: everything the app sent, each item removable before submitting. */
export function MetadataPanel({ app, metadata, onChange }: { app: AppDetail; metadata: ReportMetadata; onChange: (next: ReportMetadata) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const source = sourceText(metadata)

  const remove = async (kind: DiagnosticsKind, key: string) => {
    if (busy) return
    setBusy(`${kind}:${key}`)
    setError(null)
    try {
      onChange(await api.removeMetadataItems(app.slug, metadata.id, { [kind]: [key] }))
    } catch (e) {
      setError(e instanceof ApiFailure && e.status === 410 ? "This report expired. Submit without it, or send it again from the app." : errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="md-panel" aria-labelledby="md-panel-title">
      <header className="md-panel-head">
        <h2 id="md-panel-title" className="md-panel-title">
          {source ? (
            <>
              Attached from <span className="md-panel-source">{source}</span>
            </>
          ) : (
            "Attached diagnostics"
          )}
        </h2>
        <p className="md-panel-hint">
          Only the team and you will see these. Remove anything you'd rather not send.
          {metadata.expires_at && (
            <>
              {" "}
              Kept until you submit, or <ExpiresIn iso={metadata.expires_at} />.
            </>
          )}
        </p>
      </header>
      <DiagnosticsBody metadata={metadata} onRemove={remove} busy={busy} />
      {error && <p className="field-error md-panel-error">{error}</p>}
    </section>
  )
}

function ExpiresIn({ iso }: { iso: string }) {
  const days = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 86_400_000))
  const when = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))
  return <span title={when}>{days === 0 ? "until today" : `for ${days} more ${days === 1 ? "day" : "days"}`}</span>
}

/** Open issues with the same failure fingerprint: "This might be #34", with the option to add the diagnostics there. */
export function MetadataMatches({ app, metadata }: { app: AppDetail; metadata: ReportMetadata }) {
  const matches = metadata.matches.slice(0, 3)
  return (
    <section className="md-matches" aria-label="Possible duplicates">
      {matches.map((m, i) => (
        <div key={m.id} className="md-match">
          <StateIcon state={visibleState(m)} size={16} />
          <div className="md-match-main">
            <p className="md-match-title">
              {i === 0 ? "This might be " : "Or "}
              <AppLink slug={app.slug} href={appPath(app.slug, `/issues/${m.number}`)} className="md-match-link" target="_blank" rel="noopener">
                <span className="mono">#{m.number}</span> · {m.title}
              </AppLink>
            </p>
            {i === 0 && <p className="md-match-hint">The same failure was reported there. Adding your diagnostics to it helps the team more than a new issue.</p>}
          </div>
          <AppLink
            slug={app.slug}
            href={appPath(app.slug, `/issues/${m.number}?metadata=${encodeURIComponent(metadata.id)}`)}
            className="btn md-match-add"
            data-variant={i === 0 ? "primary" : "default"}
            data-size="small"
          >
            Add to #{m.number} instead
          </AppLink>
        </div>
      ))}
    </section>
  )
}

/** In place of the form: the metadata expired (410), doesn't exist, or is already on an issue. */
export function MetadataBlocked({
  app,
  error,
  attachedTo,
}: {
  app: AppDetail
  error?: unknown
  attachedTo?: { number: number; comment_id: string | null }
}) {
  const expired = error instanceof ApiFailure && error.status === 410
  const missing = error instanceof ApiFailure && error.status === 404
  const title = attachedTo ? "This report was already sent" : expired ? "This report has expired" : missing ? "Report not found" : "Couldn't open this report"
  const text = attachedTo
    ? `Its diagnostics are on #${attachedTo.number}${attachedTo.comment_id ? ", in a comment" : ""}. To report something new, start a fresh issue.`
    : expired
      ? "Diagnostics from an app are kept for 7 days until someone writes them up. Send them again from the app, or open an issue without them."
      : missing
        ? "The link may be incomplete, or the report was already sent by someone else."
        : errorMessage(error)
  return (
    <Page narrow>
      <div className="blank md-blocked">
        <h1 className="blank-title">{title}</h1>
        <p className="muted-text">{text}</p>
        <div className="md-blocked-actions">
          {attachedTo && (
            <AppLink slug={app.slug} href={appPath(app.slug, `/issues/${attachedTo.number}`)} className="btn" data-variant="primary">
              Go to #{attachedTo.number}
            </AppLink>
          )}
          <AppLink slug={app.slug} href={appPath(app.slug, "/new")} className="btn" data-variant={attachedTo ? "default" : "primary"}>
            {attachedTo ? "New issue" : "New issue without it"}
          </AppLink>
        </div>
      </div>
    </Page>
  )
}
