import { useState, type FormEvent } from "react"
import type { AppDetail } from "../../../shared/api"
import type { ApiKey, NewApiKey } from "../../../shared/v1"
import { t as tc } from "../../i18n/core"
import { tr, useT } from "../../i18n/helpdesk"
import { api, errorMessage, keys } from "../../lib/api"
import { setData, useResource } from "../../lib/cache"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { PlusIcon, XIcon } from "../../ui/icons"
import { Button } from "../../ui/primitives"
import { CopyField } from "../../ui/onboarding/Snippet"
import "../../styles/agents.css"
import "../../styles/features.css"
import "../../styles/helpdesk.css"

/**
 * Keys created in this tab, kept in memory only (never stored), so the widget's install snippet can carry the real
 * key right after it's made. The server only ever returns a key once.
 */
export const revealedKeys = new Map<string, string>()

/** The workspace's own address, always allowed for its publishable keys. */
export const workspaceOrigin = (slug: string) => new URL(appPath(slug), window.location.href).origin

/** An exact origin ("https://host[:port]"), or null. Plain http only for localhost, for local development. */
function parseOrigin(raw: string) {
  const value = raw.trim()
  if (!/^https?:\/\/[^\s/?#@\\*]+\/?$/i.test(value)) return null
  const url = URL.parse(value)
  if (!url || url.origin === "null") return null
  if (url.protocol === "http:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null
  return url.origin
}

/**
 * Settings → API keys (admins, help desks): publishable keys for the chat widget and browser code, limited to exact
 * origins, and secret keys for the host's server. A key is shown once; revoking one ends the sessions made with it.
 */
export function ApiKeys({ app }: { app: AppDetail }) {
  const t = useT()
  const key = keys.apiKeys(app.slug)
  const { data: list, error } = useResource<ApiKey[]>(key, () => api.apiKeys(app.slug), 5_000)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<NewApiKey | null>(null)

  return (
    <div className="api-keys">
      <div className="settings-heading">
        <h1>{t("apiKeys.title")}</h1>
        {!creating && !created && (
          <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setCreating(true)}>
            {t("apiKeys.create")}
          </Button>
        )}
      </div>
      <p className="settings-lede">{t("apiKeys.lede")}</p>

      {creating && (
        <CreateKey
          app={app}
          onCancel={() => setCreating(false)}
          onCreated={(k) => {
            const { key: full, ...row } = k
            if (k.kind === "publishable") revealedKeys.set(k.id, full)
            setData<ApiKey[]>(key, (l) => [...(l ?? []), row])
            setCreating(false)
            setCreated(k)
          }}
        />
      )}
      {created && (
        <section className="secret" aria-labelledby={`api-key-${created.id}`}>
          <div className="secret-head">
            <h3 id={`api-key-${created.id}`} className="secret-title">
              {t("apiKeys.copyTitle", { name: created.name })}
            </h3>
            <p className="secret-warning">{created.kind === "secret" ? t("apiKeys.secretWarning") : t("apiKeys.copyText")}</p>
          </div>
          <div className="secret-field">
            <span className="secret-label">{t("apiKeys.key")}</span>
            <CopyField value={created.key} />
          </div>
          <div className="secret-actions">
            <Button onClick={() => setCreated(null)}>{t("keys.done")}</Button>
          </div>
        </section>
      )}

      <section className="box">
        {!list && !error && <div className="box-row skeleton-row" />}
        {!!error && !list && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {list?.length === 0 && <div className="box-empty">{t("apiKeys.none")}</div>}
        {list?.map((k) => <KeyRow key={k.id} app={app} item={k} />)}
      </section>
    </div>
  )
}

function KindChoice({ value, onChange }: { value: ApiKey["kind"]; onChange: (kind: ApiKey["kind"]) => void }) {
  const t = useT()
  return (
    <div className="api-kinds" role="radiogroup" aria-label={t("apiKeys.kind")}>
      {(["publishable", "secret"] as const).map((kind) => (
        <label key={kind} className="api-kind" data-current={value === kind || undefined}>
          <input type="radio" name="api-key-kind" value={kind} checked={value === kind} onChange={() => onChange(kind)} />
          <span className="api-kind-text">
            <span className="api-kind-title">{kind === "publishable" ? t("apiKeys.publishable") : t("apiKeys.secret")}</span>
            <span className="api-kind-hint">{kind === "publishable" ? t("apiKeys.publishableText") : t("apiKeys.secretText")}</span>
          </span>
        </label>
      ))}
    </div>
  )
}

/** Exact origins as removable rows, with a field that adds one (Enter or Add), validated as it's added. */
function OriginsEditor({ slug, value, onChange, id }: { slug: string; value: string[]; onChange: (next: string[]) => void; id: string }) {
  const t = useT()
  const [draft, setDraft] = useState("")
  const [error, setError] = useState<string | null>(null)
  const add = () => {
    if (!draft.trim()) return
    const origin = parseOrigin(draft)
    if (!origin) return setError(t("apiKeys.invalidOrigin"))
    if (value.includes(origin) || origin === workspaceOrigin(slug)) return setError(t("apiKeys.duplicateOrigin"))
    onChange([...value, origin])
    setDraft("")
    setError(null)
  }
  return (
    <div className="api-origins">
      <label className="field-label" htmlFor={id}>
        {t("apiKeys.origins")}
      </label>
      {value.length > 0 && (
        <ul className="api-origin-list">
          {value.map((o) => (
            <li key={o} className="api-origin">
              <span className="mono">{o}</span>
              <Button
                iconOnly
                size="small"
                variant="ghost-muted"
                icon={<XIcon size={12} />}
                aria-label={t("apiKeys.removeOrigin", { origin: o })}
                title={t("apiKeys.removeOrigin", { origin: o })}
                onClick={() => onChange(value.filter((x) => x !== o))}
              />
            </li>
          ))}
        </ul>
      )}
      <div className="api-origin-add">
        <div className="input" data-invalid={error ? "" : undefined}>
          <input
            id={id}
            value={draft}
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            placeholder={t("apiKeys.originPlaceholder")}
            aria-invalid={!!error}
            onChange={(e) => {
              setDraft(e.target.value)
              setError(null)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                add()
              }
            }}
          />
        </div>
        <Button onClick={add}>{t("apiKeys.addOrigin")}</Button>
      </div>
      {error ? (
        <p className="field-error">{error}</p>
      ) : (
        <p className="api-hint">{tr("apiKeys.originsHint", { origin: <span className="mono">{workspaceOrigin(slug)}</span> })}</p>
      )}
    </div>
  )
}

function CreateKey({ app, onCancel, onCreated }: { app: AppDetail; onCancel: () => void; onCreated: (k: NewApiKey) => void }) {
  const t = useT()
  const [kind, setKind] = useState<ApiKey["kind"]>("publishable")
  const [name, setName] = useState("")
  const [origins, setOrigins] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.createApiKey(app.slug, { name: name.trim(), kind, allowed_origins: kind === "publishable" ? origins : [] }))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <form className="api-create" onSubmit={submit}>
      <KindChoice value={kind} onChange={setKind} />
      <div className="field">
        <label className="field-label" htmlFor="api-key-name">
          {t("apiKeys.name")}
        </label>
        <div className="input">
          <input
            id="api-key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("apiKeys.namePlaceholder")}
            maxLength={120}
            autoFocus
            autoComplete="off"
          />
        </div>
      </div>
      {kind === "publishable" && <OriginsEditor slug={app.slug} value={origins} onChange={setOrigins} id="api-new-origin" />}
      {error && <p className="field-error">{error}</p>}
      <div className="api-actions">
        <Button variant="invisible" onClick={onCancel} disabled={busy}>
          {tc("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          {busy ? t("apiKeys.creating") : t("apiKeys.create")}
        </Button>
      </div>
    </form>
  )
}

function KeyRow({ app, item }: { app: AppDetail; item: ApiKey }) {
  const t = useT()
  const [mode, setMode] = useState<"edit" | "revoke" | null>(null)
  const [name, setName] = useState(item.name)
  const [origins, setOrigins] = useState(item.allowed_origins)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = keys.apiKeys(app.slug)

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
  const save = () =>
    run(async () => {
      const next = await api.patchApiKey(app.slug, item.id, item.kind === "publishable" ? { name: name.trim(), allowed_origins: origins } : { name: name.trim() })
      setData<ApiKey[]>(list, (l) => l?.map((k) => (k.id === next.id ? next : k)))
    })
  const revoke = () =>
    run(async () => {
      await api.deleteApiKey(app.slug, item.id)
      setData<ApiKey[]>(list, (l) => l?.filter((k) => k.id !== item.id))
    })

  return (
    <div className="box-row settings-row api-key-row" data-open={mode === "edit" || undefined}>
      <div className="settings-row-main">
        <div className="key-row-name">
          {item.name}
          <span className="api-kind-badge" data-kind={item.kind}>
            {item.kind === "publishable" ? t("apiKeys.publishable") : t("apiKeys.secret")}
          </span>
          <span className="mono key-preview">{item.preview}</span>
        </div>
        {item.kind === "publishable" && (
          <div className="api-key-origins mono">
            {item.allowed_origins.length ? item.allowed_origins.join(" · ") : t("apiKeys.noOrigins", { origin: workspaceOrigin(app.slug) })}
          </div>
        )}
        <div className="issue-meta">
          {tr("keys.created", { time: <Time iso={item.created_at} /> })} ·{" "}
          {item.last_used_at ? tr("keys.lastUsed", { time: <Time iso={item.last_used_at} /> }) : t("keys.neverUsed")}
        </div>
        {mode === "edit" && (
          <div className="api-edit">
            <div className="field">
              <label className="field-label" htmlFor={`api-name-${item.id}`}>
                {t("apiKeys.name")}
              </label>
              <div className="input">
                <input id={`api-name-${item.id}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" />
              </div>
            </div>
            {item.kind === "publishable" && <OriginsEditor slug={app.slug} value={origins} onChange={setOrigins} id={`api-origin-${item.id}`} />}
            <div className="api-actions">
              <Button variant="invisible" onClick={() => setMode(null)} disabled={busy}>
                {tc("common.cancel")}
              </Button>
              <Button variant="primary" onClick={() => void save()} disabled={busy || !name.trim()}>
                {busy ? t("apiKeys.saving") : t("apiKeys.save")}
              </Button>
            </div>
          </div>
        )}
        {mode === "revoke" && <p className="settings-confirm-text">{t("apiKeys.revokeConfirm", { name: item.name })}</p>}
        {error && <p className="field-error">{error}</p>}
      </div>
      {mode === "revoke" ? (
        <div className="row api-row-actions">
          <Button size="small" variant="invisible" onClick={() => setMode(null)} disabled={busy}>
            {tc("common.cancel")}
          </Button>
          <Button size="small" variant="danger" onClick={() => void revoke()} disabled={busy}>
            {busy ? t("keys.revoking") : t("keys.revoke")}
          </Button>
        </div>
      ) : (
        mode === null && (
          <div className="row api-row-actions">
            <Button
              size="small"
              onClick={() => {
                setName(item.name)
                setOrigins(item.allowed_origins)
                setMode("edit")
              }}
            >
              {t("apiKeys.edit")}
            </Button>
            <Button size="small" onClick={() => setMode("revoke")}>
              {t("keys.revoke")}
            </Button>
          </div>
        )
      )}
    </div>
  )
}
