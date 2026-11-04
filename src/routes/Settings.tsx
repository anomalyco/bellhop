import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode } from "react"
import { Link, useLocation } from "wouter"
import type { AgentRole, App, AppAgent, AppDetail, AppSettings, AppVisibility, Block, Label as LabelType, Member, Role, Template, TemplateInput, WebhookEventType } from "../../shared/api"
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
import { appLabel, appPath, homeUrl, isAbsolute, signInHref } from "../lib/site"
import { SiteLink } from "../ui/SiteLink"
import { PublicToggle, VisibilityValue } from "../ui/workspace/Visibility"
import { ColorField, randomColor } from "../ui/ColorField"
import { Tiers } from "./settings/Tiers"
import { ReportKeys } from "./settings/ReportKeys"
import { WebhookEvents, sameEvents } from "./settings/WebhookEvents"
import { DocsLink } from "./settings/DocsLink"
import { LastUsed } from "./settings/LastUsed"
import { Insights } from "./settings/Insights"
import { AuditLog } from "./settings/AuditLog"
import { SavedReplies } from "./settings/SavedReplies"
import { Data } from "./settings/Data"
import { Reminders, reminderText } from "./settings/Reminders"
import { t, tr, tKey, useT, type PlainKey } from "../i18n/settings"
import { t as tc } from "../i18n/core"
import { sentenceGap } from "../i18n"
import "../styles/agents.css"
import "../styles/onboarding.css"
import "../styles/settings.css"
import "../styles/moderation.css"
import { t as td, useT as useDeskT } from "../i18n/helpdesk"
import { isDesk } from "../lib/helpdesk"
import { HelpdeskSettings } from "./settings/Helpdesk"
import { IdentityKeys } from "./settings/IdentityKeys"
import { ApiKeys } from "./settings/ApiKeys"
import { WidgetSettings } from "./settings/Widget"
import { RequestTypes } from "./settings/RequestTypes"

type Section =
  | "general"
  | "insights"
  | "labels"
  | "templates"
  | "saved-replies"
  | "agents"
  | "webhook"
  | "report-keys"
  | "members"
  | "tiers"
  | "blocked"
  | "data"
  | "audit"
  | "helpdesk"
  | "identity-keys"
  | "api-keys"
  | "widget"
  | "request-types"

// `min`: the least role that sees the section. Below admin, General, Labels, Templates and Members are read-only.
// `desk`: only for workspaces in help desk mode.
const sections: { id: Section; min: Role; desk?: boolean }[] = [
  { id: "general", min: "viewer" },
  { id: "insights", min: "member" },
  { id: "labels", min: "viewer" },
  { id: "templates", min: "viewer" },
  { id: "saved-replies", min: "viewer" },
  { id: "members", min: "member" },
  { id: "agents", min: "admin" },
  { id: "webhook", min: "admin" },
  { id: "report-keys", min: "admin" },
  { id: "helpdesk", min: "admin" },
  { id: "request-types", min: "admin", desk: true },
  { id: "identity-keys", min: "admin", desk: true },
  { id: "api-keys", min: "admin", desk: true },
  { id: "widget", min: "admin", desk: true },
  { id: "tiers", min: "member" },
  { id: "blocked", min: "member" },
  { id: "data", min: "admin" },
  { id: "audit", min: "admin" },
]
// The help desk's sections are named in its own namespace, with the rest of their copy
const deskLabels = { helpdesk: "settings.title", "request-types": "types.title", "identity-keys": "keys.title", "api-keys": "apiKeys.title", widget: "widget.title" } as const
type DeskSection = keyof typeof deskLabels
const sectionLabel = (id: Section) => (id in deskLabels ? td(deskLabels[id as DeskSection]) : tKey(`section.${id as Exclude<Section, DeskSection>}`))

export default function Settings({ slug, section }: { slug: string; section?: string }) {
  return (
    <AppLayout slug={slug} tab="settings">
      {(app) => <SettingsBody app={app} section={(sections.find((s) => s.id === section)?.id ?? "general") as Section} />}
    </AppLayout>
  )
}

