import { useEffect, useRef, useState, type FormEvent } from "react"
import { useLocation, useSearch } from "wouter"
import type { AppDetail, Attachment, Me, SystemInfo, Template } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { setData } from "../lib/cache"
import { ensureHuman } from "../lib/human"
import { storeIssue } from "../lib/issues"
import { appPath, signInHref } from "../lib/site"
import { collectSystemInfo } from "../lib/sysinfo"
import { Editor } from "../ui/Editor"
import { LockIcon, XIcon } from "../ui/icons"
import "../styles/onboarding.css"
import "../styles/moderation.css"
import { loadMarkdown } from "../ui/Markdown"
import { Button, Label } from "../ui/primitives"
import { AppLayout, Page, useMe } from "../ui/Shell"
import { AppLink, SiteLink } from "../ui/SiteLink"
import { validGuestName } from "./issue/Composer"

export function NewIssue({ slug }: { slug: string }) {
  useEffect(() => {
    void loadMarkdown()
  }, [])
  return (
    <AppLayout
      slug={slug}
      tab="issues"
      crumb={{ label: "New issue", href: appPath(slug, "/new") }}
      loading={
        <Page narrow>
          <h1 className="page-title">New issue</h1>
          <div className="skeleton" style={{ width: "100%", height: 180 }} />
        </Page>
      }
    >
      {(app) => <NewIssueBody app={app} />}
    </AppLayout>
  )
}

function NewIssueBody({ app }: { app: AppDetail }) {
  const search = useSearch()
  const chosen = new URLSearchParams(search).get("template")
  const templates = [...app.templates].sort((a, b) => a.position - b.position)

  if (templates.length > 1 && chosen === null) return <TemplatePicker app={app} templates={templates} />
  const template = chosen ? templates.find((t) => t.id === chosen) : templates.length === 1 ? templates[0] : undefined
  return <IssueForm key={template?.id ?? "blank"} app={app} template={template} />
}

function TemplatePicker({ app, templates }: { app: AppDetail; templates: Template[] }) {
  return (
    <Page narrow>
      <h1 className="page-title">New issue</h1>
      <section className="box">
        {templates.map((t) => (
          <div key={t.id} className="box-row template-row">
            <div className="template-row-main">
              <div className="template-row-name">{t.name}</div>
              {t.description && <div className="issue-meta">{t.description}</div>}
            </div>
            <AppLink slug={app.slug} href={appPath(app.slug, `/new?template=${encodeURIComponent(t.id)}`)} className="btn" data-variant="primary" data-size="small">
              Get started
            </AppLink>
          </div>
        ))}
      </section>
      <p className="template-blank">
        <AppLink slug={app.slug} href={appPath(app.slug, "/new?template=")}>Open a blank issue</AppLink>
      </p>
    </Page>
  )
}

