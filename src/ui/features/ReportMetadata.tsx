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
import { tr, useT } from "../../i18n/core"
import { fullDate } from "../../lib/time"
import { sentenceGap } from "../../i18n"

/** The new-issue form's "Attached from …" panel: everything the app sent, each item removable before submitting. */
export function MetadataPanel({ app, metadata, onChange }: { app: AppDetail; metadata: ReportMetadata; onChange: (next: ReportMetadata) => void }) {
  const t = useT()
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
      setError(e instanceof ApiFailure && e.status === 410 ? t("md.expiredError") : errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="md-panel" aria-labelledby="md-panel-title">
      <header className="md-panel-head">
        <h2 id="md-panel-title" className="md-panel-title">
          {source ? tr("md.attachedFrom", { source: <span className="md-panel-source">{source}</span> }) : t("md.attached")}
        </h2>
        <p className="md-panel-hint">
          {t("md.hint")}
          {metadata.expires_at && (
            <>
              {sentenceGap()}
              {tr("md.keptUntil", { when: <ExpiresIn iso={metadata.expires_at} /> })}
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
  const t = useT()
  return <span title={fullDate(iso)}>{days === 0 ? t("md.untilToday") : t("md.forDays", { count: days })}</span>
}

/** Open issues with the same failure fingerprint: "This might be #34", with the option to add the diagnostics there. */
export function MetadataMatches({ app, metadata }: { app: AppDetail; metadata: ReportMetadata }) {
  const t = useT()
  const matches = metadata.matches.slice(0, 3)
  return (
    <section className="md-matches" aria-label={t("md.duplicates")}>
      {matches.map((m, i) => (
        <div key={m.id} className="md-match">
          <StateIcon state={visibleState(m)} size={16} />
          <div className="md-match-main">
            <p className="md-match-title">
              {tr(i === 0 ? "md.mightBe" : "md.or", {
                issue: (
                  <AppLink slug={app.slug} href={appPath(app.slug, `/issues/${m.number}`)} className="md-match-link" target="_blank" rel="noopener">
                    <span className="mono">#{m.number}</span> · {m.title}
                  </AppLink>
                ),
              })}
            </p>
            {i === 0 && <p className="md-match-hint">{t("md.matchHint")}</p>}
          </div>
          <AppLink
            slug={app.slug}
            href={appPath(app.slug, `/issues/${m.number}?metadata=${encodeURIComponent(metadata.id)}`)}
            className="btn md-match-add"
            data-variant={i === 0 ? "primary" : "default"}
            data-size="small"
          >
            {t("md.addTo", { number: String(m.number) })}
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
  const t = useT()
  const expired = error instanceof ApiFailure && error.status === 410
  const missing = error instanceof ApiFailure && error.status === 404
  const title = attachedTo ? t("md.alreadySent") : expired ? t("md.expired") : missing ? t("md.notFound") : t("md.cantOpen")
  const text = attachedTo
    ? t(attachedTo.comment_id ? "md.onComment" : "md.onIssue", { number: String(attachedTo.number) })
    : expired
      ? t("md.expiredText")
      : missing
        ? t("md.notFoundText")
        : errorMessage(error)
  return (
    <Page narrow>
      <div className="blank md-blocked">
        <h1 className="blank-title">{title}</h1>
        <p className="muted-text">{text}</p>
        <div className="md-blocked-actions">
          {attachedTo && (
            <AppLink slug={app.slug} href={appPath(app.slug, `/issues/${attachedTo.number}`)} className="btn" data-variant="primary">
              {t("md.goTo", { number: String(attachedTo.number) })}
            </AppLink>
          )}
          <AppLink slug={app.slug} href={appPath(app.slug, "/new")} className="btn" data-variant={attachedTo ? "default" : "primary"}>
            {attachedTo ? t("list.newIssue") : t("md.newWithout")}
          </AppLink>
        </div>
      </div>
    </Page>
  )
}
