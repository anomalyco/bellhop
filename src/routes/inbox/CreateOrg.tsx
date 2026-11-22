import { useState, type FormEvent } from "react"
import { useLocation } from "wouter"
import type { OrgDetail } from "../../../shared/api"
import { t as tc } from "../../i18n/core"
import { useT } from "../../i18n/inbox"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { invalidate, setData } from "../../lib/cache"
import { addressParts, homeUrl, isAbsolute, orgPath } from "../../lib/site"
import { Button } from "../../ui/primitives"
import "../../styles/onboarding.css"
import "../../styles/inbox.css"

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "")

// Slugs the Worker keeps for itself (they double as subdomains and home pages)
const reserved = new Set(
  "admin api app assets auth blog cdn dev docs help icon mail mcp media new settings static status support www oauth device agents signin workspaces feed _design o".split(" "),
)
export function slugProblem(slug: string, strict: boolean) {
  if (!slug) return strict ? tc("create.chooseAddress") : null
  if (reserved.has(slug)) return tc("create.reserved")
  if (!/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug)) return strict || slug.length > 1 ? tc("create.badSlug") : null
  return null
}

/** The address input: a workspace's subdomain (`app`) or an org's /o/<slug> on the home domain. */
export function SlugField({ id, label, value, problem, onChange, onBlur, app }: { id: string; label: string; value: string; problem: string | null; onChange: (v: string) => void; onBlur: () => void; app?: boolean }) {
  const parts = addressParts()
  const prefix = app ? parts.prefix : `${new URL(homeUrl("/"), window.location.href).host}/o/`
  const suffix = app ? parts.suffix : ""
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <div className="input create-url" data-invalid={problem ? "" : undefined}>
        {prefix && <span className="create-url-affix mono">{prefix}</span>}
        <input
          id={id}
          className="mono"
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40))}
          onBlur={onBlur}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={!!problem}
        />
        {suffix && <span className="create-url-affix mono">{suffix}</span>}
      </div>
      {problem && <p className="field-error">{problem}</p>}
    </div>
  )
}

/** Name an org and its address, create it, and land in its (empty) inbox. */
export function CreateOrg({ onCancel }: { onCancel?: () => void }) {
  const t = useT()
  const [, navigate] = useLocation()
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [edited, setEdited] = useState(false)
  const [strict, setStrict] = useState(false)
  const [taken, setTaken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const address = edited ? slug : slugify(name)
  const problem = taken === address ? tc("create.taken") : slugProblem(address, strict)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setStrict(true)
    if (!name.trim() || slugProblem(address, true) || busy) return
    setBusy(true)
    setError(null)
    try {
      const org: OrgDetail = await api.createOrg({ name: name.trim(), slug: address })
      setData(keys.org(org.slug), org)
      invalidate(keys.orgs)
      const href = orgPath(org.slug)
      if (isAbsolute(href)) window.location.assign(href)
      else navigate(href)
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409) setTaken(address)
      else setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <form className="org-create" onSubmit={submit} noValidate>
      <h2 className="section-title">{t("create.title")}</h2>
      <p className="settings-lede">{t("create.lede")}</p>
      <div className="field">
        <label className="field-label" htmlFor="org-new-name">
          {t("create.name")}
        </label>
        <div className="input">
          <input id="org-new-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("create.namePlaceholder")} maxLength={80} autoFocus autoComplete="off" />
        </div>
      </div>
      <SlugField
        id="org-new-slug"
        label={t("create.slug")}
        value={address}
        problem={problem}
        onChange={(v) => {
          setEdited(true)
          setSlug(v)
        }}
        onBlur={() => address && setStrict(true)}
      />
      {error && <p className="field-error">{error}</p>}
      <div className="settings-actions">
        {onCancel && (
          <Button variant="invisible" onClick={onCancel} disabled={busy}>
            {t("create.cancel")}
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t("create.creating") : t("create.submit")}
        </Button>
      </div>
    </form>
  )
}
