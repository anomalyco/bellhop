import { useState, type FormEvent } from "react"
import { useLocation } from "wouter"
import type { App } from "../../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { setData } from "../../lib/cache"
import { addressParts, appPath, isAbsolute } from "../../lib/site"
import { Button } from "../../ui/primitives"
import { PublicToggle } from "../../ui/workspace/Visibility"
import "../../styles/onboarding.css"
import { t, useT } from "../../i18n/core"

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")

// The Worker's reserved slugs (they double as subdomains), plus the home domain's own pages.
const reserved = new Set(
  "admin api app assets auth blog cdn dev docs help icon mail mcp media new settings static status support www oauth device agents signin workspaces feed _design".split(" "),
)

function slugProblem(slug: string, strict: boolean) {
  if (!slug) return strict ? t("create.chooseAddress") : null
  if (reserved.has(slug)) return t("create.reserved")
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug)) return strict || slug.length > 1 ? t("create.badSlug") : null
  return null
}

/** One focused step: name the workspace, check its address, create it and land on its issue list. */
export function CreateWorkspace({ first, onCancel }: { first?: boolean; onCancel?: () => void }) {
  useT()
  const [, navigate] = useLocation()
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [edited, setEdited] = useState(false)
  const [strict, setStrict] = useState(false)
  const [taken, setTaken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [isPublic, setPublic] = useState(false)
  const { prefix, suffix } = addressParts()

  const address = edited ? slug : slugify(name)
  const problem = taken === address ? t("create.taken") : slugProblem(address, strict)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setStrict(true)
    if (!name.trim() || slugProblem(address, true) || saving) return
    setSaving(true)
    setError(null)
    try {
      const app = await api.createApp({ name: name.trim(), slug: address, public: isPublic })
      setData(keys.app(app.slug), app)
      setData<App[]>(keys.apps, (apps) => [...(apps ?? []), app].sort((a, b) => a.name.localeCompare(b.name)))
      // Straight to the issue list, where the setup checklist picks up.
      const list = appPath(app.slug)
      if (isAbsolute(list)) window.location.assign(list)
      else navigate(list)
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409) setTaken(address)
      else setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <form className="create" onSubmit={submit} noValidate>
      <div className="create-head">
        <h1 className="create-title">{first ? t("create.first") : t("create.new")}</h1>
        <p className="create-sub">{t("create.sub")}</p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="ws-name">
          {t("create.name")}
        </label>
        <div className="input" data-size="large">
          <input
            id="ws-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme"
            autoFocus
            autoComplete="off"
            maxLength={80}
            aria-invalid={strict && !name.trim()}
          />
        </div>
        {strict && !name.trim() && <p className="field-error">{t("create.nameRequired")}</p>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="ws-url">
          {t("create.url")}
        </label>
        <div className="input create-url" data-size="large" data-invalid={problem ? "" : undefined}>
          {prefix && <span className="create-url-affix mono">{prefix}</span>}
          <input
            id="ws-url"
            className="mono"
            value={address}
            onChange={(e) => {
              setEdited(true)
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40))
            }}
            onBlur={() => address && setStrict(true)}
            placeholder="acme"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!problem}
            aria-describedby="ws-url-note"
          />
          {suffix && <span className="create-url-affix mono">{suffix}</span>}
        </div>
        {problem ? (
          <p id="ws-url-note" className="field-error">
            {problem}
          </p>
        ) : (
          <p id="ws-url-note" className="create-note">
            {t("create.urlNote")}
          </p>
        )}
      </div>
      <PublicToggle value={isPublic} onChange={setPublic} />
      {error && (
        <p className="flash" data-tone="danger">
          {error}
        </p>
      )}
      <div className="create-actions">
        {onCancel && (
          <Button variant="invisible" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? t("create.creating") : t("create.button")}
        </Button>
      </div>
    </form>
  )
}
