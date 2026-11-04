import { useState, type FormEvent } from "react"
import type { AppDetail, NewReportKey, ReportKey } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { setData, useResource } from "../../lib/cache"
import { homeUrl } from "../../lib/site"
import { Time } from "../../lib/time"
import { PlusIcon } from "../../ui/icons"
import { Button } from "../../ui/primitives"
import { CopyField, Snippet } from "../../ui/onboarding/Snippet"
import { DocsLink } from "./DocsLink"
import { t, tr, tKey, useT } from "../../i18n/settings"
import { t as tc } from "../../i18n/core"
import { LastUsed } from "./LastUsed"
import "../../styles/agents.css"
import "../../styles/features.css"

/** Where an app posts report metadata for this workspace, absolute. */
const metadataUrl = (slug: string) => new URL(homeUrl(`/api/apps/${encodeURIComponent(slug)}/metadata`), window.location.href).href

/**
 * Settings → Report keys (admins): publishable keys an app ships with to upload logs and specs before someone
 * writes a report. A new key is shown once, with a curl command and a fetch call ready to paste.
 */
export function ReportKeys({ app }: { app: AppDetail }) {
  const key = keys.reportKeys(app.slug)
  const { data: list, error } = useResource<ReportKey[]>(key, () => api.reportKeys(app.slug), 5_000)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<NewReportKey | null>(null)
  useT()

  return (
    <div>
      <div className="settings-heading">
        <h1>{tKey("section.report-keys")}</h1>
        <div className="row">
          <DocsLink page="reports" />
          {!creating && !created && (
            <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setCreating(true)}>
              {t("keys.new")}
            </Button>
          )}
        </div>
      </div>
      <p className="settings-lede">{t("keys.lede")}</p>

      <p className="key-docs">
        {tr("keys.docs", {
          post: <code>POST /api/apps/{app.slug}/metadata</code>,
          auth: <code>Authorization: Bearer &lt;key&gt;</code>,
          url: <code>url</code>,
        })}
      </p>
      {creating && (
        <CreateKey
          slug={app.slug}
          onCancel={() => setCreating(false)}
          onCreated={(k) => {
            const { key: _secret, ...row } = k
            setData<ReportKey[]>(key, (l) => [row, ...(l ?? [])])
            setCreating(false)
            setCreated(k)
          }}
        />
      )}
      {created && <KeyReveal slug={app.slug} created={created} onDone={() => setCreated(null)} />}

      <section className="box">
        {!list && !error && <div className="box-row skeleton-row" />}
        {!!error && !list && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {list?.length === 0 && <div className="box-empty">{t("keys.empty")}</div>}
        {list?.map((k) => <KeyRow key={k.id} slug={app.slug} item={k} />)}
      </section>
    </div>
  )
}

function CreateKey({ slug, onCancel, onCreated }: { slug: string; onCancel: () => void; onCreated: (k: NewReportKey) => void }) {
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.createReportKey(slug, name.trim()))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <form className="key-create" onSubmit={submit}>
      <label className="field-label" htmlFor="key-name">
        {t("field.name")}
      </label>
      <div className="key-create-row">
        <div className="input">
          <input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("keys.namePlaceholder")}
            maxLength={60}
            autoFocus
            autoComplete="off"
          />
        </div>
        <Button variant="invisible" onClick={onCancel} disabled={busy}>
          {tc("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          {busy ? t("keys.creating") : t("keys.create")}
        </Button>
      </div>
      {error ? <p className="field-error">{error}</p> : <p className="member-invite-hint">{t("keys.nameHint")}</p>}
    </form>
  )
}

function KeyReveal({ slug, created, onDone }: { slug: string; created: NewReportKey; onDone: () => void }) {
  const url = metadataUrl(slug)
  const curl = `curl -X POST ${url} \\
  -H "Authorization: Bearer ${created.key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "Crash on startup",
    "source": { "name": "My App", "version": "1.0.0" },
    "system": { "OS": "macOS 15.1" },
    "logs": [{ "name": "main.log", "content": "…" }]
  }'`
  const ts = `const res = await fetch("${url}", {
  method: "POST",
  headers: { Authorization: "Bearer ${created.key}", "Content-Type": "application/json" },
  body: JSON.stringify({
    title: error.message,
    source: { name: "My App", version: "1.0.0" },
    logs: [{ name: "main.log", content: log }],
  }),
})
const { url } = await res.json()
open(url) // the new-issue page, with this attached`
  return (
    <section className="secret" aria-labelledby={`key-${created.id}`}>
      <div className="secret-head">
        <h3 id={`key-${created.id}`} className="secret-title">
          {t("keys.ready", { name: created.name })}
        </h3>
        <p className="secret-warning">{t("keys.copyNow")}</p>
      </div>
      <div className="secret-field">
        <span className="secret-label">{t("keys.key")}</span>
        <CopyField value={created.key} />
      </div>
      <div className="key-snippets">
        <div className="secret-field">
          <span className="secret-label">{t("keys.tryCurl")}</span>
          <Snippet code={curl} label="curl" />
        </div>
        <div className="secret-field">
          <span className="secret-label">{t("keys.fromApp")}</span>
          <Snippet code={ts} label="TypeScript" />
        </div>
      </div>
      <div className="secret-actions">
        <Button onClick={onDone}>{t("keys.done")}</Button>
      </div>
    </section>
  )
}

function KeyRow({ slug, item }: { slug: string; item: ReportKey }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteReportKey(slug, item.id)
      setData<ReportKey[]>(keys.reportKeys(slug), (l) => l?.filter((k) => k.id !== item.id))
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="box-row settings-row key-row">
      <div className="settings-row-main">
        <div className="key-row-name">
          {item.name}
          <span className="mono key-preview">{item.preview}</span>
        </div>
        <div className="issue-meta">
          {tr("keys.meta", { time: <Time iso={item.created_at} />, used: <LastUsed iso={item.last_used_at} /> })}
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
      {confirming ? (
        <div className="agent-confirm-inline">
          <span className="agent-confirm-text">{t("keys.confirmRevoke")}</span>
          <Button size="small" variant="invisible" onClick={() => setConfirming(false)} disabled={busy}>
            {tc("common.cancel")}
          </Button>
          <Button size="small" variant="danger" onClick={revoke} disabled={busy}>
            {busy ? t("keys.revoking") : t("keys.revoke")}
          </Button>
        </div>
      ) : (
        <div className="settings-row-actions">
          <Button size="small" variant="invisible" onClick={() => setConfirming(true)}>
            {t("keys.revoke")}
          </Button>
        </div>
      )}
    </div>
  )
}