function SettingsBody({ app, section }: { app: AppDetail; section: Section }) {
  useT()
  if (!app.role) {
    return (
      <Page narrow>
        <div className="blank">
          <h1 className="blank-title">{t("team.title")}</h1>
          <p className="muted-text">{t("team.text")}</p>
          <a href={signInHref()} className="btn">
            {tc("common.signIn")}
          </a>
        </div>
      </Page>
    )
  }
  return <SettingsLayout app={app} section={section} />
}

function SettingsLayout({ app, section }: { app: AppDetail; section: Section }) {
  useDeskT()
  const visible = sections.filter((s) => atLeast(app.role, s.min) && (!s.desk || isDesk(app)))
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
        <nav className="settings-nav" aria-label={tc("header.settings")} ref={nav} onScroll={edges}>
          {visible.map((s) => (
            <Link key={s.id} href={appPath(app.slug, s.id === "general" ? "/settings" : `/settings/${s.id}`)} aria-current={active === s.id ? "page" : undefined}>
              {sectionLabel(s.id)}
            </Link>
          ))}
        </nav>
        <div className="settings-main">
          {active === "general" && <General app={app} />}
          {active === "insights" && <Insights app={app} />}
          {active === "saved-replies" && <SavedReplies app={app} />}
          {active === "audit" && <AuditLog app={app} />}
          {active === "data" && <Data app={app} />}
          {active === "labels" && <Labels app={app} />}
          {active === "templates" && <Templates app={app} />}
          {active === "agents" && <Agents app={app} />}
          {active === "webhook" && <Webhook app={app} />}
          {active === "report-keys" && <ReportKeys app={app} />}
          {active === "helpdesk" && <HelpdeskSettings app={app} />}
          {active === "identity-keys" && <IdentityKeys app={app} />}
          {active === "request-types" && <RequestTypes app={app} />}
          {active === "api-keys" && <ApiKeys app={app} />}
          {active === "widget" && <WidgetSettings app={app} />}
          {active === "members" && <Members app={app} />}
          {active === "tiers" && <Tiers app={app} />}
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

/** A role inside a sentence ("Become member?"), in the language's in-sentence form. */
const roleWord = (role: Role | AgentRole) => tKey(`roleWord.${role}`)

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
  const [nudge, setNudge] = useState<number | null>(app.nudge_days ?? null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const next = await api.patchApp(app.slug, { name: name.trim(), description: description.trim(), public: isPublic, visibility: issues, nudge_days: nudge })
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
      <Heading title={sectionLabel("general")} />
      <IconField app={app} />
      {admin ? (
        <>
          <div className="field">
            <label className="field-label" htmlFor="set-name">
              {t("field.name")}
            </label>
            <div className="input">
              <input id="set-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            </div>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="set-description">
              {t("field.description")}
            </label>
            <textarea id="set-description" className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </div>
          <div className="field">
            <span className="field-label">{t("general.visibility")}</span>
            <PublicToggle value={isPublic} onChange={setPublic} id="set-public" />
          </div>
          <div className="field">
            <span className="field-label" id="set-issues-label">
              {t("general.newIssues")}
            </span>
            <IssueVisibilityControl value={issues} onChange={setIssues} />
          </div>
          <div className="field">
            <span className="field-label" id="set-reminders-label">
              {t("general.reminders")}
            </span>
            <Reminders value={nudge} onChange={setNudge} />
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <span className="field-label">{t("field.name")}</span>
            <p className="settings-value">{app.name}</p>
          </div>
          <div className="field">
            <span className="field-label">{t("field.description")}</span>
            <p className="settings-value">{app.description || <span className="muted-text">{t("general.noDescription")}</span>}</p>
          </div>
          <div className="field">
            <span className="field-label">{t("general.visibility")}</span>
            <VisibilityValue value={!!app.public} />
          </div>
          <div className="field">
            <span className="field-label">{t("general.newIssues")}</span>
            <p className="settings-value visibility-value">
              {app.visibility?.default === "private" ? t("general.private") : t("general.public")}
              <span className="visibility-hint">{issueVisibilityText(app.visibility ?? { default: "public", reporter_can_choose: false })}</span>
            </p>
          </div>
          <div className="field">
            <span className="field-label">{t("general.reminders")}</span>
            <p className="settings-value visibility-value">
              {app.nudge_days ? t("general.remindersAfter", { count: app.nudge_days }) : t("general.remindersOff")}
              <span className="visibility-hint">{reminderText()}</span>
            </p>
          </div>
        </>
      )}
      <div className="field">
        <span className="field-label">{t("general.publicPage")}</span>
        <a className="mono" href={appPath(app.slug)}>
          {appLabel(app.slug)}
        </a>
      </div>
      <Flash error={error} />
      {admin ? (
        <div className="row">
          <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
            {saving ? tc("common.saving") : tc("common.save")}
          </Button>
          {saved && <span className="muted-text">{t("saved")}</span>}
        </div>
      ) : (
        <p className="muted-text">{app.role === "member" ? t("general.readOnlyMember") : t("general.readOnlyViewer")}</p>
      )}
    </form>
  )
}

