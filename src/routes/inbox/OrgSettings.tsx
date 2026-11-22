import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Link, useLocation, useSearch } from "wouter"
import type { App, AppDetail, Member, OrgDetail, Role } from "../../../shared/api"
import { t as tc } from "../../i18n/core"
import { t as ti, tr, useT } from "../../i18n/inbox"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { invalidate, load, setData, useResource } from "../../lib/cache"
import { atLeast, roleLabel, roleText, teamRoles } from "../../lib/roles"
import { appLabel, appPath, homeUrl, isAbsolute, orgPath } from "../../lib/site"
import { UserAvatar } from "../../ui/Actor"
import { KebabIcon, PlusIcon } from "../../ui/icons"
import { Menu, MenuItem } from "../../ui/Menu"
import { AppIcon, Button } from "../../ui/primitives"
import { RoleSelect } from "../../ui/roles/RoleSelect"
import { ErrorPage, Header, Page, useMe } from "../../ui/Shell"
import { AppLink, SiteLink } from "../../ui/SiteLink"
import { CopyButton } from "../../ui/onboarding/Snippet"
import { SignIn } from "../home/SignIn"
import { SlugField, slugProblem, slugify } from "./CreateOrg"
import "../../styles/settings.css"
import "../../styles/agents.css"
import "../../styles/inbox.css"

type Section = "general" | "members" | "apps"
const sections: Section[] = ["general", "members", "apps"]

/** /o/<org>/settings[/members|/apps]: the org's name and icon, its members, and its apps (create, move in). */
export function OrgSettingsPage({ org, section }: { org: string; section?: string }) {
  const { data: me } = useMe()
  if (!me) return <Header />
  if (!me.user) return <SignIn back={window.location.pathname + window.location.search} />
  return <OrgSettings org={org} section={sections.includes(section as Section) ? (section as Section) : "general"} />
}

function OrgSettings({ org, section }: { org: string; section: Section }) {
  const t = useT()
  const { data: detail, error } = useResource<OrgDetail>(keys.org(org), () => api.org(org), 10_000)
  if (!detail)
    return (
      <>
        <Header org={{ slug: org, name: "", icon_url: null, role: "member" }} orgTab="settings" />
        {error ? <ErrorPage error={error} /> : null}
      </>
    )
  return (
    <>
      <Header org={detail} orgTab="settings" />
      <Page>
        <div className="settings">
          <nav className="settings-nav" aria-label={t("settings.title")}>
            {sections.map((s) => (
              <Link key={s} href={orgPath(org, s === "general" ? "/settings" : `/settings/${s}`)} aria-current={section === s ? "page" : undefined}>
                {t(`settings.${s}`)}
              </Link>
            ))}
          </nav>
          <div className="settings-main">
            {section === "general" && <General org={detail} />}
            {section === "members" && <Members org={detail} />}
            {section === "apps" && <Apps org={detail} />}
          </div>
        </div>
      </Page>
    </>
  )
}

const isAdmin = (o: OrgDetail) => atLeast(o.role, "admin")

function Heading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="settings-heading">
      <h1>{title}</h1>
      {children}
    </div>
  )
}

