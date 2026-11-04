import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react"
import { Link } from "wouter"
import type { AgentRole, App, AppAgent, AppDetail, AppSettings, AppVisibility, Block, Label as LabelType, Member, Role, Template, TemplateInput } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { invalidate, setData, useResource } from "../lib/cache"
import { Time } from "../lib/time"
import { ActorAvatar, UserAvatar, actorName } from "../ui/Actor"
import { KebabIcon, LockIcon, PlusIcon } from "../ui/icons"
import { Menu, MenuItem } from "../ui/Menu"
import { AppLayout, Page, useMe } from "../ui/Shell"
import { AgentAvatar, AppIcon, Button, Label } from "../ui/primitives"
import { RoleBadge, RoleSelect } from "../ui/roles/RoleSelect"
import { agentRoleLabel, agentRoleText, agentRoles, atLeast, canSetup, roleLabel, roleText, teamRoles } from "../lib/roles"
import { appLabel, appPath, homeUrl, signInHref } from "../lib/site"
import { SiteLink } from "../ui/SiteLink"
import { PublicToggle, VisibilityValue } from "../ui/workspace/Visibility"
import "../styles/agents.css"
import "../styles/onboarding.css"
import "../styles/settings.css"
import "../styles/moderation.css"

type Section = "general" | "labels" | "templates" | "agents" | "webhook" | "members" | "blocked"

// `min`: the least role that sees the section. Below admin, General, Labels, Templates and Members are read-only.
const sections: { id: Section; label: string; min: Role }[] = [
  { id: "general", label: "General", min: "viewer" },
  { id: "labels", label: "Labels", min: "viewer" },
  { id: "templates", label: "Templates", min: "viewer" },
  { id: "members", label: "Members", min: "member" },
  { id: "agents", label: "Agents", min: "admin" },
  { id: "webhook", label: "Webhook", min: "admin" },
  { id: "blocked", label: "Blocked", min: "member" },
]

export default function Settings({ slug, section }: { slug: string; section?: string }) {
  return (
    <AppLayout slug={slug} tab="settings">
      {(app) => <SettingsBody app={app} section={(sections.find((s) => s.id === section)?.id ?? "general") as Section} />}
    </AppLayout>
  )
}

function SettingsBody({ app, section }: { app: AppDetail; section: Section }) {
  if (!app.role) {
    return (
      <Page narrow>
        <div className="blank">
          <h1 className="blank-title">For this workspace's team</h1>
          <p className="muted-text">Settings are for the people on this workspace. Sign in with an account that's on its team.</p>
          <a href={signInHref()} className="btn">
            Sign in
          </a>
        </div>
      </Page>
    )
  }
  return <SettingsLayout app={app} section={section} />
}

function SettingsLayout({ app, section }: { app: AppDetail; section: Section }) {
  const visible = sections.filter((s) => atLeast(app.role, s.min))
  const active = visible.some((s) => s.id === section) ? section : "general"
  const nav = useRef<HTMLElement>(null)
  // On phones the section list scrolls sideways: center the current one, and mark which edges have more (settings.css
  // fades those edges).
  const edges = () => {
    const n = nav.current
    if (!n) return
    const more = [n.scrollLeft > 1 && "start", n.scrollLeft + n.clientWidth < n.scrollWidth - 1 && "end"].filter(Boolean).join(" ")
    if (more) n.dataset.more = more
    else delete n.dataset.more
  }
  useEffect(() => {
    const n = nav.current
    const current = n?.querySelector<HTMLElement>("[aria-current=page]")
    if (n && current && n.scrollWidth > n.clientWidth) n.scrollLeft = current.offsetLeft - (n.clientWidth - current.offsetWidth) / 2
    edges()
  }, [active])
  useEffect(() => {
    const n = nav.current
    if (!n) return
    const observer = new ResizeObserver(edges)
    observer.observe(n)
    return () => observer.disconnect()
  }, [])
  return (
    <Page>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings" ref={nav} onScroll={edges}>
          {visible.map((s) => (
            <Link key={s.id} href={appPath(app.slug, s.id === "general" ? "/settings" : `/settings/${s.id}`)} aria-current={active === s.id ? "page" : undefined}>
              {s.label}
            </Link>
          ))}
        </nav>
        <div className="settings-main">
          {active === "general" && <General app={app} />}
          {active === "labels" && <Labels app={app} />}
          {active === "templates" && <Templates app={app} />}
          {active === "agents" && <Agents app={app} />}
          {active === "webhook" && <Webhook app={app} />}
          {active === "members" && <Members app={app} />}
          {active === "blocked" && <Blocked app={app} />}
        </div>
      </div>
    </Page>
  )
}

function Heading({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="settings-heading">
      <h1>{title}</h1>
      {action}
    </div>
  )
}

