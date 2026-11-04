import { useState } from "react"
import { Link } from "wouter"
import type { AppDetail } from "../../../shared/api"
import type { ApiKey } from "../../../shared/v1"
import { tr, useT } from "../../i18n/helpdesk"
import { api, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { appPath, homeUrl } from "../../lib/site"
import { Snippet } from "../../ui/onboarding/Snippet"
import { revealedKeys } from "./ApiKeys"
import "../../styles/agents.css"
import "../../styles/helpdesk.css"

const domain: string = import.meta.env.VITE_APP_DOMAIN ?? ""
/** The public API's base: api.<domain> in production, this host's /v1 in path mode. */
const apiBase = () => (domain ? `https://api.${domain}/v1` : `${window.location.origin}/v1`)
const absolute = (path: string) => new URL(homeUrl(path), window.location.href).href
const placeholder = "bh_pk_YOUR_PUBLISHABLE_KEY"

type Theme = "light" | "dark" | "auto"
type Side = "right" | "left"

/**
 * Settings → Widget (admins, help desks): the install snippet with the workspace's publishable key, theme and
 * position, the calls a page can make, and the two ways to pass who's signed in (a session minted with a secret key,
 * or an identity token).
 */
export function WidgetSettings({ app }: { app: AppDetail }) {
  const t = useT()
  const { data: list } = useResource<ApiKey[]>(keys.apiKeys(app.slug), () => api.apiKeys(app.slug), 5_000)
  const [theme, setTheme] = useState<Theme>("light")
  const [side, setSide] = useState<Side>("right")
  const publishable = list?.filter((k) => k.kind === "publishable") ?? []
  // A key made in this tab can go in for real; otherwise the snippet says which key to paste
  const made = publishable.find((k) => revealedKeys.has(k.id))
  const chosen = made ?? publishable[0] ?? null
  const value = made ? revealedKeys.get(made.id)! : placeholder
  const attrs = [`src="${absolute("/widget/v1.js")}"`, `data-key="${value}"`, theme !== "light" && `data-theme="${theme}"`, side === "left" && `data-position="left"`]
  // Short lines: the snippets stay readable beside their Copy button, on phones too
  const install = `<script\n  src="${absolute("/widget/v1.js")}"\n  ${attrs.slice(1).filter(Boolean).join("\n  ")}\n  async\n></script>`
  const session = `// On your server, for the signed-in user
// (the secret key never reaches a browser)
const res = await fetch("${apiBase()}/sessions", {
  method: "POST",
  headers: {
    Authorization: \`Bearer \${process.env.BELLHOP_SECRET_KEY}\`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    user: { id: user.id, email: user.email, email_verified: true, name: user.name },
  }),
})
const { token } = await res.json()

// In the page, with that token
Bellhop.init({
  key: "${value}",
  sessionToken: token,
})`
  const identity = `Bellhop.init({\n  key: "${value}",\n  identityToken,\n})`

  return (
    <div className="desk-settings widget-settings">
      <div className="settings-heading">
        <h1>{t("widget.title")}</h1>
      </div>
      <p className="settings-lede">{t("widget.lede")}</p>
      {/* Everything below waits for the keys (the snippet's height depends on them), so nothing moves on arrival */}
      {list && (
        <>
      <section className="settings-section">
        <h2 className="section-title">{t("widget.install")}</h2>
        {!chosen ? (
          <div className="widget-nokey">
            <p className="desk-trust-note">{t("widget.noKey")}</p>
            <Link href={appPath(app.slug, "/settings/api-keys")} className="btn" data-variant="primary">
              {t("widget.createKey")}
            </Link>
          </div>
        ) : (
          <>
            <p className="desk-trust-note">{t("widget.installText")}</p>
            <div className="widget-options">
              <Choice label={t("widget.theme")} value={theme} onChange={setTheme} options={[["light", t("widget.light")], ["dark", t("widget.dark")], ["auto", t("widget.auto")]]} />
              <Choice label={t("widget.position")} value={side} onChange={setSide} options={[["right", t("widget.right")], ["left", t("widget.left")]]} />
            </div>
            <Snippet code={install} label="HTML" />
            <p className="api-hint">
              {made
                ? t("widget.keyFilled", { name: made.name })
                : tr("widget.keyNote", { placeholder: <code>{placeholder}</code>, name: <strong>{chosen.name}</strong>, preview: <span className="mono">{chosen.preview}</span> })}
            </p>
            <p className="api-hint">{t("widget.preview", { side: side === "left" ? t("widget.sideLeft") : t("widget.sideRight") })}</p>
            <p className="api-hint">
              {tr("widget.calls", {
                calls: <code>Bellhop.open() · close() · toggle() · newConversation({"{ subject, message }"}) · on("unread", fn) · logout()</code>,
              })}
            </p>
          </>
        )}
      </section>

      <section className="settings-section">
        <h2 className="section-title">{t("widget.signedIn")}</h2>
        <p className="desk-trust-note">{t("widget.signedInText")}</p>
        <h3 className="widget-subtitle">{t("widget.session")}</h3>
        <p className="api-hint">{t("widget.sessionText")}</p>
        <Snippet code={session} label="Node" />
        <h3 className="widget-subtitle">{t("widget.token")}</h3>
        <p className="api-hint">
          {tr("widget.tokenText", {
            link: <Link href={appPath(app.slug, "/settings/identity-keys")}>{t("widget.tokenLink")}</Link>,
          })}
        </p>
        <Snippet code={identity} label="JavaScript" />
      </section>

      <section className="settings-section">
        <h2 className="section-title">{t("widget.docs")}</h2>
        <ul className="widget-docs">
          {(
            [
              ["/docs/widget", t("widget.docsWidget")],
              ["/docs/api", t("widget.docsApi")],
              ["/docs/identity", t("widget.docsIdentity")],
            ] as const
          ).map(([path, label]) => (
            <li key={path}>
              {/* The docs are server-rendered pages: a full page load */}
              <a href={homeUrl(path)}>{label} ↗</a>
            </li>
          ))}
        </ul>
      </section>
        </>
      )}
    </div>
  )
}

function Choice<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="widget-choice">
      <span className="field-label">{label}</span>
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} aria-pressed={value === v} onClick={() => onChange(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  )
}