function General({ org }: { org: OrgDetail }) {
  const t = useT()
  const admin = isAdmin(org)
  const [name, setName] = useState(org.name)
  const [busy, setBusy] = useState<"name" | "icon" | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  useEffect(() => setName(org.name), [org.name])
  const store = (next: OrgDetail) => {
    setData(keys.org(org.slug), next)
    invalidate(keys.orgs)
  }
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || name.trim() === org.name) return
    setBusy("name")
    setError(null)
    setNote(null)
    try {
      store(await api.patchOrg(org.slug, { name: name.trim() }))
      setNote(t("settings.saved"))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }
  const upload = async (f: File | undefined) => {
    if (!f) return
    setBusy("icon")
    setError(null)
    try {
      store(await api.putOrgIcon(org.slug, f))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(null)
      if (file.current) file.current.value = ""
    }
  }
  return (
    <div>
      <Heading title={t("settings.general")} />
      {!admin && <p className="settings-readonly">{t("settings.adminOnly")}</p>}
      <form className="settings-form" onSubmit={save}>
        <div className="field">
          <span className="field-label">{t("settings.icon")}</span>
          <div className="org-icon-row">
            <AppIcon src={org.icon_url} size={40} name={org.name} />
            {admin && (
              <>
                <Button size="small" onClick={() => file.current?.click()} disabled={busy === "icon"}>
                  {t("settings.uploadIcon")}
                </Button>
                <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void upload(e.currentTarget.files?.[0])} />
                <span className="create-note">{t("settings.iconHint")}</span>
              </>
            )}
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="org-name">
            {t("settings.name")}
          </label>
          <div className="input">
            <input id="org-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!admin} autoComplete="off" />
          </div>
        </div>
        <div className="field">
          <span className="field-label">{t("settings.address")}</span>
          <p className="settings-value mono">{new URL(orgPath(org.slug), window.location.href).href.replace(/^https?:\/\//, "")}</p>
        </div>
        {error && <p className="field-error">{error}</p>}
        {admin && (
          <div className="settings-actions">
            <Button type="submit" variant="primary" disabled={busy === "name" || !name.trim() || name.trim() === org.name}>
              {busy === "name" ? t("settings.saving") : t("settings.save")}
            </Button>
            {note && <span className="settings-note" aria-live="polite">{note}</span>}
          </div>
        )}
      </form>
    </div>
  )
}

/** The same rules as a workspace's members: only owners grant admin and owner; the last owner stays. */
function memberError(e: unknown) {
  if (e instanceof ApiFailure && e.code === "last_owner") return ti("members.lastOwner")
  if (e instanceof ApiFailure && e.status === 403) return ti("members.ownersOnly")
  return errorMessage(e)
}

