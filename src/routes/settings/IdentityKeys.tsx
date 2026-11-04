import { useState, type FormEvent } from "react"
import type { AppDetail, IdentityKey, NewIdentityKey } from "../../../shared/api"
import { t as tc } from "../../i18n/core"
import { tr, useT } from "../../i18n/helpdesk"
import { api, errorMessage, keys } from "../../lib/api"
import { setData, useResource } from "../../lib/cache"
import { isDesk } from "../../lib/helpdesk"
import { appPath, homeUrl } from "../../lib/site"
import { Time } from "../../lib/time"
import { PlusIcon } from "../../ui/icons"
import { Button } from "../../ui/primitives"
import { CopyField, Snippet } from "../../ui/onboarding/Snippet"
import "../../styles/agents.css"
import "../../styles/features.css"
import "../../styles/helpdesk.css"

// The signing snippets, verbatim as verified against the Worker (d28f31d). They read their settings from the
// environment; the values to set are shown next to them.
const node = `import { createHmac, randomUUID } from "node:crypto"

export function signIdentity(sub: string, name: string, verifiedEmail?: string) {
  const { IDENTITY_KEY_ID: kid, IDENTITY_SECRET: secret, WORKSPACE_SLUG: aud } = process.env
  if (!kid || !secret || !aud) throw new Error("Missing identity configuration")
  const iat = Math.floor(Date.now() / 1000)
  const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url")
  const header = encode({ alg: "HS256", kid })
  const claims = encode({ sub, name, aud, iat, exp: iat + 120, jti: randomUUID(),
    ...(verifiedEmail && { email: verifiedEmail, email_verified: true }) })
  const input = \`\${header}.\${claims}\`
  return \`\${input}.\${createHmac("sha256", secret).update(input).digest("base64url")}\`
}`

const python = `import base64, hashlib, hmac, json, os, time, uuid

def sign_identity(sub, name, verified_email=None):
    def b64(data):
        return base64.urlsafe_b64encode(data).rstrip(b"=")
    def encode(obj):
        return b64(json.dumps(obj, separators=(",", ":")).encode())
    iat = int(time.time())
    header = {"alg": "HS256", "kid": os.environ["IDENTITY_KEY_ID"]}
    claims = {"sub": sub, "name": name, "aud": os.environ["WORKSPACE_SLUG"],
              "iat": iat, "exp": iat + 120, "jti": str(uuid.uuid4())}
    if verified_email:
        claims.update(email=verified_email, email_verified=True)
    data = encode(header) + b"." + encode(claims)
    mac = hmac.new(os.environ["IDENTITY_SECRET"].encode(), data, hashlib.sha256)
    return (data + b"." + b64(mac.digest())).decode("ascii")`

/** The workspace's own address for a path ("https://acme.blhp.app/identify"). */
const workspaceUrl = (slug: string, path: string) => new URL(appPath(slug, path), window.location.href).href

/**
 * Settings → Identity keys (admins): secrets the host app's server signs identity tokens with, so its signed-in
 * users arrive in the help desk as verified contacts. A new key's secret is shown once, with the signing snippets.
 */
export function IdentityKeys({ app }: { app: AppDetail }) {
  const t = useT()
  const key = keys.identityKeys(app.slug)
  const { data: list, error } = useResource<IdentityKey[]>(key, () => api.identityKeys(app.slug), 5_000)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<NewIdentityKey | null>(null)
  const newest = created ?? list?.[0] ?? null

  return (
    <div>
      <div className="settings-heading">
        <h1>{t("keys.title")}</h1>
        {!creating && !created && isDesk(app) && (
          <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setCreating(true)}>
            {t("keys.create")}
          </Button>
        )}
      </div>
      <p className="settings-lede">{t("keys.lede")}</p>
      {!isDesk(app) && <p className="desk-trust-note">{t("keys.helpdeskOnly")}</p>}

      {creating && (
        <CreateKey
          slug={app.slug}
          onCancel={() => setCreating(false)}
          onCreated={(k) => {
            const { secret: _secret, ...row } = k
            setData<IdentityKey[]>(key, (l) => [row, ...(l ?? [])])
            setCreating(false)
            setCreated(k)
          }}
        />
      )}
      {created && (
        <section className="secret" aria-labelledby={`identity-${created.id}`}>
          <div className="secret-head">
            <h3 id={`identity-${created.id}`} className="secret-title">
              {t("keys.secretTitle", { name: created.name })}
            </h3>
            <p className="secret-warning">{t("keys.secretText")}</p>
          </div>
          <div className="secret-field">
            <span className="secret-label">{t("keys.secret")}</span>
            <CopyField value={created.secret} />
          </div>
          <div className="secret-field">
            <span className="secret-label">{t("keys.keyId")}</span>
            <CopyField value={created.id} />
          </div>
          <Signing app={app} keyId={created.id} secret={created.secret} />
          <div className="secret-actions">
            <Button onClick={() => setCreated(null)}>{t("keys.done")}</Button>
          </div>
        </section>
      )}

      <section className="box">
        {!list && !error && <div className="box-row skeleton-row" />}
        {!!error && !list && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {list?.length === 0 && <div className="box-empty">{t("keys.none")}</div>}
        {list?.map((k) => <KeyRow key={k.id} slug={app.slug} item={k} />)}
      </section>

      {!created && newest && <Signing app={app} keyId={newest.id} />}
    </div>
  )
}