function Flash({ error }: { error: string | null }) {
  return error ? (
    <p className="flash" data-tone="danger">
      {error}
    </p>
  ) : null
}

function useSettings(slug: string) {
  return useResource<AppSettings>(keys.settings(slug), () => api.settings(slug), 5_000)
}

/* General */

function General({ app }: { app: AppDetail }) {
  const admin = canSetup(app.role)
  const [name, setName] = useState(app.name)
  const [description, setDescription] = useState(app.description)
  const [isPublic, setPublic] = useState(!!app.public)
  const [issues, setIssues] = useState<AppVisibility>(app.visibility ?? { default: "public", reporter_can_choose: false })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await api.patchApp(app.slug, { name: name.trim(), description: description.trim(), public: isPublic, visibility: issues })
      setData(keys.app(app.slug), next)
      setData<App[]>(keys.apps, (apps) =>
        apps?.map((a) => (a.id === next.id ? { ...a, name: next.name, description: next.description, public: next.public } : a)),
      )
      // The feed's workspace list changes when this one goes public or private.
      invalidate(keys.feedApps)
      invalidate(keys.feed)
      setSaved(true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="settings-form" onSubmit={save}>
      <Heading title="General" />
      <IconField app={app} />
      {admin ? (
        <>
          <div className="field">
            <label className="field-label" htmlFor="set-name">
              Name
            </label>
            <div className="input">
              <input id="set-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="set-description">
              Description
            </label>
            <textarea id="set-description" className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
          <div className="field">
            <span className="field-label">Visibility</span>
            <PublicToggle value={isPublic} onChange={setPublic} id="set-public" />
          </div>
          <div className="field">
            <span className="field-label" id="set-issues-label">
              New issues
            </span>
            <IssueVisibilityControl value={issues} onChange={setIssues} />
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <span className="field-label">Name</span>
            <p className="settings-value">{app.name}</p>
          </div>
          <div className="field">
            <span className="field-label">Description</span>
            <p className="settings-value">{app.description || <span className="muted-text">No description</span>}</p>
          </div>
          <div className="field">
            <span className="field-label">Visibility</span>
            <VisibilityValue value={!!app.public} />
          </div>
          <div className="field">
            <span className="field-label">New issues</span>
            <p className="settings-value visibility-value">
              {app.visibility?.default === "private" ? "Private" : "Public"}
              <span className="visibility-hint">{issueVisibilityText(app.visibility ?? { default: "public", reporter_can_choose: false })}</span>
            </p>
          </div>
        </>
      )}
      <div className="field">
        <span className="field-label">Public page</span>
        <a className="mono" href={appPath(app.slug)}>
          {appLabel(app.slug)}
        </a>
      </div>
      <Flash error={error} />
      {admin ? (
        <div className="row">
          <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {saved && <span className="muted-text">Saved</span>}
        </div>
      ) : (
        <p className="muted-text">Only admins and owners can change these. You're {app.role === "member" ? "a member" : "a viewer"} here.</p>
      )}
    </form>
  )
}

const issueVisibilityText = (v: AppVisibility) =>
  `${v.default === "private" ? "Only the team and each issue's reporter can read them." : "Anyone with the link can read them."} ${
    v.reporter_can_choose ? "Reporters can choose when they open one." : "Reporters can't change that."
  } The team can change any issue.`

/** "New issues are public / private", and whether reporters may choose. */
function IssueVisibilityControl({ value, onChange }: { value: AppVisibility; onChange: (next: AppVisibility) => void }) {
  return (
    <div className="issue-visibility">
      <div className="segmented" role="radiogroup" aria-labelledby="set-issues-label">
        {(["public", "private"] as const).map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={value.default === d}
            aria-pressed={value.default === d}
            onClick={() => onChange({ ...value, default: d })}
          >
            {d === "private" && <LockIcon size={12} />}
            {d === "public" ? "Public" : "Private"}
          </button>
        ))}
      </div>
      <label className="checkbox" htmlFor="set-reporter-choose">
        <input
          id="set-reporter-choose"
          type="checkbox"
          checked={value.reporter_can_choose}
          onChange={(e) => onChange({ ...value, reporter_can_choose: e.target.checked })}
        />
        Reporters can choose
      </label>
      <p className="visibility-hint">{issueVisibilityText(value)}</p>
    </div>
  )
}

const iconTypes = ["image/png", "image/jpeg", "image/webp"]
const iconLimit = 1024 * 1024
const tooBig = "That image is over 1 MB. Try a smaller export."
const wrongType = "Use a PNG, JPEG or WebP image."