function Members({ org }: { org: OrgDetail }) {
  const t = useT()
  const { data: me } = useMe()
  const admin = isAdmin(org)
  const owner = org.role === "owner"
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>("member")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [, navigate] = useLocation()
  const members = [...org.members].sort((a, b) => teamRoles.indexOf(a.role) - teamRoles.indexOf(b.role) || (a.name ?? a.email).localeCompare(b.name ?? b.email))
  const joinedOwners = members.filter((m) => m.role === "owner" && m.joined).length
  const invite = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      setData(keys.org(org.slug), await api.addOrgMember(org.slug, email.trim(), role))
      setEmail("")
      setRole("member")
    } catch (err) {
      setError(memberError(err))
    } finally {
      setBusy(false)
    }
  }
  const leave = async () => {
    setBusy(true)
    try {
      await api.leaveOrg(org.slug)
      invalidate(keys.orgs)
      const href = homeUrl("/workspaces")
      if (isAbsolute(href)) window.location.assign(href)
      else navigate(href)
    } catch (err) {
      setError(memberError(err))
      setBusy(false)
    }
  }
  return (
    <div>
      <Heading title={t("settings.members")} />
      <p className="settings-lede">{t("members.lede")}</p>
      {admin && (
        <form className="member-invite" onSubmit={invite}>
          <div className="member-invite-row">
            <div className="input">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("members.emailPlaceholder")} aria-label={t("members.email")} autoComplete="off" />
            </div>
            <RoleSelect
              value={role}
              label={t("members.role")}
              options={teamRoles.map((r) => ({ value: r, label: roleLabel[r], description: roleText[r], disabled: !owner && (r === "owner" || r === "admin") }))}
              onChange={setRole}
            />
            <Button type="submit" variant="primary" disabled={busy || !email.trim()}>
              {busy ? t("members.inviting") : t("members.invite")}
            </Button>
          </div>
        </form>
      )}
      {error && <p className="field-error">{error}</p>}
      {admin ? (
        <section className="box">
          {members.map((m) => (
            <OrgMemberRow
              key={m.id}
              org={org}
              member={m}
              you={me?.user?.id === m.id}
              canManage={admin && (owner || (m.role !== "owner" && m.role !== "admin"))}
              owner={owner}
              lastOwner={m.role === "owner" && m.joined && joinedOwners <= 1}
            />
          ))}
        </section>
      ) : (
        <p className="settings-readonly">{t("members.adminOnly")}</p>
      )}
      {!(owner && joinedOwners <= 1) && (
        <div className="org-leave">
          {leaving ? (
            <div className="org-confirm" role="group">
              <span>{t("members.leaveConfirm", { org: org.name })}</span>
              <Button size="small" variant="invisible" onClick={() => setLeaving(false)} disabled={busy} autoFocus>
                {t("members.cancel")}
              </Button>
              <Button size="small" variant="danger" onClick={() => void leave()} disabled={busy}>
                {t("members.leave", { org: org.name })}
              </Button>
            </div>
          ) : (
            <Button size="small" variant="invisible" onClick={() => setLeaving(true)}>
              {t("members.leave", { org: org.name })}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function OrgMemberRow({ org, member, you, canManage, owner, lastOwner }: { org: OrgDetail; member: Member; you: boolean; canManage: boolean; owner: boolean; lastOwner: boolean }) {
  const t = useT()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const who = member.name ?? member.email
  const act = async (fn: () => Promise<OrgDetail>) => {
    setBusy(true)
    setError(null)
    try {
      setData(keys.org(org.slug), await fn())
      setConfirm(false)
    } catch (e) {
      setError(memberError(e))
    } finally {
      setBusy(false)
    }
  }
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
        {confirm && (
          <div className="org-confirm" role="group">
            <span>{t("members.removeConfirm", { name: who, org: org.name })}</span>
            <Button size="small" variant="invisible" onClick={() => setConfirm(false)} disabled={busy} autoFocus>
              {t("members.cancel")}
            </Button>
            <Button size="small" variant="danger" onClick={() => void act(() => api.removeOrgMember(org.slug, member.id))} disabled={busy}>
              {t("members.remove")}
            </Button>
          </div>
        )}
        {error && <p className="field-error">{error}</p>}
      </div>
      <div className="settings-row-actions">
        {canManage && !you && !lastOwner ? (
          <>
            <RoleSelect
              value={member.role}
              label={`${t("members.role")}: ${who}`}
              options={teamRoles.map((r) => ({ value: r, label: roleLabel[r], description: roleText[r], disabled: !owner && (r === "owner" || r === "admin") }))}
              onChange={(r) => void act(() => api.patchOrgMember(org.slug, member.id, r))}
              disabled={busy}
            />
            {!confirm && (
              <Button size="small" variant="invisible" onClick={() => setConfirm(true)}>
                {t("members.remove")}
              </Button>
            )}
          </>
        ) : (
          <span className="role-badge">{roleLabel[member.role]}</span>
        )}
      </div>
    </div>
  )
}

function Apps({ org }: { org: OrgDetail }) {
  const t = useT()
  const admin = isAdmin(org)
  const search = useSearch()
  const [creating, setCreating] = useState(() => new URLSearchParams(search).get("new") === "1")
  const [made, setMade] = useState<{ app: AppDetail; key: string } | null>(null)
  const [note, setNote] = useState<string | null>(null)
  return (
    <div>
      <Heading title={t("settings.apps")}>
        {admin && !creating && !made && (
          <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setCreating(true)}>
            {t("apps.new")}
          </Button>
        )}
      </Heading>
      <p className="settings-lede">{t("apps.lede")}</p>
      {made && <NewKey app={made.app} reportKey={made.key} onDone={() => setMade(null)} />}
      {creating && (
        <NewApp
          org={org}
          onCancel={() => setCreating(false)}
          onCreated={(app, key) => {
            setCreating(false)
            if (key) setMade({ app, key })
          }}
        />
      )}
      {note && <p className="settings-note">{note}</p>}
      <section className="box">
        {org.apps.length === 0 && <div className="box-empty">{t("apps.none")}</div>}
        {org.apps.map((a) => (
          <OrgAppRow key={a.id} org={org} app={a} onNote={setNote} />
        ))}
      </section>
      {admin && <MoveApp org={org} />}
    </div>
  )
}

/**
 * One of the org's apps. Taking it out of the org (PUT /api/apps/:slug/org { org: null }) is for org owners only:
 * admins see the item disabled with the reason.
 */
function OrgAppRow({ org, app, onNote }: { org: OrgDetail; app: OrgDetail["apps"][number]; onNote: (note: string | null) => void }) {
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const owner = org.role === "owner"
  const takeOut = async () => {
    setBusy(true)
    setError(null)
    onNote(null)
    try {
      const moved = await api.moveApp(app.slug, null)
      setData(keys.app(moved.slug), moved)
      setData<OrgDetail>(keys.org(org.slug), (o) => (o ? { ...o, apps: o.apps.filter((x) => x.id !== app.id) } : o))
      invalidate(keys.org(org.slug))
      // Now outside every org: it shows up in "Move an existing app here" right away
      invalidate(keys.apps)
      void load(keys.apps, api.apps).catch(() => {})
      onNote(t("apps.takenOut", { app: app.name, org: org.name }))
    } catch (e) {
      setError(e instanceof ApiFailure && e.status === 403 ? t("apps.takeOutOwners") : errorMessage(e))
      setBusy(false)
      setConfirming(false)
    }
  }
  return (
    <div className="box-row settings-row org-app-row">
      <AppIcon src={app.icon_url} size={28} name={app.name} />
      <div className="settings-row-main">
        <div className="template-row-name">{app.name}</div>
        <div className="issue-meta">
          <span className="mono">{appLabel(app.slug)}</span> · {tc("state.open")} {app.counts.open}
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
      {confirming ? (
        <div className="agent-confirm-inline">
          <span className="agent-confirm-text">{t("apps.takeOutConfirm", { app: app.name, org: org.name })}</span>
          <Button size="small" variant="invisible" onClick={() => setConfirming(false)} disabled={busy}>
            {tc("common.cancel")}
          </Button>
          <Button size="small" variant="danger" onClick={() => void takeOut()} disabled={busy}>
            {busy ? t("apps.takingOut") : t("apps.takeOutButton")}
          </Button>
        </div>
      ) : (
        <div className="settings-row-actions">
          <SiteLink href={orgPath(org.slug, `/${app.slug}`)} className="btn" data-variant="default" data-size="small">
            {t("apps.openApp", { app: app.name })}
          </SiteLink>
          <AppLink slug={app.slug} href={appPath(app.slug, "/settings")} className="btn" data-variant="invisible" data-size="small">
            {t("apps.appSettings")}
          </AppLink>
          {isAdmin(org) && (
            <Menu
              align="end"
              width={260}
              trigger={(p) => <Button iconOnly size="small" variant="ghost-muted" aria-label={t("apps.more", { app: app.name })} icon={<KebabIcon />} {...p} />}
            >
              {(close) => (
                <MenuItem
                  danger
                  disabled={!owner}
                  description={owner ? t("apps.takeOutHint") : t("apps.takeOutOwners")}
                  onSelect={() => {
                    close()
                    setConfirming(true)
                  }}
                >
                  {t("apps.takeOut", { org: org.name })}
                </MenuItem>
              )}
            </Menu>
          )}
        </div>
      )}
    </div>
  )
}

function NewApp({ org, onCancel, onCreated }: { org: OrgDetail; onCancel: () => void; onCreated: (app: AppDetail, key: string | null) => void }) {
  const t = useT()
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [edited, setEdited] = useState(false)
  const [kind, setKind] = useState<"feedback" | "tracker">("feedback")
  const [busy, setBusy] = useState(false)
  const [strict, setStrict] = useState(false)
  const [taken, setTaken] = useState<string | null>(null)
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
      const { report_key, ...app } = await api.createOrgApp(org.slug, { name: name.trim(), slug: address, kind })
      setData(keys.app(app.slug), app)
      setData<OrgDetail>(keys.org(org.slug), (o) => (o ? { ...o, apps: [...o.apps.filter((a) => a.id !== app.id), app] } : o))
      invalidate(keys.org(org.slug))
      invalidate(keys.apps)
      onCreated(app as AppDetail, report_key ?? null)
    } catch (err) {
      if (err instanceof ApiFailure && err.status === 409) setTaken(address)
      else setError(errorMessage(err))
      setBusy(false)
    }
  }
  return (
    <form className="org-new-app" onSubmit={submit} noValidate>
      <div className="field">
        <label className="field-label" htmlFor="app-name">
          {t("apps.name")}
        </label>
        <div className="input">
          <input id="app-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("apps.namePlaceholder")} maxLength={80} autoFocus autoComplete="off" />
        </div>
      </div>
      <SlugField
        id="app-slug"
        label={t("apps.slug")}
        value={address}
        problem={problem}
        onChange={(v) => {
          setEdited(true)
          setSlug(v)
        }}
        onBlur={() => address && setStrict(true)}
        app
      />
      <fieldset className="org-kinds">
        <legend className="field-label">{t("apps.kind")}</legend>
        {(["feedback", "tracker"] as const).map((k) => (
          <label key={k} className="org-kind" data-current={kind === k || undefined}>
            <input type="radio" name="app-kind" checked={kind === k} onChange={() => setKind(k)} />
            <span className="org-kind-text">
              <span className="org-kind-title">{t(`apps.${k}`)}</span>
              <span className="org-kind-hint">{t(`apps.${k}Text`)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      {error && <p className="field-error">{error}</p>}
      <div className="settings-actions">
        <Button variant="invisible" onClick={onCancel} disabled={busy}>
          {t("apps.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t("apps.creating") : t("apps.create")}
        </Button>
      </div>
    </form>
  )
}

/** The new app's report key, once: copy it, where it goes, and the docs. */
function NewKey({ app, reportKey, onDone }: { app: AppDetail; reportKey: string; onDone: () => void }) {
  const t = useT()
  const url = new URL(`/api/apps/${app.slug}/feedback`, new URL(homeUrl("/"), window.location.href)).href
  return (
    <div className="org-key" role="status">
      <p className="org-key-title">{t("apps.keyTitle", { app: app.name })}</p>
      <p className="create-note">{t("apps.keyText")}</p>
      <div className="org-key-row">
        <code className="org-key-value mono">{reportKey}</code>
        <CopyButton text={reportKey} label={t("apps.copy")} />
      </div>
      <p className="create-note">{tr("apps.install", { url: <code className="mono">{url}</code> })}</p>
      <p className="create-note">{t("apps.keyFeedbackOn")}</p>
      <div className="settings-actions">
        <a href={homeUrl("/docs/feedback")} className="btn" data-variant="default" data-size="small">
          {t("apps.docs")}
        </a>
        <Button size="small" variant="primary" onClick={onDone}>
          {t("apps.done")}
        </Button>
      </div>
    </div>
  )
}

/** Apps the account owns that aren't in an org yet, moved in with PUT /api/apps/:slug/org. */
function MoveApp({ org }: { org: OrgDetail }) {
  const t = useT()
  const { data: apps } = useResource<App[]>(keys.apps, api.apps, 10_000)
  const mine = (apps ?? []).filter((a) => a.role === "owner" && !a.org)
  const [slug, setSlug] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const move = async (e: FormEvent) => {
    e.preventDefault()
    if (!slug || busy) return
    setBusy(true)
    setError(null)
    try {
      const app = await api.moveApp(slug, org.slug)
      setData(keys.app(app.slug), app)
      invalidate(keys.org(org.slug))
      invalidate(keys.apps)
      setData<OrgDetail>(keys.org(org.slug), (o) => (o ? { ...o, apps: [...o.apps.filter((a) => a.id !== app.id), app] } : o))
      setSlug("")
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="org-move">
      <h2 className="section-title">{t("apps.move")}</h2>
      <p className="settings-lede">{t("apps.moveText")}</p>
      {apps && mine.length === 0 ? (
        <p className="muted-text">{t("apps.moveNone")}</p>
      ) : (
        <form className="org-move-row" onSubmit={move}>
          <select className="select" value={slug} onChange={(e) => setSlug(e.target.value)} aria-label={t("apps.moveChoose")}>
            <option value="">{t("apps.moveChoose")}…</option>
            {mine.map((a) => (
              <option key={a.slug} value={a.slug}>
                {a.name} ({appLabel(a.slug)})
              </option>
            ))}
          </select>
          <Button type="submit" disabled={!slug || busy}>
            {busy ? t("apps.moving") : t("apps.moveButton", { org: org.name })}
          </Button>
        </form>
      )}
      {error && <p className="field-error">{error}</p>}
    </section>
  )
}
