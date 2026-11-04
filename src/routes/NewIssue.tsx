import { useEffect, useRef, useState, type FormEvent } from "react"
import { useLocation, useSearch } from "wouter"
import type { AppDetail, Attachment, ReportMetadata, SystemInfo, Template } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { setData, useResource } from "../lib/cache"
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
  return (
    <Page narrow>
      <h1 className="page-title">New issue</h1>
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

function IssueForm({ app, template, metadata: initialMetadata }: { app: AppDetail; template?: Template; metadata?: ReportMetadata }) {
  const [, navigate] = useLocation()
  const member = !!app.role
  const { data: me } = useMe()
  const guest = me && !me.user ? me.guest : null
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
  const submit = async (e?: FormEvent, askedName?: string) => {
    e?.preventDefault()
    if (!title.trim() || busy || submitting) return
    let guestName = askedName
    if (guest && !guest.name && !guestName) {
      const name = await ask({ anchor: submitButton.current, mode: "first", action: "Submit issue" })
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
        private: canChoose ? isPrivate : undefined,
        metadata_id: metadata?.id,
      })
      if (guestName) setGuestNameLocally(guestName)
      storeIssue(app.slug, issue)
      navigate(appPath(app.slug, `/issues/${issue.number}`))
    } catch (err) {
      setSubmitting(false)
      if (err instanceof ApiFailure && err.code === "name_required" && !askedName) {
        // The server has no name for this browser after all: ask now and submit again.
        setGuestNameLocally(null)
        const name = await ask({ anchor: submitButton.current, mode: "first", action: "Submit issue" })
        if (name) await submit(undefined, name)
      } else setError(errorMessage(err))
    }
  }

  return (
    <Page narrow>
      <h1 className="page-title">
        New issue
        {template && <span className="page-title-sub">{template.name}</span>}
      </h1>
      {metadata && metadata.matches.length > 0 && <MetadataMatches app={app} metadata={metadata} />}
      <form className="issue-form" onSubmit={submit}>
        <div className="field">
          <label className="field-label" htmlFor="issue-title">
            Title
          </label>
          <SimilarIssues slug={app.slug} title={title} exclude={metadata?.matches.map((m) => m.number)}>
            <div className="input" data-size="large">
              <input
                id="issue-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                autoFocus={!template?.title && !metadata?.title}
                required
                maxLength={256}
                autoComplete="off"
              />
            </div>
          </SimilarIssues>
        </div>
        <div className="field">
          <span className="field-label">Description</span>
          <Editor
            slug={app.slug}
            value={body}
            onChange={setBody}
            member={member}
            mentions={member}
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
          {(who === undefined || !who.user) && (
            <GuestLine
              name={who && !who.user ? who.name : null}
              placeholder={who === undefined}
              onChange={(anchor) => void ask({ anchor, mode: "edit" })}
            />
          )}
          <span className="spacer" />
          <AppLink slug={app.slug} href={appPath(app.slug)} className="btn" data-variant="invisible">
            Cancel
          </AppLink>
          <Button ref={submitButton} type="submit" variant="primary" disabled={!title.trim() || busy || submitting}>
            {submitting ? "Submitting…" : busy ? "Uploading…" : "Submit new issue"}
          </Button>
        </div>
      </form>
      {prompt}
    </Page>
  )
}
