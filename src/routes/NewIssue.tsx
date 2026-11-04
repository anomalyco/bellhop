import { useEffect, useRef, useState, type FormEvent } from "react"
import { useLocation, useSearch } from "wouter"
import type { AppDetail, Attachment, Me, ReportMetadata, SystemInfo, Template } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { invalidate, peek, setData, useResource } from "../lib/cache"
import { setGuestNameLocally, useWho } from "../lib/guest"
import { ensureHuman } from "../lib/human"
import { storeIssue } from "../lib/issues"
import { appPath } from "../lib/site"
import { collectSystemInfo } from "../lib/sysinfo"
import { Editor } from "../ui/Editor"
import { LockIcon, XIcon } from "../ui/icons"
import "../styles/onboarding.css"
import "../styles/moderation.css"
import { loadMarkdown } from "../ui/Markdown"
import { GuestLine, useNamePrompt } from "../ui/NamePrompt"
import { Button, Label } from "../ui/primitives"
import { AppLayout, Page, useMe } from "../ui/Shell"
import { AppLink } from "../ui/SiteLink"
import { MetadataBlocked, MetadataPanel, MetadataMatches } from "../ui/features/ReportMetadata"
import { SimilarIssues } from "../ui/features/SimilarIssues"
import { useT } from "../i18n/core"
import { tr, useT as useDeskT } from "../i18n/helpdesk"
import { deskOutsider } from "../lib/helpdesk"
import { EmailCode } from "../ui/helpdesk/EmailCode"
import { CheckIcon } from "../ui/icons"

export function NewIssue({ slug }: { slug: string }) {
  const t = useT()
  const td = useDeskT()
  const desk = deskOutsider(peek<AppDetail>(keys.app(slug)))
  useEffect(() => {
    void loadMarkdown()
  }, [])
  return (
    <AppLayout
      slug={slug}
      tab="issues"
      crumb={{ label: desk ? td("new.title") : t("new.title"), href: appPath(slug, "/new") }}
      loading={
        <Page narrow>
          <h1 className="page-title">{desk ? td("new.title") : t("new.title")}</h1>
          <div className="skeleton" style={{ width: "100%", height: 180 }} />
        </Page>
      }
    >
      {(app) => <NewIssueBody app={app} />}
    </AppLayout>
  )
}

function NewIssueBody({ app }: { app: AppDetail }) {
  const metadataId = new URLSearchParams(useSearch()).get("metadata")
  if (metadataId) return <WithMetadata app={app} id={metadataId} />
  return <Form app={app} />
}

/** Opened from an app with report metadata (/new?metadata=md_…): the form waits for it, so the suggested title and
 *  the attached panel arrive with the first paint instead of pushing the form around. */
function WithMetadata({ app, id }: { app: AppDetail; id: string }) {
  const { data, error } = useResource<ReportMetadata>(keys.metadata(app.slug, id), () => api.metadata(app.slug, id), 1_000)
  if (!data && error) return <MetadataBlocked app={app} error={error} />
  if (!data) return <FormLoading />
  if (data.attached_to) return <MetadataBlocked app={app} attachedTo={data.attached_to} />
  return <Form app={app} metadata={data} />
}

function FormLoading() {
  const t = useT()
  return (
    <Page narrow>
      <h1 className="page-title">{t("new.title")}</h1>
      <div className="skeleton" style={{ width: "100%", height: 180 }} />
    </Page>
  )
}

function Form({ app, metadata }: { app: AppDetail; metadata?: ReportMetadata }) {
  const search = useSearch()
  const chosen = new URLSearchParams(search).get("template")
  const templates = [...app.templates].sort((a, b) => a.position - b.position)

  // From an app's crash report, skip the picker: the bug-report kind of template (one that asks for system info).
  const fallback = (metadata && templates.find((t) => t.ask_system_info)) || (templates.length === 1 ? templates[0] : undefined)
  if (templates.length > 1 && chosen === null && !metadata) return <TemplatePicker app={app} templates={templates} />
  const template = chosen ? templates.find((t) => t.id === chosen) : fallback
  return <IssueForm key={template?.id ?? "blank"} app={app} template={template} metadata={metadata} />
}

function TemplatePicker({ app, templates }: { app: AppDetail; templates: Template[] }) {
  const t = useT()
  const td = useDeskT()
  return (
    <Page narrow>
      <h1 className="page-title">{deskOutsider(app) ? td("new.title") : t("new.title")}</h1>
      <section className="box">
        {templates.map((tpl) => (
          <div key={tpl.id} className="box-row template-row">
            <div className="template-row-main">
              <div className="template-row-name">{tpl.name}</div>
              {tpl.description && <div className="issue-meta">{tpl.description}</div>}
            </div>
            <AppLink slug={app.slug} href={appPath(app.slug, `/new?template=${encodeURIComponent(tpl.id)}`)} className="btn" data-variant="primary" data-size="small">
              {t("new.getStarted")}
            </AppLink>
          </div>
        ))}
      </section>
      <p className="template-blank">
        <AppLink slug={app.slug} href={appPath(app.slug, "/new?template=")}>{t("new.blank")}</AppLink>
      </p>
    </Page>
  )
}

