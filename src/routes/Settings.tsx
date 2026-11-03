import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react"
import { Link } from "wouter"
import type { App, AppDetail, AppSettings, Label as LabelType, NewToken, Template, TemplateInput } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { invalidate, setData, useResource } from "../lib/cache"
import { Time } from "../lib/time"
import { UserAvatar } from "../ui/Actor"
import { PlusIcon } from "../ui/icons"
import { AppLayout, Page } from "../ui/Shell"
import { Button, Label } from "../ui/primitives"

type Section = "general" | "labels" | "templates" | "agents" | "webhook" | "members"

const sections: { id: Section; label: string; owner?: boolean }[] = [
  { id: "general", label: "General" },
  { id: "labels", label: "Labels" },
  { id: "templates", label: "Templates" },
  { id: "agents", label: "Agents", owner: true },
  { id: "webhook", label: "Webhook", owner: true },
  { id: "members", label: "Members", owner: true },
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
          <h1 className="blank-title">Members only</h1>
          <p className="muted-text">Sign in with an account that belongs to this application.</p>
          <Link href={`/?next=${encodeURIComponent(`/${app.slug}/settings`)}`} className="btn">
            Sign in
          </Link>
        </div>
      </Page>
    )
  }
  return <SettingsLayout app={app} section={section} />
}

function SettingsLayout({ app, section }: { app: AppDetail; section: Section }) {
  const owner = app.role === "owner"
  const visible = sections.filter((s) => !s.owner || owner)
  const active = visible.some((s) => s.id === section) ? section : "general"
  const nav = useRef<HTMLElement>(null)
  // On phones the section list scrolls sideways; keep the current one in view.
  useEffect(() => {
    nav.current?.querySelector("[aria-current=page]")?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [active])
  return (
    <Page>
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings" ref={nav}>
          {visible.map((s) => (
            <Link key={s.id} href={`/${app.slug}/settings${s.id === "general" ? "" : `/${s.id}`}`} aria-current={active === s.id ? "page" : undefined}>
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
  const owner = app.role === "owner"
  const [name, setName] = useState(app.name)
  const [description, setDescription] = useState(app.description)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await api.patchApp(app.slug, { name: name.trim(), description: description.trim() })
      setData(keys.app(app.slug), next)
      setData<App[]>(keys.apps, (apps) => apps?.map((a) => (a.id === next.id ? { ...a, name: next.name, description: next.description } : a)))
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
      <div className="field">
        <label className="field-label" htmlFor="set-name">
          Name
        </label>
        <div className="input">
          <input id="set-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!owner} required maxLength={80} />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="set-description">
          Description
        </label>
        <textarea
          id="set-description"
          className="textarea"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!owner}
          maxLength={500}
        />
      </div>
      <div className="field">
        <span className="field-label">Public page</span>
        <a className="mono" href={`/${app.slug}`}>
          {location.host}/{app.slug}
        </a>
      </div>
      <Flash error={error} />
      {owner ? (
        <div className="row">
          <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {saved && <span className="muted-text">Saved</span>}
        </div>
      ) : (
        <p className="muted-text">Only the owner can change these.</p>
      )}
    </form>
  )
}

/* Labels */

const palette = ["fa4d56", "ff832b", "f1c21b", "42be65", "08bdba", "33b1ff", "4589ff", "a56eff", "ee5396", "878d96"]
const randomColor = () => palette[Math.floor(Math.random() * palette.length)]!

function Labels({ app }: { app: AppDetail }) {
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
          editing !== "new" && (
            <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setEditing("new")}>
              New label
            </Button>
          )
        }
      />
      <Flash error={error} />
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
            <div key={label.id} className="box-row settings-row">
              <div className="settings-row-label">
                <Label name={label.name} color={label.color} />
              </div>
              <div className="settings-row-main muted-text">{label.description}</div>
              <div className="settings-row-actions">
                <Button size="small" variant="invisible" onClick={() => setEditing(label.id)}>
                  Edit
                </Button>
                <Button size="small" variant="invisible" onClick={() => remove(label)}>
                  Delete
                </Button>
              </div>
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
          editing !== "new" && (
            <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setEditing("new")}>
              New template
            </Button>
          )
        }
      />
      <Flash error={error} />
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
              <div className="settings-row-actions">
                <Button size="small" variant="invisible" onClick={() => setEditing(t.id)}>
                  Edit
                </Button>
                <Button size="small" variant="invisible" onClick={() => remove(t)}>
                  Delete
                </Button>
              </div>
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

/* Agents */

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