/** The Node and Python snippets (verbatim), the values to set for them, and the two ways to use a token. */
function Signing({ app, keyId, secret }: { app: AppDetail; keyId: string; secret?: string }) {
  const t = useT()
  const [lang, setLang] = useState<"node" | "python">("node")
  const env = `IDENTITY_KEY_ID=${keyId}\nIDENTITY_SECRET=${secret ?? `<${t("keys.envSecret")}>`}\nWORKSPACE_SLUG=${app.slug}`
  const identify = new URL(homeUrl(`/api/apps/${encodeURIComponent(app.slug)}/identify`), window.location.href).pathname
  return (
    <div className="identity-snippets">
      <h2 className="section-title">{t("keys.signing")}</h2>
      <p className="settings-lede">{t("keys.signingText")}</p>
      <div className="secret-field">
        <span className="secret-label">{t("keys.env")}</span>
        <Snippet code={env} label=".env" />
      </div>
      <div className="segmented" role="tablist" aria-label={t("keys.signing")}>
        {(
          [
            ["node", "Node / TypeScript"],
            ["python", "Python"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={lang === id} aria-pressed={lang === id} onClick={() => setLang(id)}>
            {label}
          </button>
        ))}
      </div>
      <Snippet code={lang === "node" ? node : python} label={lang === "node" ? "Node / TypeScript" : "Python"} />
      <h2 className="section-title">{t("keys.using")}</h2>
      <ul className="identity-use">
        <li>{tr("keys.usePost", { path: <code>POST {identify}</code>, body: <code>{"{ token }"}</code> })}</li>
        <li>{tr("keys.useLink", { url: <code>{`${workspaceUrl(app.slug, "/identify")}?token=…&next=/new`}</code> })}</li>
      </ul>
    </div>
  )
}

function CreateKey({ slug, onCancel, onCreated }: { slug: string; onCancel: () => void; onCreated: (k: NewIdentityKey) => void }) {
  const t = useT()
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await api.createIdentityKey(slug, name.trim()))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <form className="key-create" onSubmit={submit}>
      <label className="field-label" htmlFor="identity-key-name">
        {t("keys.name")}
      </label>
      <div className="key-create-row">
        <div className="input">
          <input
            id="identity-key-name"
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
      {error && <p className="field-error">{error}</p>}
    </form>
  )
}

function KeyRow({ slug, item }: { slug: string; item: IdentityKey }) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const revoke = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteIdentityKey(slug, item.id)
      setData<IdentityKey[]>(keys.identityKeys(slug), (l) => l?.filter((k) => k.id !== item.id))
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
          {tr("keys.created", { time: <Time iso={item.created_at} /> })} ·{" "}
          {item.last_used_at ? tr("keys.lastUsed", { time: <Time iso={item.last_used_at} /> }) : t("keys.neverUsed")}
        </div>
        {confirming && <p className="settings-confirm-text">{t("keys.revokeConfirm", { name: item.name })}</p>}
        {error && <p className="field-error">{error}</p>}
      </div>
      {confirming ? (
        <div className="row">
          <Button size="small" variant="invisible" onClick={() => setConfirming(false)} disabled={busy}>
            {tc("common.cancel")}
          </Button>
          <Button size="small" variant="danger" onClick={() => void revoke()} disabled={busy}>
            {busy ? t("keys.revoking") : t("keys.revoke")}
          </Button>
        </div>
      ) : (
        <Button size="small" variant="default" onClick={() => setConfirming(true)}>
          {t("keys.revoke")}
        </Button>
      )}
    </div>
  )
}