const issueVisibilityText = (v: AppVisibility) =>
  [
    v.default === "private" ? t("general.privateRead") : t("general.publicRead"),
    v.reporter_can_choose ? t("general.reporterChooses") : t("general.reporterFixed"),
    t("general.teamCanChange"),
  ].join(sentenceGap())

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
            {d === "public" ? t("general.public") : t("general.private")}
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
        {t("general.reportersCanChoose")}
      </label>
      <p className="visibility-hint">{issueVisibilityText(value)}</p>
    </div>
  )
}

const iconTypes = ["image/png", "image/jpeg", "image/webp"]
const iconLimit = 1024 * 1024
const tooBig = () => t("icon.tooBig")
const wrongType = () => t("icon.wrongType")

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
    if (!iconTypes.includes(file.type)) return setError(wrongType())
    if (file.size > iconLimit) return setError(tooBig())
    setBusy("upload")
    try {
      store(await api.putIcon(app.slug, file))
    } catch (e) {
      setError(e instanceof ApiFailure && e.status === 413 ? tooBig() : e instanceof ApiFailure && e.status === 415 ? wrongType() : errorMessage(e))
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
      <span className="field-label">{t("icon.label")}</span>
      <div className="icon-field">
        <AppIcon src={app.icon_url} size={48} />
        {owner ? (
          <div className="icon-field-main">
            <div className="row">
              <Button size="small" onClick={() => input.current?.click()} disabled={!!busy}>
                {busy === "upload" ? t("icon.uploading") : app.icon_url ? t("icon.replace") : t("icon.upload")}
              </Button>
              {app.icon_url && (
                <Button size="small" variant="invisible" onClick={remove} disabled={!!busy}>
                  {busy === "remove" ? t("icon.removing") : tc("common.remove")}
                </Button>
              )}
            </div>
            <span className="icon-field-hint">{t("icon.hint")}</span>
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
          <span className="icon-field-hint">{app.icon_url ? t("icon.shown") : t("icon.default")}</span>
        )}
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

/* Labels */


function Labels({ app }: { app: AppDetail }) {
  const admin = canSetup(app.role)
  const [editing, setEditing] = useState<string | "new" | null>(null)
  const labels = app.labels
  const store = (next: LabelType[]) => setData<AppDetail>(keys.app(app.slug), (a) => (a ? { ...a, labels: next.sort((x, y) => x.name.localeCompare(y.name)) } : a))
  const [error, setError] = useState<string | null>(null)

  const remove = async (label: LabelType) => {
    if (!confirm(t("labels.confirmDelete", { name: label.name }))) return
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
        title={sectionLabel("labels")}
        action={
          admin &&
          editing !== "new" && (
            <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setEditing("new")}>
              {t("labels.new")}
            </Button>
          )
        }
      />
      <Flash error={error} />
      {!admin && <p className="settings-readonly">{t("labels.readOnly")}</p>}
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
        {labels.length === 0 && editing !== "new" && <div className="box-empty">{t("labels.empty")}</div>}
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
                    {tc("common.edit")}
                  </Button>
                  <Button size="small" variant="invisible" onClick={() => remove(label)}>
                    {tc("common.delete")}
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
        <Label name={name.trim() || t("labels.preview")} color={valid ? color : "878d96"} />
      </div>
      <div className="label-form-fields">
        <div className="field">
          <label className="field-label" htmlFor="label-name">
            {t("field.name")}
          </label>
          <div className="input">
            <input id="label-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={50} autoFocus />
          </div>
        </div>
        <div className="field" style={{ flex: 2 }}>
          <label className="field-label" htmlFor="label-description">
            {t("field.description")}
          </label>
          <div className="input">
            <input id="label-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={100} placeholder={t("field.optional")} />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="label-color">
            {t("field.colour")}
          </label>
          <ColorField id="label-color" value={color} onChange={setColor} />
        </div>
        <div className="label-form-actions">
          <Button variant="invisible" onClick={() => onDone(null)}>
            {tc("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !name.trim() || !valid}>
            {label ? tc("common.save") : t("labels.create")}
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

  const remove = async (tpl: Template) => {
    if (!confirm(t("templates.confirmDelete", { name: tpl.name }))) return
    setError(null)
    try {
      await api.deleteTemplate(app.slug, tpl.id)
      store(templates.filter((x) => x.id !== tpl.id))
    } catch (e) {
      setError(errorMessage(e))
    }
  }

  return (
    <div>
      <Heading
        title={sectionLabel("templates")}
        action={
          admin &&
          editing !== "new" && (
            <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setEditing("new")}>
              {t("templates.new")}
            </Button>
          )
        }
      />
      <Flash error={error} />
      {!admin && <p className="settings-readonly">{t("templates.readOnly")}</p>}
      <section className="box">
        {editing === "new" && (
          <TemplateForm
            app={app}
            position={(templates[templates.length - 1]?.position ?? -1) + 1}
            onDone={(tpl) => {
              if (tpl) store([...templates, tpl])
              setEditing(null)
            }}
          />
        )}
        {templates.length === 0 && editing !== "new" && <div className="box-empty">{t("templates.empty")}</div>}
        {templates.map((tpl) =>
          editing === tpl.id ? (
            <TemplateForm
              key={tpl.id}
              app={app}
              template={tpl}
              position={tpl.position}
              onDone={(next) => {
                if (next) store(templates.map((x) => (x.id === next.id ? next : x)))
                setEditing(null)
              }}
            />
          ) : (
            <div key={tpl.id} className="box-row settings-row">
              <div className="settings-row-main">
                <div className="template-row-name">{tpl.name}</div>
                <div className="issue-meta">
                  {tpl.description}
                  {tpl.ask_system_info && <span className="muted-text"> · {t("templates.asksSystemInfo")}</span>}
                </div>
                {tpl.label_ids.length > 0 && (
                  <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                    {app.labels
                      .filter((l) => tpl.label_ids.includes(l.id))
                      .map((l) => (
                        <Label key={l.id} name={l.name} color={l.color} />
                      ))}
                  </div>
                )}
              </div>
              {admin && (
                <div className="settings-row-actions">
                  <Button size="small" variant="invisible" onClick={() => setEditing(tpl.id)}>
                    {tc("common.edit")}
                  </Button>
                  <Button size="small" variant="invisible" onClick={() => remove(tpl)}>
                    {tc("common.delete")}
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
  onDone: (template: Template | null) => void
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
            {t("field.name")}
          </label>
          <div className="input">
            <input id="tpl-name" value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={60} autoFocus placeholder={t("templates.namePlaceholder")} />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="tpl-position">
            {t("templates.order")}
          </label>
          <div className="input" style={{ width: 90 }}>
            <input id="tpl-position" className="mono" type="number" value={form.position} onChange={(e) => set("position", Number(e.target.value) || 0)} />
          </div>
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-description">
          {t("field.description")}
        </label>
        <div className="input">
          <input id="tpl-description" value={form.description} onChange={(e) => set("description", e.target.value)} maxLength={140} placeholder={t("templates.descriptionPlaceholder")} />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-title">
          {t("templates.title")}
        </label>
        <div className="input">
          <input id="tpl-title" value={form.title} onChange={(e) => set("title", e.target.value)} maxLength={256} placeholder={t("templates.titlePlaceholder")} />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor="tpl-body">
          {t("templates.body")}
        </label>
        <textarea id="tpl-body" className="textarea mono-area" rows={8} value={form.body} onChange={(e) => set("body", e.target.value)} />
      </div>
      {app.labels.length > 0 && (
        <div className="field">
          <span className="field-label">{t("templates.labels")}</span>
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
        {t("templates.offerSystemInfo")}
      </label>
      {!!error && <p className="field-error">{error}</p>}
      <div className="form-actions">
        <Button variant="invisible" onClick={() => onDone(null)}>
          {tc("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={saving || !form.name.trim()}>
          {template ? tc("common.save") : t("templates.create")}
        </Button>
      </div>
    </form>
  )
}

function CopyButton({ text, label = tc("common.copy") }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button
      size="small"
      onClick={async () => {
        await navigator.clipboard.writeText(text)
        setCopied(true)
      }}
    >
      {copied ? tc("common.copied") : label}
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
      <Heading title={t("agents.title")} action={<DocsLink page="mcp" />} />
      <p className="settings-lede">{tr("agents.lede", { link: <SiteLink href={homeUrl("/agents")}>{t("agents.ledeLink")}</SiteLink> })}</p>
      <section className="box">
        {!agents && !error && <div className="box-row skeleton-row" />}
        {!!error && !agents && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {agents?.length === 0 && <div className="box-empty">{t("agents.empty")}</div>}
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
          {agent.client_name} <span className="agent-kind">{agent.kind === "token" ? t("agents.token") : t("agents.connected")}</span>
        </div>
        <div className="issue-meta">
          {tr("agents.meta", { name: agent.approved_by.name, used: <LastUsed iso={agent.last_used_at} /> })}
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
      {confirming ? (
        <div className="agent-confirm-inline">
          <span className="agent-confirm-text">{t("agents.confirmRemove")}</span>
          <Button size="small" variant="invisible" onClick={() => setConfirming(false)} disabled={busy}>
            {tc("common.cancel")}
          </Button>
          <Button size="small" variant="danger" onClick={remove} disabled={busy}>
            {tc("common.remove")}
          </Button>
        </div>
      ) : (
        <div className="settings-row-actions">
          <RoleSelect
            value={agent.role}
            label={t("roleFor", { name: agent.client_name })}
            disabled={busy}
            options={agentRoles.map((r) => ({
              value: r,
              label: agentRoleLabel[r],
              description: atLeast(agent.max_role, r) ? agentRoleText[r] : t("agents.aboveOwner", { role: roleWord(agent.max_role) }),
              disabled: !atLeast(agent.max_role, r),
            }))}
            onChange={setRole}
          />
          <Button size="small" variant="invisible" data-wide-only onClick={() => setConfirming(true)}>
            {tc("common.remove")}
          </Button>
          <div className="narrow-only">
            <Menu
              align="end"
              width={220}
              trigger={(p) => <Button iconOnly size="small" variant="ghost-muted" aria-label={t("moreFor", { name: agent.client_name })} icon={<KebabIcon />} {...p} />}
            >
              {(close) => (
                <MenuItem
                  danger
                  onSelect={() => {
                    close()
                    setConfirming(true)
                  }}
                >
                  {tc("common.remove")}
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
  const { data: settings, error, reload } = useResource<AppSettings>(keys.settings(app.slug), () => api.settings(app.slug), -1)
  const [url, setUrl] = useState<string | null>(null)
  const [events, setEvents] = useState<WebhookEventType[] | null>(null)
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const value = url ?? settings?.webhook.url ?? ""
  const savedEvents = settings?.webhook.events ?? []
  const chosen = events ?? savedEvents
  const changed = value !== (settings?.webhook.url ?? "") || !sameEvents(chosen, savedEvents)

  const act = async (name: string, fn: () => Promise<AppSettings | void>, done?: string) => {
    setBusy(name)
    setActionError(null)
    setNote(null)
    try {
      const next = await fn()
      if (next) await reload() // Mutation envelopes never contain webhook credentials.
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
      // The events always go along: leaving them out would reset them to the defaults.
      const next = await api.putWebhook(app.slug, value.trim() || null, chosen)
      setUrl(null)
      setEvents(null)
      return next
    }, value.trim() ? t("saved") : t("webhook.removed"))
  }

  if (!settings) {
    return (
      <div>
        <Heading title={sectionLabel("webhook")} action={<DocsLink page="webhooks" />} />
        {error ? <Flash error={errorMessage(error)} /> : <div className="skeleton" style={{ height: 32, width: "60%" }} />}
      </div>
    )
  }

  const secret = settings.webhook.secret
  return (
    <div className="settings-stack">
      <Heading title={sectionLabel("webhook")} action={<DocsLink page="webhooks" />} />
      <form className="settings-stack" onSubmit={save}>
        <div className="field">
          <label className="field-label" htmlFor="hook-url">
            {t("webhook.payloadUrl")}
          </label>
          <div className="input">
            <input id="hook-url" type="url" value={value} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/bellhop" className="mono" />
          </div>
        </div>
        <div className="field">
          <span className="field-label">{t("webhook.events")}</span>
          <WebhookEvents value={chosen} onChange={setEvents} />
        </div>
        <div className="row">
          <Button type="submit" variant="primary" disabled={busy === "save" || !changed}>
            {busy === "save" ? tc("common.saving") : tc("common.save")}
          </Button>
          {changed && (
            <Button
              variant="invisible"
              onClick={() => {
                setUrl(null)
                setEvents(null)
              }}
            >
              {tc("common.discard")}
            </Button>
          )}
        </div>
      </form>

      <div className="field">
        <span className="field-label">{t("webhook.secret")}</span>
        <div className="row">
          <code className="secret-value mono">{reveal ? secret : "•".repeat(Math.min(32, secret.length || 32))}</code>
          <Button size="small" onClick={() => setReveal((r) => !r)}>
            {reveal ? t("webhook.hide") : t("webhook.reveal")}
          </Button>
          <CopyButton text={secret} />
          <Button
            size="small"
            variant="danger"
            disabled={busy === "rotate"}
            onClick={() => confirm(t("webhook.confirmRotate")) && act("rotate", () => api.rotateWebhook(app.slug), t("webhook.rotated"))}
          >
            {t("webhook.rotate")}
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
            }, t("webhook.testSent"))
          }
        >
          {t("webhook.sendTest")}
        </Button>
        {note && <span className="muted-text">{note}</span>}
      </div>
      <Flash error={actionError} />

      <div>
        <h2 className="section-title">{t("webhook.recent")}</h2>
        <section className="box">
          {settings.webhook.deliveries.length === 0 ? (
            <div className="box-empty">{t("webhook.noDeliveries")}</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("webhook.colEvent")}</th>
                    <th>{t("webhook.colStatus")}</th>
                    <th>{t("webhook.colResponse")}</th>
                    <th>{t("webhook.colAttempts")}</th>
                    <th>{t("webhook.colSent")}</th>
                    <th aria-label={t("webhook.colActions")} />
                  </tr>
                </thead>
                <tbody>
                  {settings.webhook.deliveries.map((d) => (
                    <tr key={d.id}>
                      <td className="mono">{d.event}</td>
                      <td>
                        <span className="delivery-status" data-status={d.status}>
                          {d.status === "delivered" ? t("webhook.delivered") : d.status === "failed" ? t("webhook.failed") : t("webhook.pending")}
                        </span>
                      </td>
                      <td className="mono">{d.response_status ?? "—"}</td>
                      <td className="mono">{d.attempts}</td>
                      <td>
                        <Time iso={d.created_at} />
                      </td>
                      <td className="delivery-actions">
                        <Redeliver slug={app.slug} id={d.id} onDone={() => setTimeout(() => reload().catch(() => {}), 1500)} />
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

/** Sends a delivery's payload again under a new delivery id. */
function Redeliver({ slug, id, onDone }: { slug: string; id: string; onDone: () => void }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle")
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (state !== "done") return
    const timer = setTimeout(() => setState("idle"), 2500)
    return () => clearTimeout(timer)
  }, [state])
  return (
    <>
      {state === "error" && error && <span className="field-error delivery-note">{error} </span>}
      <Button
        size="small"
        variant="invisible"
        disabled={state === "busy"}
        title={t("webhook.redeliverTitle")}
        onClick={async () => {
          setState("busy")
          setError(null)
          try {
            await api.redeliver(slug, id)
            setState("done")
            onDone()
          } catch (e) {
            setError(errorMessage(e))
            setState("error")
          }
        }}
      >
        {state === "busy" ? t("webhook.sending") : state === "done" ? t("webhook.sent") : t("webhook.redeliver")}
      </Button>
    </>
  )
}

/* Members */

const elevated = (role: Role) => role === "owner" || role === "admin"

/** The server's refusals, in plain words: 403 when an admin touches admins or owners, 409 for the last owner. */
function memberError(e: unknown) {
  if (e instanceof ApiFailure && e.code === "last_owner") return t("members.lastOwner")
  if (e instanceof ApiFailure && e.status === 403) return t("members.ownersOnly")
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
      <Heading title={sectionLabel("members")} />
      {admin ? <Invite app={app} owner={owner} /> : <p className="settings-readonly">{t("members.readOnly")}</p>}
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
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" aria-label={t("members.emailLabel")} autoComplete="off" />
        </div>
        <RoleSelect
          value={role}
          label={t("members.inviteRole")}
          options={teamRoles.map((r) => ({
            value: r,
            label: roleLabel[r],
            description: !owner && elevated(r) ? t("members.inviteOwnersOnly") : roleText[r],
            disabled: !owner && elevated(r),
          }))}
          onChange={setRole}
        />
        <Button type="submit" variant="primary" disabled={busy || !email.trim()}>
          {busy ? t("members.inviting") : t("members.invite")}
        </Button>
      </div>
      {error ? <p className="field-error">{error}</p> : <p className="member-invite-hint">{t("members.inviteHint")}</p>}
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
  const [, navigate] = useLocation()
  // You may always leave (DELETE …/members/me), except as the last owner; admins also manage others from the menu.
  const canLeave = you && !lastOwner
  const hasMenu = you ? canLeave : canManage

  const leave = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.leaveApp(app.slug)
      setData<App[]>(keys.apps, (apps) => apps?.filter((a) => a.id !== app.id))
      const href = homeUrl("/workspaces")
      if (isAbsolute(href)) window.location.assign(href)
      else navigate(href)
    } catch (e) {
      setError(memberError(e))
      setBusy(false)
    }
  }

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
        ? t("members.confirmLeave")
        : t("members.confirmRemove", { name: who })
      : confirm?.kind === "role"
        ? t("members.confirmRole", { role: roleWord(confirm.role) })
        : confirm?.kind === "transfer"
          ? t("members.confirmTransfer", { name: who })
          : ""

  return (
    <div className="box-row settings-row member-row">
      <UserAvatar user={member} size={32} />
      <div className="settings-row-main">
        <div className="template-row-name">
          {who}
          {you && <span className="member-you"> {t("members.you")}</span>}
        </div>
        <div className="issue-meta">
          {member.name ? member.email : ""}
          {!member.joined && `${member.name ? " · " : ""}${t("members.invited")}`}
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
      {confirm ? (
        <div className="agent-confirm-inline">
          <span className="agent-confirm-text">{confirmText}</span>
          <Button size="small" variant="invisible" onClick={() => setConfirm(null)} disabled={busy}>
            {tc("common.cancel")}
          </Button>
          <Button
            size="small"
            variant={confirm.kind === "transfer" ? "primary" : "danger"}
            disabled={busy}
            onClick={() =>
              confirm.kind === "remove"
                ? you
                  ? leave()
                  : act(() => api.removeMember(app.slug, member.id))
                : confirm.kind === "role"
                  ? act(() => api.patchMember(app.slug, member.id, confirm.role))
                  : act(() => api.transfer(app.slug, member.id), t("members.transferred", { name: who }))
            }
          >
            {confirm.kind === "remove" ? (you ? t("members.leave") : tc("common.remove")) : confirm.kind === "role" ? t("members.change") : t("members.makeOwner")}
          </Button>
        </div>
      ) : (
        <div className="settings-row-actions member-actions">
          {canManage ? (
            <RoleSelect
              value={member.role}
              label={t("roleFor", { name: who })}
              disabled={busy}
              options={teamRoles.map((r) => {
                const ownerOnly = !owner && elevated(r)
                const keepOwner = lastOwner && r !== "owner"
                return {
                  value: r,
                  label: roleLabel[r],
                  description: keepOwner ? t("members.needsOwner") : ownerOnly ? t("members.ownersGrant") : roleText[r],
                  disabled: ownerOnly || keepOwner,
                }
              })}
              onChange={change}
            />
          ) : (
            <RoleBadge role={member.role} />
          )}
          {hasMenu && (
            <Menu
              align="end"
              width={240}
              trigger={(p) => <Button iconOnly size="small" variant="ghost-muted" aria-label={t("moreFor", { name: who })} icon={<KebabIcon />} {...p} />}
            >
              {(close) => (
                <>
                  {canManage && owner && member.joined && member.role !== "owner" && (
                    <MenuItem
                      description={t("members.transferHint")}
                      onSelect={() => {
                        close()
                        setConfirm({ kind: "transfer" })
                      }}
                    >
                      {t("members.transfer")}
                    </MenuItem>
                  )}
                  {(you ? canLeave : canManage) && (
                    <MenuItem
                      danger
                      disabled={!you && lastOwner}
                      description={!you && lastOwner ? t("members.needsOwner") : undefined}
                      onSelect={() => {
                        close()
                        setConfirm({ kind: "remove" })
                      }}
                    >
                      {you ? t("members.leaveWorkspace") : tc("common.remove")}
                    </MenuItem>
                  )}
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
      <Heading title={sectionLabel("blocked")} />
      <p className="settings-lede">{t("blocked.lede")}</p>
      <section className="box">
        {!blocks && !error && <div className="box-row skeleton-row" />}
        {!!error && !blocks && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {blocks?.length === 0 && <div className="box-empty">{t("blocked.empty")}</div>}
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
          {actorName(block.actor)} <span className="agent-kind">{block.actor.type === "guest" ? t("blocked.guest") : t("blocked.account")}</span>
        </div>
        <div className="issue-meta">
          {tr("blocked.by", { name: actorName(block.by), time: <Time iso={block.created_at} /> })}
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
      <div className="settings-row-actions">
        <Button size="small" onClick={unblock} disabled={busy}>
          {busy ? t("blocked.unblocking") : t("blocked.unblock")}
        </Button>
      </div>
    </div>
  )
}
