import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react"
import type { AppDetail, AppSettings, ConnectedAgent } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { load, setData, useResource } from "../../lib/cache"
import { appPath, appUrl } from "../../lib/site"
import { ChevronDownIcon, XIcon } from "../icons"
import { AppIcon, Button } from "../primitives"
import { SiteLink } from "../SiteLink"
import { AgentSetup } from "./AgentSetup"
import { CopyField } from "./Snippet"
import { iconTypes, useIconUpload } from "./useIconUpload"
import "../../styles/onboarding.css"

type StepId = "icon" | "agent" | "team" | "share" | "try"

const flag = (slug: string, name: string) => `bellhop:setup:${slug}:${name}`
const read = (key: string) => {
  try {
    return localStorage.getItem(key) === "1"
  } catch {
    return false
  }
}
const write = (key: string) => {
  try {
    localStorage.setItem(key, "1")
  } catch {
    // Private mode: the flag lasts for this page only.
  }
}

/**
 * Whether the checklist knows yet if it will show. The list page waits for this (admins only, and only while the
 * checklist isn't dismissed) so the checklist never appears above an already painted toolbar.
 */
export function useSetupChecklistSettled(app: AppDetail) {
  const slug = app.slug
  const admin = app.role === "owner" || app.role === "admin"
  const dismissed = read(flag(slug, "dismissed")) || read(flag(slug, "complete"))
  const settings = useResource<AppSettings>(admin && !dismissed ? keys.settings(slug) : null, () => api.settings(slug), 10_000)
  const agents = useResource<ConnectedAgent[]>(admin && !dismissed ? keys.agents : null, api.agents, 10_000)
  return !admin || dismissed || ((!!settings.data || !!settings.error) && (!!agents.data || !!agents.error))
}

/**
 * "Get your workspace ready": five steps for a new workspace's admins, each done from real data. Hides when
 * dismissed, and on its own once everything is done (with a short "ready" moment if that happened just now).
 */