/** The workspace's icon: favicon and top-left logo on its pages. Admins upload or remove it. */
function IconField({ app }: { app: AppDetail }) {
  const owner = canSetup(app.role)
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<"upload" | "remove" | null>(null)
  const [error, setError] = useState<string | null>(null)

  const store = (next: AppDetail) => {
    setData(keys.app(app.slug), next)
    setData<App[]>(keys.apps, (apps) => apps?.map((a) => (a.id === next.id ? { ...a, icon_url: next.icon_url } : a)))
  }

  const upload = async (file: File | undefined) => {
    if (!file) return
    setError(null)
    if (!iconTypes.includes(file.type)) return setError(wrongType)
    if (file.size > iconLimit) return setError(tooBig)
    setBusy("upload")
    try {
      store(await api.putIcon(app.slug, file))
    } catch (e) {
      setError(e instanceof ApiFailure && e.status === 413 ? tooBig : e instanceof ApiFailure && e.status === 415 ? wrongType : errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setError(null)
    setBusy("remove")
    try {
      store(await api.deleteIcon(app.slug))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="field">
      <span className="field-label">Icon</span>
      <div className="icon-field">
        <AppIcon src={app.icon_url} size={48} />
        {owner ? (
          <div className="icon-field-main">
            <div className="row">
              <Button size="small" onClick={() => input.current?.click()} disabled={!!busy}>
                {busy === "upload" ? "Uploading…" : app.icon_url ? "Replace" : "Upload"}
              </Button>
              {app.icon_url && (
                <Button size="small" variant="invisible" onClick={remove} disabled={!!busy}>
                  {busy === "remove" ? "Removing…" : "Remove"}
                </Button>
              )}
            </div>
            <span className="icon-field-hint">PNG, JPEG or WebP up to 1 MB. Square images work best; shown at 16–48 px.</span>
            <input
              ref={input}
              type="file"
              accept={iconTypes.join(",")}
              hidden
              onChange={(e) => {
                void upload(e.currentTarget.files?.[0])
                e.currentTarget.value = ""
              }}
            />
          </div>
        ) : (
          <span className="icon-field-hint">{app.icon_url ? "Shown as the tab icon and logo on these pages." : "Using the Bellhop mark."}</span>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

/* Labels */

const palette = ["fa4d56", "ff832b", "f1c21b", "42be65", "08bdba", "33b1ff", "4589ff", "a56eff", "ee5396", "878d96"]
const randomColor = () => palette[Math.floor(Math.random() * palette.length)]!

function Labels({ app }: { app: AppDetail }) {
  const admin = canSetup(app.role)
  const [editing, setEditing] = useState<string | "new" | null>(null)
  const labels = app.labels
  const store = (next: LabelType[]) => setData<AppDetail>(keys.app(app.slug), (a) => (a ? { ...a, labels: next.sort((x, y) => x.name.localeCompare(y.name)) } : a))
  const [error, setError] = useState<string | null>(null)

  const remove = async (label: LabelType) => {
    if (!confirm(`Delete the “${label.name}” label? It will be removed from every issue.`)) return
    setError(null)
    try {
      await api.deleteLabel(app.slug, label.id)
      store(labels.filter((l) => l.id !== label.id))
      invalidate(keys.lists(app.slug))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div>
      <Heading
        title="Labels"
        action={
          admin &&
          editing !== "new" && (
            <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setEditing("new")}>
              New label
            </Button>
          )
        }
      />
      <Flash error={error} />
      {!admin && <p className="settings-readonly">Only admins and owners can change labels.</p>}
      <section className="box">
        {editing === "new" && (
          <LabelForm
            slug={app.slug}
            onDone={(label) => {
              if (label) store([...labels, label])
              setEditing(null)
            }}
          />
        )}
        {labels.length === 0 && editing !== "new" && <div className="box-empty">No labels yet.</div>}
        {labels.map((label) =>
          editing === label.id ? (
            <LabelForm
              key={label.id}
              slug={app.slug}
              label={label}
              onDone={(next) => {
                if (next) store(labels.map((l) => (l.id === next.id ? next : l)))
                setEditing(null)
              }}
            />
          ) : (
            <div key={label.id} className="box-row settings-row label-row">
              <div className="settings-row-label">
                <Label name={label.name} color={label.color} />
              </div>
              <div className="settings-row-main muted-text">{label.description}</div>
              {admin && (
                <div className="settings-row-actions">
                  <Button size="small" variant="invisible" onClick={() => setEditing(label.id)}>
                    Edit
                  </Button>
                  <Button size="small" variant="invisible" onClick={() => remove(label)}>
                    Delete
                  </Button>
                </div>
              )}
            </div>
          ),
        )}
      </section>
    </div>
  )
}

function LabelForm({ slug, label, onDone }: { slug: string; label?: LabelType; onDone: (label: LabelType | null) => void }) {
  const [name, setName] = useState(label?.name ?? "")
  const [description, setDescription] = useState(label?.description ?? "")
  const [color, setColor] = useState(label?.color ?? randomColor())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = /^[0-9a-f]{6}$/i.test(color)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !valid) return
    setSaving(true)
    setError(null)
    try {
      const input = { name: name.trim(), description: description.trim(), color: color.toLowerCase() }
      onDone(label ? await api.patchLabel(slug, label.id, input) : await api.createLabel(slug, input))
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <form className="box-row label-form" onSubmit={save}>
      <div className="label-form-preview">
        <Label name={name.trim() || "Label preview"} color={valid ? color : "878d96"} />
      </div>
      <div className="label-form-fields">
        <div className="field">
          <label className="field-label" htmlFor="label-name">
            Name
          </label>
          <div className="input">
            <input id="label-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={50} autoFocus />
          </div>
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label className="field-label" htmlFor="label-description">
            Description
          </label>
          <div className="input">
            <input id="label-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={100} placeholder="Optional" />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="label-color">
            Colour
          </label>
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="color-swatch"
              style={{ "--swatch": valid ? `#${color}` : "#878d96" } as CSSProperties}
              onClick={() => setColor(randomColor())}
              aria-label="Pick a random colour"
              title="Random colour"
            />
            <div className="input" style={{ width: 110 }}>
              <span className="input-prefix mono">#</span>
              <input
                id="label-color"
                className="mono"
                value={color}
                onChange={(e) => setColor(e.target.value.replace(/[^0-9a-f]/gi, "").slice(0, 6))}
                aria-invalid={!valid}
              />
            </div>
            <input type="color" className="color-native" value={valid ? `#${color}` : "#878d96"} onChange={(e) => setColor(e.target.value.slice(1))} aria-label="Colour picker" />
          </div>
        </div>
        <div className="label-form-actions">
          <Button variant="invisible" onClick={() => onDone(null)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !name.trim() || !valid}>
            {label ? "Save" : "Create label"}
          </Button>
        </div>
      </div>
      {!!error && <p className="field-error">{error}</p>}
    </form>
  )
}

/* Templates */

function Templates({ app }: { app: AppDetail }) {
  const admin = canSetup(app.role)
  const [editing, setEditing] = useState<string | "new" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const templates = [...app.templates].sort((a, b) => a.position - b.position)
  const store = (next: Template[]) => setData<AppDetail>(keys.app(app.slug), (a) => (a ? { ...a, templates: next } : a))

  const remove = async (t: Template) => {
    if (!confirm(`Delete the “${t.name}” template?`)) return
    setError(null)
    try {
      await api.deleteTemplate(app.slug, t.id)
      store(templates.filter((x) => x.id !== t.id))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div>
      <Heading
        title="Templates"
        action={
          admin &&
          editing !== "new" && (
            <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setEditing("new")}>
              New template
            </Button>
          )
        }
      />
      <Flash error={error} />
      {!admin && <p className="settings-readonly">Only admins and owners can change templates.</p>}
      <section className="box">
        {editing === "new" && (
          <TemplateForm
            app={app}
            position={(templates[templates.length - 1]?.position ?? -1) + 1}
            onDone={(t) => {
              if (t) store([...templates, t])
              setEditing(null)
            }}
          />
        )}
        {templates.length === 0 && editing !== "new" && <div className="box-empty">No templates. Reporters get a blank form.</div>}
        {templates.map((t) =>
          editing === t.id ? (
            <TemplateForm
              key={t.id}
              app={app}
              template={t}
              position={t.position}
              onDone={(next) => {
                if (next) store(templates.map((x) => (x.id === next.id ? next : x)))
                setEditing(null)
              }}
            />
          ) : (
            <div key={t.id} className="box-row settings-row">
              <div className="settings-row-main">
                <div className="template-row-name">{t.name}</div>
                <div className="issue-meta">
                  {t.description}
                  {t.ask_system_info && <span className="muted-text"> · asks for system info</span>}
                </div>
                {t.label_ids.length > 0 && (
                  <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                    {app.labels
                      .filter((l) => t.label_ids.includes(l.id))
                      .map((l) => (
                        <Label key={l.id} name={l.name} color={l.color} />
                      ))}
                  </div>
                )}
              </div>
              {admin && (
                <div className="settings-row-actions">
                  <Button size="small" variant="invisible" onClick={() => setEditing(t.id)}>
                    Edit
                  </Button>
                  <Button size="small" variant="invisible" onClick={() => remove(t)}>
                    Delete
                  </Button>
                </div>
              )}
            </div>
          ),
        )}
      </section>
    </div>
  )
}

function TemplateForm({
  app,
  template,
  position,
  onDone,
}: {
  app: AppDetail
  template?: Template
  position: number
  onDone: (t: Template | null) => void
}) {
  const [form, setForm] = useState<Required<TemplateInput>>({
    name: template?.name ?? "",
    description: template?.description ?? "",
    title: template?.title ?? "",
    body: template?.body ?? "",
    label_ids: template?.label_ids ?? [],
    ask_system_info: template?.ask_system_info ?? true,
    position,
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof TemplateInput>(k: K, v: Required<TemplateInput>[K]) => setForm((f) => ({ ...f, [k]: v }))

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const input = { ...form, name: form.name.trim(), description: form.description.trim() }
      onDone(template ? await api.patchTemplate(app.slug, template.id, input) : await api.createTemplate(app.slug, input))
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <form className="box-row template-form" onSubmit={save}>
      <div className="form-grid">
        <div className="field">
          <label className="field-label" htmlFor="tpl-name">
            Name
          </label>
          <div className="input">
            <input id="tpl-name" value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={60} autoFocus placeholder="Bug report" />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="tpl-position">
            Order
          </label>
          <div className="input" style={{ width: 90 }}>
            <input id="tpl-position" className="mono" type="number" value={form.position} onChange={(e) => set("position", Number(e.target.value) || 0)} />
          </div>
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-description">
          Description
        </label>
        <div className="input">
          <input id="tpl-description" value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={140} placeholder="Shown in the template list" />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-title">
          Title
        </label>
        <div className="input">
          <input id="tpl-title" value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={256} placeholder="Prefilled issue title (optional)" />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-body">
          Body
        </label>
        <textarea id="tpl-body" className="textarea mono-area" rows={8} value={form.body} onChange={(e) => set("body", e.target.value)} />
      </div>
      {app.labels.length > 0 && (
        <div className="field">
          <span className="field-label">Labels</span>
          <div className="label-toggles">
            {app.labels.map((l) => {
              const on = form.label_ids.includes(l.id)
              return (
                <button
                  key={l.id}
                  type="button"
                  className="label-toggle"
                  aria-pressed={on}
                  onClick={() => set("label_ids", on ? form.label_ids.filter((id) => id !== l.id) : [...form.label_ids, l.id])}
                >
                  <Label name={l.name} color={l.color} />
                </button>
              )
            })}
          </div>
        </div>
      )}
      <label className="checkbox">
        <input type="checkbox" checked={form.ask_system_info} onChange={(e) => set("ask_system_info", e.target.checked)} />
        Offer “Attach system info”
      </label>
      {!!error && <p className="field-error">{error}</p>}
      <div className="form-actions">
        <Button variant="invisible" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving || !form.name.trim()}>
          {template ? "Save" : "Create template"}
        </Button>
      </div>
    </form>
  )
}

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <Button
      size="small"
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  )
}

/* Agents with access */

/** Agents with access to this workspace, from every account on its team. Admins set each one's role here, up to
 *  what its account allows, or remove it. Creating agents happens on the account's Agents page. */
function Agents({ app }: { app: AppDetail }) {
  const { data: agents, error } = useResource<AppAgent[]>(keys.appAgents(app.slug), () => api.appAgents(app.slug), 5_000)
  return (
    <div>
      <Heading title="Agents with access" />
      <p className="settings-lede">
        Agents belong to people's accounts and work here with the role set below, never above their owner's. To create a token agent or
        connect one, use{" "}
        <SiteLink href={homeUrl("/agents")}>your Agents page</SiteLink>.
      </p>
      <section className="box">
        {!agents && !error && <div className="box-row skeleton-row" />}
        {!!error && !agents && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {agents?.length === 0 && <div className="box-empty">No agents have access yet.</div>}
        {agents?.map((agent) => <AppAgentRow key={agent.id} slug={app.slug} agent={agent} />)}
      </section>
    </div>
  )
}

function AppAgentRow({ slug, agent }: { slug: string; agent: AppAgent }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const store = (fn: (list: AppAgent[]) => AppAgent[]) => setData<AppAgent[]>(keys.appAgents(slug), (list) => (list ? fn(list) : list))

  const setRole = async (role: AgentRole) => {
    setBusy(true)
    setError(null)
    try {
      const next = await api.patchAppAgent(slug, agent.id, role)
      store((list) => list.map((a) => (a.id === next.id ? next : a)))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.removeAppAgent(slug, agent.id)
      store((list) => list.filter((a) => a.id !== agent.id))
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }

  return (
    <div className="box-row settings-row app-agent-row">
      <AgentAvatar size={28} />
      <div className="settings-row-main">
        <div className="template-row-name">
          {agent.client_name} <span className="agent-kind">{agent.kind === "token" ? "Token agent" : "Connected app"}</span>
        </div>
        <div className="issue-meta">
          Approved by {agent.approved_by.name} ·{" "}
          {agent.last_used_at ? (
            <>
              last used <Time iso={agent.last_used_at} />
            </>
          ) : (
            "not used yet"
          )}
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
      {confirming ? (
        <div className="agent-confirm-inline">
          <span className="agent-confirm-text">Remove its access here? If it has all workspaces, this one is excluded.</span>
          <Button size="small" variant="invisible" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="small" variant="danger" onClick={remove} disabled={busy}>
            Remove
          </Button>
        </div>
      ) : (
        <div className="settings-row-actions">
          <RoleSelect
            value={agent.role}
            label={`Role for ${agent.client_name}`}
            disabled={busy}
            options={agentRoles.map((r) => ({
              value: r,
              label: agentRoleLabel[r],
              description: atLeast(agent.max_role, r) ? agentRoleText[r] : `Above its owner's role (${agentRoleLabel[agent.max_role].toLowerCase()} at most)`,
              disabled: !atLeast(agent.max_role, r),
            }))}
            onChange={setRole}
          />
          <Button size="small" variant="invisible" data-wide-only onClick={() => setConfirming(true)}>
            Remove
          </Button>
          <div className="narrow-only">
            <Menu
              align="end"
              width={220}
              trigger={(p) => <Button iconOnly size="small" variant="invisible" aria-label={`More for ${agent.client_name}`} icon={<KebabIcon />} {...p} />}
            >
              {(close) => (
                <MenuItem
                  danger
                  onSelect={() => {
                    close()
                    setConfirming(true)
                  }}
                >
                  Remove
                </MenuItem>
              )}
            </Menu>
          </div>
        </div>
      )}
    </div>
  )
}

/* Webhook */

function Webhook({ app }: { app: AppDetail }) {
  const { data: settings, error, reload } = useSettings(app.slug)
  const [url, setUrl] = useState<string | null>(null)
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const value = url ?? settings?.webhook.url ?? ""

  const act = async (name: string, fn: () => Promise<AppSettings | void>, done?: string) => {
    setBusy(name)
    setActionError(null)
    setNote(null)
    try {
      const next = await fn()
      if (next) setData(keys.settings(app.slug), next)
      if (done) setNote(done)
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const save = (e: FormEvent) => {
    e.preventDefault()
    act("save", async () => {
      const next = await api.putWebhook(app.slug, value.trim() || null)
      setUrl(null)
      return next
    }, value.trim() ? "Saved" : "Webhook removed")
  }

  if (!settings) {
    return (
      <div>
        <Heading title="Webhook" />
        {error ? <Flash error={errorMessage(error)} /> : <div className="skeleton" style={{ height: 32, width: "60%" }} />}
      </div>
    )
  }

  const secret = settings.webhook.secret
  return (
    <div className="settings-stack">
      <Heading title="Webhook" />
      <form className="field" onSubmit={save}>
        <label className="field-label" htmlFor="hook-url">
          Payload URL
        </label>
        <div className="row">
          <div className="input" style={{ flex: 1 }}>
            <input id="hook-url" type="url" value={value} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/bellhop" className="mono" />
          </div>
          <Button type="submit" variant="primary" disabled={busy === "save" || value === (settings.webhook.url ?? "")}>
            Save
          </Button>
        </div>
      </form>

      <div className="field">
        <span className="field-label">Signing secret</span>
        <div className="row">
          <code className="secret-value mono">{reveal ? secret : "•".repeat(Math.min(32, secret.length || 32))}</code>
          <Button size="small" onClick={() => setReveal((r) => !r)}>
            {reveal ? "Hide" : "Reveal"}
          </Button>
          <CopyButton text={secret} />
          <Button
            size="small"
            variant="danger"
            disabled={busy === "rotate"}
            onClick={() => confirm("Rotate the signing secret? Your receiver must switch to the new one.") && act("rotate", () => api.rotateWebhook(app.slug), "Secret rotated")}
          >
            Rotate
          </Button>
        </div>
      </div>

      <div className="row">
        <Button
          disabled={!settings.webhook.url || busy === "test"}
          onClick={() =>
            act("test", async () => {
              await api.testWebhook(app.slug)
              setTimeout(() => reload().catch(() => {}), 1500)
            }, "Test ping sent")
          }
        >
          Send test
        </Button>
        {note && <span className="muted-text">{note}</span>}
      </div>
      <Flash error={actionError} />

      <div>
        <h2 className="section-title">Recent deliveries</h2>
        <section className="box">
          {settings.webhook.deliveries.length === 0 ? (
            <div className="box-empty">No deliveries yet.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Status</th>
                    <th>Response</th>
                    <th>Attempts</th>
                    <th>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {settings.webhook.deliveries.map((d) => (
                    <tr key={d.id}>
                      <td className="mono">{d.event}</td>
                      <td>
                        <span className="delivery-status" data-status={d.status}>
                          {d.status === "delivered" ? "Delivered" : d.status === "failed" ? "Failed" : "Pending"}
                        </span>
                      </td>
                      <td className="mono">{d.response_status ?? "—"}</td>
                      <td className="mono">{d.attempts}</td>
                      <td>
                        <Time iso={d.created_at} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

/* Members */

const elevated = (role: Role) => role === "owner" || role === "admin"

/** The server's refusals, in plain words: 403 when an admin touches admins or owners, 409 for the last owner. */
function memberError(e: unknown) {
  if (e instanceof ApiFailure && e.code === "last_owner") return "A workspace must keep at least one owner who has signed in."
  if (e instanceof ApiFailure && e.status === 403) return "Only owners can add, change or remove admins and owners."
  return errorMessage(e)
}

function Members({ app }: { app: AppDetail }) {
  const { data: settings, error } = useSettings(app.slug)
  const { data: me } = useMe()
  const admin = canSetup(app.role)
  const owner = app.role === "owner"
  // Owners first, then admins, members and viewers; by name within each.
  const members = [...(settings?.members ?? [])].sort(
    (a, b) => teamRoles.indexOf(a.role) - teamRoles.indexOf(b.role) || (a.name ?? a.email).localeCompare(b.name ?? b.email),
  )
  const joinedOwners = members.filter((m) => m.role === "owner" && m.joined).length
  const [note, setNote] = useState<string | null>(null)

  return (
    <div>
      <Heading title="Members" />
      {admin ? <Invite app={app} owner={owner} /> : <p className="settings-readonly">Only admins and owners can manage members.</p>}
      {note && <p className="settings-note">{note}</p>}
      <section className="box">
        {!settings && !error && <div className="box-row skeleton-row" />}
        {!!error && !settings && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {members.map((m) => (
          <MemberRow
            key={m.id}
            app={app}
            member={m}
            you={!!me?.user && me.user.id === m.id}
            canManage={admin && (owner || !elevated(m.role))}
            owner={owner}
            lastOwner={m.role === "owner" && m.joined && joinedOwners <= 1}
            onNote={setNote}
          />
        ))}
      </section>
    </div>
  )
}

function Invite({ app, owner }: { app: AppDetail; owner: boolean }) {
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("member")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const invite = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      setData(keys.settings(app.slug), await api.addMember(app.slug, email.trim(), role))
      setEmail("")
      setRole("member")
    } catch (err) {
      setError(memberError(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="member-invite" onSubmit={invite}>
      <div className="member-invite-row">
        <div className="input">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" aria-label="Email to invite" autoComplete="off" />
        </div>
        <RoleSelect
          value={role}
          label="Role for the invite"
          options={teamRoles.map((r) => ({
            value: r,
            label: roleLabel[r],
            description: !owner && elevated(r) ? "Only owners can invite admins and owners" : roleText[r],
            disabled: !owner && elevated(r),
          }))}
          onChange={setRole}
        />
        <Button type="submit" variant="primary" disabled={busy || !email.trim()}>
          {busy ? "Inviting…" : "Invite"}
        </Button>
      </div>
      {error ? <p className="field-error">{error}</p> : <p className="member-invite-hint">They join when they sign in with that email.</p>}
    </form>
  )
}

function MemberRow({
  app,
  member,
  you,
  canManage,
  owner,
  lastOwner,
  onNote,
}: {
  app: AppDetail
  member: Member
  you: boolean
  canManage: boolean
  owner: boolean
  lastOwner: boolean
  onNote: (note: string | null) => void
}) {
  const [confirm, setConfirm] = useState<{ kind: "remove" } | { kind: "role"; role: Role } | { kind: "transfer" } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const who = member.name ?? member.email

  const act = async (fn: () => Promise<AppSettings>, done?: string) => {
    setBusy(true)
    setError(null)
    onNote(null)
    try {
      setData(keys.settings(app.slug), await fn())
      setConfirm(null)
      if (done) onNote(done)
    } catch (e) {
      setError(memberError(e))
    } finally {
      setBusy(false)
    }
  }

  const change = (role: Role) => {
    // Lowering your own role can take these settings away from you; ask first.
    if (you && !atLeast(role, member.role)) return setConfirm({ kind: "role", role })
    void act(() => api.patchMember(app.slug, member.id, role))
  }

  const confirmText =
    confirm?.kind === "remove"
      ? you
        ? "Leave this workspace?"
        : `Remove ${who}?`
      : confirm?.kind === "role"
        ? `Become ${roleLabel[confirm.role].toLowerCase()}? You may lose access to these settings.`
        : confirm?.kind === "transfer"
          ? `Make ${who} an owner too?`
          : ""

  return (
    <div className="box-row settings-row member-row">
      <UserAvatar user={member} size={32} />
      <div className="settings-row-main">
        <div className="template-row-name">
          {who}
          {you && <span className="member-you"> (you)</span>}
        </div>
        <div className="issue-meta">
          {member.name ? member.email : ""}
          {!member.joined && `${member.name ? " · " : ""}Invited, hasn't signed in yet`}
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
      {confirm ? (
        <div className="agent-confirm-inline">
          <span className="agent-confirm-text">{confirmText}</span>
          <Button size="small" variant="invisible" onClick={() => setConfirm(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="small"
            variant={confirm.kind === "transfer" ? "primary" : "danger"}
            disabled={busy}
            onClick={() =>
              confirm.kind === "remove"
                ? act(() => api.removeMember(app.slug, member.id))
                : confirm.kind === "role"
                  ? act(() => api.patchMember(app.slug, member.id, confirm.role))
                  : act(() => api.transfer(app.slug, member.id), `${who} is now an owner too. If you're handing over, change your own role.`)
            }
          >
            {confirm.kind === "remove" ? (you ? "Leave" : "Remove") : confirm.kind === "role" ? "Change" : "Make owner"}
          </Button>
        </div>
      ) : (
        <div className="settings-row-actions member-actions">
          {canManage ? (
            <RoleSelect
              value={member.role}
              label={`Role for ${who}`}
              disabled={busy}
              options={teamRoles.map((r) => {
                const ownerOnly = !owner && elevated(r)
                const keepOwner = lastOwner && r !== "owner"
                return {
                  value: r,
                  label: roleLabel[r],
                  description: keepOwner ? "A workspace needs an owner who has signed in" : ownerOnly ? "Only owners can grant this" : roleText[r],
                  disabled: ownerOnly || keepOwner,
                }
              })}
              onChange={change}
            />
          ) : (
            <RoleBadge role={member.role} />
          )}
          {canManage && (
            <Menu
              align="end"
              width={240}
              trigger={(p) => <Button iconOnly size="small" variant="invisible" aria-label={`More for ${who}`} icon={<KebabIcon />} {...p} />}
            >
              {(close) => (
                <>
                  {owner && member.joined && member.role !== "owner" && (
                    <MenuItem
                      description="They become an owner too; you stay one"
                      onSelect={() => {
                        close()
                        setConfirm({ kind: "transfer" })
                      }}
                    >
                      Transfer ownership
                    </MenuItem>
                  )}
                  <MenuItem
                    danger
                    disabled={lastOwner}
                    description={lastOwner ? "A workspace needs an owner who has signed in" : undefined}
                    onSelect={() => {
                      close()
                      setConfirm({ kind: "remove" })
                    }}
                  >
                    {you ? "Leave workspace" : "Remove"}
                  </MenuItem>
                </>
              )}
            </Menu>
          )}
        </div>
      )}
    </div>
  )
}

/* Blocked */

/** Guests and accounts blocked from posting here, with who blocked them and when. Unblocking doesn't unhide. */
function Blocked({ app }: { app: AppDetail }) {
  const { data: blocks, error } = useResource<Block[]>(keys.blocks(app.slug), () => api.blocks(app.slug), 5_000)
  return (
    <div>
      <Heading title="Blocked" />
      <p className="settings-lede">Blocked people can still read, but can't post, edit or upload here. Block someone from the "…" on one of their comments.</p>
      <section className="box">
        {!blocks && !error && <div className="box-row skeleton-row" />}
        {!!error && !blocks && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {blocks?.length === 0 && <div className="box-empty">No one is blocked.</div>}
        {blocks?.map((b) => <BlockRow key={b.id} slug={app.slug} block={b} />)}
      </section>
    </div>
  )
}

function BlockRow({ slug, block }: { slug: string; block: Block }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const unblock = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.unblock(slug, block.id)
      setData<Block[]>(keys.blocks(slug), (list) => list?.filter((x) => x.id !== block.id))
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="box-row settings-row block-row">
      <ActorAvatar actor={block.actor} size={28} />
      <div className="settings-row-main">
        <div className="template-row-name">
          {actorName(block.actor)} <span className="agent-kind">{block.actor.type === "guest" ? "Guest" : "Account"}</span>
        </div>
        <div className="issue-meta">
          Blocked by {actorName(block.by)} <Time iso={block.created_at} />
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
      <div className="settings-row-actions">
        <Button size="small" onClick={unblock} disabled={busy}>
          {busy ? "Unblocking…" : "Unblock"}
        </Button>
      </div>
    </div>
  )
}