function IssueForm({ app, template, metadata: initialMetadata }: { app: AppDetail; template?: Template; metadata?: ReportMetadata }) {
  const t = useT()
  const td = useDeskT()
  const [, navigate] = useLocation()
  const member = !!app.role
  const { data: me } = useMe()
  // A help desk's requester: every request is private, and (when the desk requires it) they confirm their email
  // right here, under their draft, before it's sent. The server's contact_required brings the step back too.
  const desk = deskOutsider(app)
  const [contactRequired, setContactRequired] = useState(false)
  const needsContact = desk && !me?.contact && (app.helpdesk?.require_verified_email || contactRequired)
  const verifyPanel = useRef<HTMLDivElement>(null)
  const guest = me && !me.user && !me.contact ? me.guest : null
  const who = useWho(me)
  const { ask, prompt } = useNamePrompt()
  const submitButton = useRef<HTMLButtonElement>(null)
  // Report metadata from an app: reviewed (items removed) here, and kept in the cache so a reload shows the same.
  const [metadata, setMetadata] = useState(initialMetadata)
  const [title, setTitle] = useState(initialMetadata?.title?.slice(0, 256) || template?.title || "")
  const [body, setBody] = useState(template?.body ?? "")
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [busy, setBusy] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The app's own specs come with the metadata; the browser's would only muddle them.
  const askInfo = !!template?.ask_system_info && !metadata
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

  // A guest without a name is asked for one here, in a prompt growing from Submit; the name goes with the issue.
  const submit = async (e?: FormEvent, askedName?: string, asContact = false) => {
    e?.preventDefault()
    if (!title.trim() || busy || submitting) return
    if (needsContact && !asContact) {
      setError(td("new.confirmFirst"))
      verifyPanel.current?.querySelector("input")?.focus()
      return
    }
    let guestName = askedName
    if (guest && !guest.name && !guestName && !asContact) {
      const name = await ask({ anchor: submitButton.current, mode: "first", action: t("new.submitAction") })
      if (!name) return
      guestName = name
    }
    setSubmitting(true)
    setError(null)
    try {
      await ensureHuman(member)
      const used = attachments.filter((a) => body.includes(a.url))
      const issue = await api.createIssue(app.slug, {
        title: title.trim(),
        body,
        template_id: template?.id,
        attachment_ids: used.length ? used.map((a) => a.id) : undefined,
        system_info: askInfo && sendInfo && info && Object.keys(info).length ? info : undefined,
        guest_name: guestName,
        private: canChoose && !desk ? isPrivate : undefined,
        metadata_id: metadata?.id,
      })
      if (guestName) setGuestNameLocally(guestName)
      storeIssue(app.slug, issue)
      navigate(appPath(app.slug, `/issues/${issue.number}`))
    } catch (err) {
      setSubmitting(false)
      if (err instanceof ApiFailure && err.code === "contact_required") {
        setContactRequired(true)
        setError(td("new.confirmFirst"))
      } else if (err instanceof ApiFailure && err.code === "name_required" && !askedName) {
        // The server has no name for this browser after all: ask now and submit again.
        setGuestNameLocally(null)
        const name = await ask({ anchor: submitButton.current, mode: "first", action: t("new.submitAction") })
        if (name) await submit(undefined, name)
      } else setError(errorMessage(err))
    }
  }

  return (
    <Page narrow>
      <h1 className="page-title">
        {desk ? td("new.title") : t("new.title")}
        {template && <span className="page-title-sub">{template.name}</span>}
      </h1>
      {metadata && metadata.matches.length > 0 && <MetadataMatches app={app} metadata={metadata} />}
      <form className="issue-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="issue-title">
            {desk ? td("new.subject") : t("field.title")}
          </label>
          <SimilarIssues slug={app.slug} title={title} exclude={metadata?.matches.map((m) => m.number)}>
            <div className="input" data-size="large">
              <input
                id="issue-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={desk ? td("new.subjectPlaceholder") : t("field.title")}
                autoFocus={!template?.title && !metadata?.title}
                required
                maxLength={256}
                autoComplete="off"
              />
            </div>
          </SimilarIssues>
        </div>
        <div className="field">
          <span className="field-label">{desk ? td("new.details") : t("field.description")}</span>
          <Editor
            slug={app.slug}
            value={body}
            onChange={setBody}
            member={member}
            mentions={member}
            onAttachment={(a) => setAttachments((list) => [...list, a])}
            onSubmit={submit}
            onBusyChange={setBusy}
            placeholder={desk ? td("new.detailsPlaceholder") : t("new.descriptionPlaceholder")}
            minHeight={220}
            label={desk ? td("new.details") : t("field.description")}
          />
        </div>

        {labels.length > 0 && (
          <div className="form-labels">
            <span className="muted-text">{t("new.labels")}</span>
            {labels.map((l) => (
              <Label key={l.id} name={l.name} color={l.color} />
            ))}
          </div>
        )}

        {metadata && (
          <MetadataPanel
            app={app}
            metadata={metadata}
            onChange={(next) => {
              setMetadata(next)
              setData(keys.metadata(app.slug, next.id), next)
            }}
          />
        )}

        {askInfo && (
          <div className="sysinfo-toggle">
            <label className="checkbox">
              <input type="checkbox" checked={sendInfo} onChange={(e) => setSendInfo(e.target.checked)} />
              {t("new.attachInfo")}
            </label>
            <button type="button" className="link-button" onClick={() => setShowInfo((s) => !s)} aria-expanded={showInfo}>
              {showInfo ? t("new.hideDetails") : t("new.showSent")}
            </button>
            {showInfo && sendInfo && (
              <div className="sysinfo-preview">
                {!info && <div className="muted-text">{t("new.collecting")}</div>}
                {info && Object.keys(info).length === 0 && <div className="muted-text">{t("diag.nothingLeft")}</div>}
                {info &&
                  Object.entries(info).map(([k, v]) => (
                    <div key={k} className="kv-row">
                      <span className="kv-key">{k}</span>
                      <span className="kv-value mono">{v}</span>
                      <button
                        type="button"
                        className="kv-remove"
                        aria-label={t("diag.dontSendItem", { name: k })}
                        title={t("diag.dontSend")}
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
            {showInfo && !sendInfo && <div className="muted-text">{t("new.infoOff")}</div>}
          </div>
        )}

        {desk ? (
          <p className="desk-private-note">
            <LockIcon size={12} /> {td("new.private")}
          </p>
        ) : canChoose ? (
          <label className="visibility issue-private" htmlFor="issue-private">
            <input id="issue-private" type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
            <span className="visibility-text">
              <span className="visibility-title">
                <LockIcon size={12} /> {t("new.private")}
              </span>
              <span className="visibility-hint">{member ? t("new.privateHintMember") : t("new.privateHintYou")}</span>
            </span>
          </label>
        ) : (
          visibility.default === "private" && (
            <p className="issue-private-note">
              <LockIcon size={12} /> {t("new.privateNote")}
            </p>
          )
        )}

        {needsContact && (
          <div className="desk-verify" ref={verifyPanel}>
            <div className="desk-verify-head">
              <p className="desk-verify-title">{td("new.verifyTitle")}</p>
              <p className="desk-verify-text">{td("new.verifyText")}</p>
            </div>
            <EmailCode<Me>
              id="new-request"
              start={(email) => api.contactStart(app.slug, email)}
              verify={(email, code) => api.contactVerify(app.slug, email, code)}
              verifyLabel={td("new.submit")}
              onVerified={async (next) => {
                invalidate(keys.lists(app.slug))
                setData<Me>(keys.me, next)
                setError(null)
                if (title.trim()) await submit(undefined, undefined, true)
              }}
            />
          </div>
        )}

        {error && <p className="flash" data-tone="danger">{error}</p>}
        <div className="form-actions">
          {desk && me?.contact ? (
            <span className="desk-verified">
              <CheckIcon size={14} />
              {tr("new.verifiedAs", { email: <strong>{me.contact.email || me.contact.name}</strong> })}
            </span>
          ) : (who === undefined || !who.user) && !needsContact && (
            <GuestLine
              name={who && !who.user ? who.name : null}
              placeholder={who === undefined}
              onChange={(anchor) => void ask({ anchor, mode: "edit" })}
            />
          )}
          <span className="spacer" />
          <AppLink slug={app.slug} href={appPath(app.slug)} className="btn" data-variant="invisible">
            {t("common.cancel")}
          </AppLink>
          <Button ref={submitButton} type="submit" variant="primary" disabled={!title.trim() || busy || submitting}>
            {submitting
              ? desk
                ? td("new.submitting")
                : t("new.submitting")
              : busy
                ? t("composer.uploading")
                : desk
                  ? td("new.submit")
                  : t("new.submit")}
          </Button>
        </div>
      </form>
      {prompt}
    </Page>
  )
}