export function SetupChecklist({ app }: { app: AppDetail }) {
  const slug = app.slug
  const admin = app.role === "owner" || app.role === "admin"
  const [dismissed, setDismissed] = useState(() => read(flag(slug, "dismissed")) || read(flag(slug, "complete")))
  const [shared, setShared] = useState(() => read(flag(slug, "shared")))
  const settings = useResource<AppSettings>(admin && !dismissed ? keys.settings(slug) : null, () => api.settings(slug), 10_000)
  const agents = useResource<ConnectedAgent[]>(admin && !dismissed ? keys.agents : null, api.agents, 10_000)
  const ready = (!!settings.data || !!settings.error) && (!!agents.data || !!agents.error)

  const done: Record<StepId, boolean> = {
    icon: !!app.icon_url,
    agent: !!agents.data?.some((a) => a.apps.some((x) => x.slug === slug)),
    team: (settings.data?.members.length ?? 0) > 1,
    share: shared,
    try: app.counts.open + app.counts.closed > 0,
  }
  const order: StepId[] = ["icon", "agent", "team", "share", "try"]
  const count = order.filter((id) => done[id]).length
  const complete = count === order.length
  const firstOpen = order.find((id) => !done[id]) ?? null
  const [open, setOpen] = useState<StepId | null>(null)
  const current = open ?? firstOpen

  // When the open step gets done, move on to the next one.
  const signature = order.map((id) => (done[id] ? 1 : 0)).join("")
  const last = useRef(signature)
  useEffect(() => {
    if (last.current !== signature && open && done[open]) setOpen(null)
    last.current = signature
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])

  // An agent connects from a terminal elsewhere; check again every few seconds while that step is open.
  useEffect(() => {
    if (!ready || done.agent || current !== "agent") return
    const t = setInterval(() => void load(keys.agents, api.agents).catch(() => {}), 5000)
    return () => clearInterval(t)
  }, [ready, done.agent, current])

  // Everything done: a short success moment if it happened while this was on screen, then gone for good.
  const sawIncomplete = useRef(false)
  const [celebrating, setCelebrating] = useState(false)
  useEffect(() => {
    if (!ready) return
    if (!complete) {
      sawIncomplete.current = true
      return
    }
    write(flag(slug, "complete"))
    if (!sawIncomplete.current) return setDismissed(true)
    setCelebrating(true)
    const t = setTimeout(() => setDismissed(true), 4000)
    return () => clearTimeout(t)
  }, [ready, complete, slug])

  if (!admin || dismissed || !ready) return null
  // Already complete on arrival: the effect above hides it for good; don't flash it for a frame first.
  if (complete && !celebrating && !sawIncomplete.current) return null

  if (celebrating)
    return (
      <section className="setup setup-done" aria-live="polite">
        <span className="setup-done-mark" aria-hidden="true">
          <Check />
        </span>
        <div>
          <p className="setup-done-title">Your workspace is ready</p>
          <p className="setup-done-sub">Reports will show up here, and your agent will pick them up.</p>
        </div>
      </section>
    )

  const dismiss = () => {
    write(flag(slug, "dismissed"))
    setDismissed(true)
  }
  const markShared = () => {
    write(flag(slug, "shared"))
    setShared(true)
  }

  const steps: { id: StepId; title: string; summary?: string; body: ReactNode }[] = [
    { id: "icon", title: "Add an icon", summary: "Shown as the tab icon and logo", body: <IconStep app={app} /> },
    {
      id: "agent",
      title: "Connect your agent",
      summary: done.agent ? agents.data?.find((a) => a.apps.some((x) => x.slug === slug))?.client_name : "Answers issues as they come in",
      body: <AgentSetup />,
    },
    {
      id: "team",
      title: "Invite your team",
      summary: done.team ? `${settings.data!.members.length} people` : "They step in when the agent needs help",
      body: <InviteStep slug={slug} />,
    },
    {
      id: "share",
      title: "Share your support link",
      summary: "Where people report issues",
      body: (
        <div className="setup-body-stack">
          <CopyField value={appUrl(slug)} onCopied={markShared} />
          <p className="setup-hint">Link it from your app's Help menu or README.</p>
        </div>
      ),
    },
    {
      id: "try",
      title: "Try it",
      summary: done.try ? "Issues are coming in" : "See what reporters see",
      body: (
        <div className="setup-body-row">
          <p className="setup-hint">Open an issue the way a reporter would, then watch your agent pick it up.</p>
          <SiteLink href={appPath(slug, "/new")} className="btn" data-variant="default" data-size="small">
            File a test issue
          </SiteLink>
        </div>
      ),
    },
  ]

  return (
    <section className="setup" aria-labelledby={`setup-${slug}`}>
      <header className="setup-head">
        <h2 id={`setup-${slug}`} className="setup-title">
          Get your workspace ready
        </h2>
        <span className="setup-count">
          {count} of {order.length}
        </span>
        <span className="spacer" />
        <Button iconOnly size="small" variant="invisible" aria-label="Hide setup" title="Hide setup" icon={<XIcon size={14} />} onClick={dismiss} />
      </header>
      <div className="setup-progress" aria-hidden="true">
        {order.map((id) => (
          <span key={id} data-done={done[id] || undefined} />
        ))}
      </div>
      <ol className="setup-steps">
        {steps.map((step, i) => {
          const isOpen = current === step.id
          return (
            <li key={step.id} className="setup-step" data-done={done[step.id] || undefined} data-open={isOpen || undefined}>
              <button
                type="button"
                className="setup-step-head"
                aria-expanded={isOpen}
                aria-controls={`setup-${slug}-${step.id}`}
                onClick={() => setOpen(isOpen ? (order.find((id) => id !== step.id && !done[id]) ?? null) : step.id)}
              >
                <span className="setup-mark" aria-hidden="true">
                  {done[step.id] ? <Check /> : <span className="setup-mark-number">{i + 1}</span>}
                </span>
                <span className="setup-step-title">{step.title}</span>
                {step.summary && <span className="setup-step-summary">{step.summary}</span>}
                <span className="sr-only">{done[step.id] ? "(done)" : ""}</span>
                <ChevronDownIcon size={14} />
              </button>
              {isOpen && (
                <div className="setup-step-body" id={`setup-${slug}-${step.id}`}>
                  {step.body}
                </div>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

function Check() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="m3.5 8.5 3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconStep({ app }: { app: AppDetail }) {
  const input = useRef<HTMLInputElement>(null)
  const { upload, busy, error } = useIconUpload(app)
  return (
    <div className="setup-body-stack">
      <div className="setup-icon">
        <AppIcon src={app.icon_url} size={40} />
        <div className="setup-icon-main">
          <Button size="small" onClick={() => input.current?.click()} disabled={busy}>
            {busy ? "Uploading…" : app.icon_url ? "Replace icon" : "Upload icon"}
          </Button>
          <span className="setup-hint">PNG, JPEG or WebP up to 1 MB. Square works best.</span>
        </div>
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
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}

function InviteStep({ slug }: { slug: string }) {
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invited, setInvited] = useState<string[]>([])

  const invite = async (e: FormEvent) => {
    e.preventDefault()
    const address = email.trim()
    if (!address || busy) return
    setBusy(true)
    setError(null)
    try {
      setData(keys.settings(slug), await api.addMember(slug, address))
      setInvited((list) => [...list, address])
      setEmail("")
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="setup-body-stack" onSubmit={invite}>
      <div className="setup-invite">
        <div className="input">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            aria-label="Email to invite"
            autoComplete="off"
          />
        </div>
        <Button type="submit" size="small" disabled={!email.trim() || busy}>
          {busy ? "Inviting…" : "Invite"}
        </Button>
      </div>
      {error ? (
        <p className="field-error">{error}</p>
      ) : (
        <p className="setup-hint">
          {invited.length ? `Invited ${invited.join(", ")}. They join when they sign in with that email.` : "They join as members when they sign in with that email."}
        </p>
      )}
    </form>
  )
}