function IssueForm({ app, template }: { app: AppDetail; template?: Template }) {
  const [, navigate] = useLocation()
  const member = !!app.role
  const { data: me } = useMe()
  const guest = me && !me.user ? me.guest : null
  const [guestName, setGuestName] = useState<string | null>(null)
  const name = guestName ?? guest?.name ?? ""
  const [nameError, setNameError] = useState<string | null>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(template?.title ?? "")
  const [body, setBody] = useState(template?.body ?? "")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const askInfo = !!template?.ask_system_info
  const [sendInfo, setSendInfo] = useState(askInfo)
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [showInfo, setShowInfo] = useState(false)
  // Whether it's private: the workspace's default, and the reporter's choice when it lets them (the team always may).
  const visibility = app.visibility ?? { default: "public", reporter_can_choose: false }
  const canChoose = member || visibility.reporter_can_choose
  const [isPrivate, setPrivate] = useState(visibility.default === "private")

  useEffect(() => {
    if (askInfo) collectSystemInfo().then(setInfo)
  }, [askInfo])

  const labels = template ? app.labels.filter((l) => template.label_ids.includes(l.id)) : []

  const submit = async (e?: FormEvent) => {
    e?.preventDefault()
    if (!title.trim() || busy || submitting) return
    if (guest && !validGuestName(name)) {
      setNameError(name.trim() ? "Up to 40 characters." : "Add your name to post.")
      nameInput.current?.focus()
      return
    }
    setSubmitting(true)
    setError(null)
    setNameError(null)
    try {
      await ensureHuman(member)
      const used = attachments.filter((a) => body.includes(a.url))
      const issue = await api.createIssue(app.slug, {
        title: title.trim(),
        body,
        template_id: template?.id,
        attachment_ids: used.length ? used.map((a) => a.id) : undefined,
        system_info: askInfo && sendInfo && info && Object.keys(info).length ? info : undefined,
        guest_name: guest ? name.trim() : undefined,
        private: canChoose ? isPrivate : undefined,
      })
      if (guest) setData<Me>(keys.me, (m) => (m ? { ...m, guest: { ...m.guest, name: name.trim() } } : m))
      storeIssue(app.slug, issue)
      navigate(appPath(app.slug, `/issues/${issue.number}`))
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "name_required") {
        setNameError("Add your name to post.")
        nameInput.current?.focus()
      } else setError(errorMessage(err))
      setSubmitting(false)
    }
  }

  return (
    <Page narrow>
      <h1 className="page-title">
        New issue
        {template && <span className="page-title-sub">{template.name}</span>}
      </h1>
      <form className="issue-form" onSubmit={submit}>
        {guest && (
          <div className="field guest-name-field">
            <div className="field-label-row">
              <label className="field-label" htmlFor="guest-name">
                Your name
              </label>
              <SiteLink href={signInHref()} className="field-label-aside">
                Sign in instead
              </SiteLink>
            </div>
            <div className="input" data-size="large" data-invalid={nameError ? "" : undefined}>
              <input
                ref={nameInput}
                id="guest-name"
                value={name}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="Shown with what you post"
                autoComplete="name"
                maxLength={40}
                aria-invalid={!!nameError}
                aria-describedby={nameError ? "guest-name-error" : undefined}
                autoFocus={!guest.name}
              />
            </div>
            {nameError && (
              <p id="guest-name-error" className="field-error">
                {nameError}
              </p>
            )}
          </div>
        )}
        <div className="field">
          <label className="field-label" htmlFor="issue-title">
            Title
          </label>
          <div className="input" data-size="large">
            <input
              id="issue-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Title"
              autoFocus={!template?.title && !(guest && !guest.name)}
              required
              maxLength={256}
            />
          </div>
        </div>
        <div className="field">
          <span className="field-label">Description</span>
          <Editor
            slug={app.slug}
            value={body}
            onChange={setBody}
            member={member}
            onAttachment={(a) => setAttachments((list) => [...list, a])}
            onSubmit={submit}
            onBusyChange={setBusy}
            placeholder="Describe what happened, what you expected and how to reproduce it. Paste or drop screenshots and videos."
            minHeight={220}
            label="Description"
          />
        </div>

        {labels.length > 0 && (
          <div className="form-labels">
            <span className="muted-text">Labels</span>
            {labels.map((l) => (
              <Label key={l.id} name={l.name} color={l.color} />
            ))}
          </div>
        )}

        {askInfo && (
          <div className="sysinfo-toggle">
            <label className="checkbox">
              <input type="checkbox" checked={sendInfo} onChange={(e) => setSendInfo(e.target.checked)} />
              Attach system info
            </label>
            <button type="button" className="link-button" onClick={() => setShowInfo((s) => !s)} aria-expanded={showInfo}>
              {showInfo ? "Hide details" : "Show what's sent"}
            </button>
            {showInfo && sendInfo && (
              <div className="sysinfo-preview">
                {!info && <div className="muted-text">Collecting…</div>}
                {info && Object.keys(info).length === 0 && <div className="muted-text">Nothing left to send.</div>}
                {info &&
                  Object.entries(info).map(([k, v]) => (
                    <div key={k} className="kv-row">
                      <span className="kv-key">{k}</span>
                      <span className="kv-value mono">{v}</span>
                      <button
                        type="button"
                        className="kv-remove"
                        aria-label={`Don't send ${k}`}
                        title="Don't send"
                        onClick={() =>
                          setInfo((i) => {
                            if (!i) return i
                            const { [k]: _, ...rest } = i
                            return rest
                          })
                        }
                      >
                        <XIcon size={12} />
                      </button>
                    </div>
                  ))}
              </div>
            )}
            {showInfo && !sendInfo && <div className="muted-text">System info won't be attached.</div>}
          </div>
        )}

        {canChoose ? (
          <label className="visibility issue-private" htmlFor="issue-private">
            <input id="issue-private" type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
            <span className="visibility-text">
              <span className="visibility-title">
                <LockIcon size={12} /> Private
              </span>
              <span className="visibility-hint">Only the team and {member ? "the reporter" : "you"} can see it. Otherwise anyone with the link can.</span>
            </span>
          </label>
        ) : (
          visibility.default === "private" && (
            <p className="issue-private-note">
              <LockIcon size={12} /> Issues here are private: only the team and you can see them.
            </p>
          )
        )}

        {error && <p className="flash" data-tone="danger">{error}</p>}
        <div className="form-actions">
          <AppLink slug={app.slug} href={appPath(app.slug)} className="btn" data-variant="invisible">
            Cancel
          </AppLink>
          <Button type="submit" variant="primary" disabled={!title.trim() || busy || submitting}>
            {submitting ? "Submitting…" : busy ? "Uploading…" : "Submit new issue"}
          </Button>
        </div>
      </form>
    </Page>
  )
}
