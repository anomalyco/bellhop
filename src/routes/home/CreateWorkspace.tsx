import { useState, type FormEvent } from "react"
import { useLocation } from "wouter"
import type { App } from "../../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { setData } from "../../lib/cache"
import { addressParts, appPath, isAbsolute } from "../../lib/site"
import { Button } from "../../ui/primitives"
import { PublicToggle } from "../../ui/workspace/Visibility"
import "../../styles/onboarding.css"

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
  if (!slug) return strict ? "Choose an address." : null
  if (reserved.has(slug)) return "That address is reserved. Try another."
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug)) return strict || slug.length > 1 ? "Use 2–40 lowercase letters, digits and hyphens, not starting or ending with a hyphen." : null
  return null
}

/** One focused step: name the workspace, check its address, create it and land on its issue list. */
export function CreateWorkspace({ first, onCancel }: { first?: boolean; onCancel?: () => void }) {
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
  const problem = taken === address ? "That URL is taken. Try another." : slugProblem(address, strict)

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
        <h1 className="create-title">{first ? "Create your first workspace" : "New workspace"}</h1>
        <p className="create-sub">A workspace is your product's support site. People report issues there, and your agent answers them.</p>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="ws-name">
          Name
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
        {strict && !name.trim() && <p className="field-error">Give your workspace a name.</p>}
      </div>
      <div className="field">
        <label className="field-label" htmlFor="ws-url">
          URL
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
            Where people report issues. You can't change it later.
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
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "Creating…" : "Create workspace"}
        </Button>
      </div>
    </form>
  )
}