function Agents({ app }: { app: AppDetail }) {
  const { data: settings, error } = useSettings(app.slug)
  const [name, setName] = useState("OpenCode")
  const [created, setCreated] = useState<NewToken | null>(null)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setActionError(null)
    try {
      const token = await api.createToken(app.slug, name.trim())
      setCreated(token)
      const { token: _secret, ...stored } = token
      setData<AppSettings>(keys.settings(app.slug), (s) => (s ? { ...s, tokens: [stored, ...s.tokens] } : s))
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string, tokenName: string) => {
    if (!confirm(`Delete the “${tokenName}” token? Agents using it lose access at once.`)) return
    setActionError(null)
    try {
      await api.deleteToken(app.slug, id)
      setData<AppSettings>(keys.settings(app.slug), (s) => (s ? { ...s, tokens: s.tokens.filter((t) => t.id !== id) } : s))
      if (created?.id === id) setCreated(null)
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  const snippet = created && settings
    ? JSON.stringify({ mcp: { bellhop: { type: "remote", url: settings.mcp_url, headers: { Authorization: `Bearer ${created.token}` } } } }, null, 2)
    : ""

  return (
    <div>
      <Heading title="Agents" />
      <form className="row settings-inline-form" onSubmit={create}>
        <div className="input" style={{ flex: 1, maxWidth: 320 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Token name" placeholder="Agent name" maxLength={40} />
        </div>
        <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
          {saving ? "Creating…" : "Create token"}
        </Button>
      </form>
      <Flash error={actionError} />

      {created && (
        <div className="secret-panel">
          <p className="secret-panel-title">Copy this token now. It won't be shown again.</p>
          <div className="secret-line">
            <code className="mono">{created.token}</code>
            <CopyButton text={created.token} />
          </div>
          <div className="secret-snippet-head">
            <span className="field-label">OpenCode config</span>
            <CopyButton text={snippet} />
          </div>
          <pre className="code-block">{snippet}</pre>
        </div>
      )}

      <section className="box">
        {!settings && !error && <div className="box-row skeleton-row" />}
        {!!error && !settings && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {settings?.tokens.length === 0 && <div className="box-empty">No tokens yet.</div>}
        {settings?.tokens.map((t) => (
          <div key={t.id} className="box-row settings-row">
            <div className="settings-row-main">
              <div className="template-row-name">{t.name}</div>
              <div className="issue-meta">
                <span className="mono">{t.preview}</span> · created <Time iso={t.created_at} /> ·{" "}
                {t.last_used_at ? (
                  <>
                    last used <Time iso={t.last_used_at} />
                  </>
                ) : (
                  "never used"
                )}
              </div>
            </div>
            <div className="settings-row-actions">
              <Button size="small" variant="danger" onClick={() => remove(t.id, t.name)}>
                Delete
              </Button>
            </div>
          </div>
        ))}
      </section>
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

function Members({ app }: { app: AppDetail }) {
  const { data: settings, error } = useSettings(app.slug)
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const invite = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    setActionError(null)
    try {
      setData(keys.settings(app.slug), await api.addMember(app.slug, email.trim()))
      setEmail("")
    } catch (err) {
      setActionError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string, who: string) => {
    if (!confirm(`Remove ${who} from ${app.name}?`)) return
    setActionError(null)
    try {
      setData(keys.settings(app.slug), await api.removeMember(app.slug, id))
    } catch (err) {
      setActionError(errorMessage(err))
    }
  }

  return (
    <div>
      <Heading title="Members" />
      <form className="row settings-inline-form" onSubmit={invite}>
        <div className="input" style={{ flex: 1, maxWidth: 320 }}>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" aria-label="Email to invite" />
        </div>
        <Button type="submit" variant="primary" disabled={busy || !email.trim()}>
          Invite
        </Button>
      </form>
      <Flash error={actionError} />
      <section className="box">
        {!settings && !error && <div className="box-row skeleton-row" />}
        {!!error && !settings && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {settings?.members.map((m) => (
          <div key={m.id} className="box-row settings-row member-row">
            <UserAvatar user={m} size={32} />
            <div className="settings-row-main">
              <div className="template-row-name">{m.name ?? m.email}</div>
              <div className="issue-meta">{m.name ? m.email : m.joined ? "" : "Hasn't signed in yet"}</div>
            </div>
            <span className="role-badge">{m.role === "owner" ? "Owner" : m.joined ? "Member" : "Invited"}</span>
            <div className="settings-row-actions">
              {m.role !== "owner" && (
                <Button size="small" variant="invisible" onClick={() => remove(m.id, m.name ?? m.email)}>
                  Remove
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
