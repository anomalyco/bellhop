import { useEffect, useState, type FormEvent } from "react"
import type { AppDetail, ImportJob } from "../../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { load, setData, useResource } from "../../lib/cache"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { Button, Dots } from "../../ui/primitives"
import { AppLink } from "../../ui/SiteLink"
import "../../styles/data.css"

/** The last import started from this browser, so its progress survives a reload (the API reads one job by id). */
const jobKey = (slug: string) => `bh_import:${slug}`
const rememberJob = (slug: string, id: string | null) => {
  try {
    if (id) localStorage.setItem(jobKey(slug), id)
    else localStorage.removeItem(jobKey(slug))
  } catch {
    // Storage disabled: progress shows until the page is left.
  }
}
const recalledJob = (slug: string) => {
  try {
    return localStorage.getItem(jobKey(slug))
  } catch {
    return null
  }
}

/** "owner/name" from what people paste: the name itself, or a github.com URL (with .git or a trailing path). */
export function repoName(input: string) {
  const v = input.trim().replace(/\.git$/, "")
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(v)
  return (url ? `${url[1]}/${url[2]}` : v).toLowerCase()
}
const validRepo = (r: string) => /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(r) && ![".", ".."].includes(r.split("/")[1]!)

/** Settings → Data (admins): download the workspace as NDJSON, and import issues from a GitHub repository. */
export function Data({ app }: { app: AppDetail }) {
  return (
    <div className="data">
      <div className="settings-heading">
        <h1>Data</h1>
      </div>
      <Export app={app} />
      <GitHubImport app={app} />
    </div>
  )
}

function Export({ app }: { app: AppDetail }) {
  return (
    <section className="data-section" aria-labelledby="export-title">
      <h2 id="export-title" className="data-title">
        Export
      </h2>
      <p className="data-text">
        Everything in this workspace as one file, a JSON object per line: settings, labels, templates, tiers, members, then each issue with its
        comments (internal notes included), events, votes and file links. Secrets never are: no webhook secret, keys or tokens.
      </p>
      <div className="data-actions">
        <a className="btn" data-variant="default" href={api.exportUrl(app.slug)} download={`${app.slug}.ndjson`}>
          <DownloadIcon />
          Download workspace (NDJSON)
        </a>
      </div>
    </section>
  )
}

function GitHubImport({ app }: { app: AppDetail }) {
  const slug = app.slug
  const [jobId, setJobId] = useState<string | null>(() => recalledJob(slug))
  const key = jobId ? keys.importJob(slug, jobId) : null
  const { data: job, error: jobError } = useResource<ImportJob>(key, () => api.importJob(slug, jobId!), 1_000)
  const active = job?.state === "queued" || job?.state === "running"

  // Poll while it runs; stop once it's done or failed.
  useEffect(() => {
    if (!key || !jobId || !active) return
    const t = setInterval(() => load(key, () => api.importJob(slug, jobId)).catch(() => {}), 2_000)
    return () => clearInterval(t)
  }, [key, jobId, active, slug])

  // A remembered job that's gone (deleted workspace data, another browser's id): forget it.
  useEffect(() => {
    if (jobError instanceof ApiFailure && jobError.status === 404) {
      rememberJob(slug, null)
      setJobId(null)
    }
  }, [jobError, slug])

  const [repo, setRepo] = useState("")
  const [token, setToken] = useState("")
  const [filter, setFilter] = useState<"open" | "all">("all")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Another import is running that this browser didn't start (409): the form waits.
  const [blocked, setBlocked] = useState(false)
  const name = repoName(repo)
  const repoOk = validRepo(name)

  const start = async (e: FormEvent) => {
    e.preventDefault()
    if (!repoOk || !token.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await api.importGitHub(slug, { repo: name, token: token.trim(), state: filter })
      setData(keys.importJob(slug, next.id), next)
      rememberJob(slug, next.id)
      setJobId(next.id)
      setToken("")
      setRepo("")
    } catch (err) {
      if (err instanceof ApiFailure && err.code === "import_active") setBlocked(true)
      setError(importError(err))
    } finally {
      setBusy(false)
    }
  }

  const disabled = active || blocked || busy
  return (
    <section className="data-section" aria-labelledby="import-title">
      <h2 id="import-title" className="data-title">
        Import from GitHub
      </h2>
      <p className="data-text">
        Copies a repository's issues, comments and labels into this workspace in the background. Authors show as guests named after their
        GitHub login, and each issue links back to the original. One import runs at a time.
      </p>
      <form className="data-form" onSubmit={start} aria-disabled={disabled || undefined}>
        <fieldset disabled={disabled} className="data-fieldset">
          <div className="field">
            <label className="field-label" htmlFor="gh-repo">
              Repository
            </label>
            <div className="input" data-invalid={(repo.trim() && !repoOk) || undefined}>
              <input
                id="gh-repo"
                className="mono"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/name"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="gh-repo-hint"
              />
            </div>
            <p id="gh-repo-hint" className="data-hint">
              {repo.trim() && !repoOk ? "Use owner/name, like acme/app, or paste the repository's URL." : repo.trim() && name !== repo.trim() ? `Imports ${name}` : "Like acme/app, or the repository's URL."}
            </p>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="gh-token">
              Access token
            </label>
            <div className="input">
              <input
                id="gh-token"
                type="password"
                className="mono"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="github_pat_…"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="gh-token-hint"
              />
            </div>
            <p id="gh-token-hint" className="data-hint">
              A fine-grained token with read-only <strong>Issues</strong> access to this repository. It's used for this import only, then deleted.{" "}
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">
                Create one ↗
              </a>
            </p>
          </div>
          <div className="field">
            <span className="field-label" id="gh-state-label">
              Issues
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby="gh-state-label">
              {(["all", "open"] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={filter === v} aria-pressed={filter === v} onClick={() => setFilter(v)}>
                  {v === "all" ? "All, open and closed" : "Open only"}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <p className="flash" data-tone="danger" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <Button type="submit" variant="primary" disabled={disabled || !repoOk || !token.trim()}>
              {busy ? "Checking with GitHub…" : "Start import"}
            </Button>
            {active && <span className="data-hint">An import is running; this form opens again when it finishes.</span>}
          </div>
        </fieldset>
      </form>
      {job && <Progress slug={slug} job={job} onDismiss={() => (rememberJob(slug, null), setJobId(null))} />}
    </section>
  )
}

/** The server's refusals in plain words; GitHub's own message comes through for validation failures. */
function importError(e: unknown) {
  if (!(e instanceof ApiFailure)) return errorMessage(e)
  if (e.code === "import_active") return "An import is already running in this workspace. Start another when it finishes."
  if (e.code === "github_validation") {
    const m = e.message.toLowerCase()
    if (e.status === 429 || m.includes("rate limit")) return "GitHub is rate limiting this token. Try again in a few minutes."
    if (m.includes("rejected the token")) return "GitHub didn't accept that token. Check it's pasted in full and hasn't expired."
    if (m.includes("not found")) return "GitHub couldn't find that repository with this token. Check the name, and that the token can read its issues."
    if (m.includes("lacks permission")) return "The token can't read this repository's issues. Give it read-only Issues access to the repository."
    if (m.includes("temporarily unavailable")) return "GitHub isn't answering right now. Try again in a minute."
    if (m.includes("does not match")) return "That repository has moved or been renamed. Use its current owner/name."
    return `GitHub said: ${e.message}`
  }
  if (/does not match/i.test(e.message)) return "That repository has moved or been renamed. Use its current owner/name."
  if (e.code === "invalid_input") return "Use a repository as owner/name and paste the whole token."
  return e.message
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

const stateText: Record<ImportJob["state"], string> = { queued: "Queued", running: "Importing", done: "Done", failed: "Failed" }

function Progress({ slug, job, onDismiss }: { slug: string; job: ImportJob; onDismiss: () => void }) {
  const active = job.state === "queued" || job.state === "running"
  const n = job.imported
  return (
    <div className="import-job" data-state={job.state} role="status" aria-live="polite">
      <div className="import-job-head">
        <span className="import-state" data-state={job.state}>
          {active && <Dots />}
          {stateText[job.state]}
        </span>
        <a className="import-repo mono" href={`https://github.com/${job.repo}`} target="_blank" rel="noopener">
          {job.repo} ↗
        </a>
        <span className="spacer" />
        {!active && (
          <Button size="small" variant="invisible" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
      <p className="import-counts">
        <span>
          <strong>{n.issues}</strong> {n.issues === 1 ? "issue" : "issues"}
        </span>
        <span>
          <strong>{n.comments}</strong> {n.comments === 1 ? "comment" : "comments"}
        </span>
        <span>
          <strong>{n.labels}</strong> {n.labels === 1 ? "label" : "labels"}
        </span>
      </p>
      <p className="import-meta">
        {job.state === "queued" && "Waiting to start. "}
        {job.state === "running" && "Copying in the background; you can leave this page. "}
        Started <Time iso={job.created_at} />
        {job.finished_at && (
          <>
            {" "}
            · finished <Time iso={job.finished_at} />
          </>
        )}
      </p>
      {job.state === "failed" && (
        <p className="import-error">
          {sentence(job.error ?? "The import stopped")} <span className="import-error-note">Anything imported before it stopped stays.</span>
        </p>
      )}
      {job.state === "done" && (
        <p className="import-done">
          <AppLink slug={slug} href={appPath(slug, "/?q=" + encodeURIComponent("is:open"))}>
            See the issues
          </AppLink>
        </p>
      )}
    </div>
  )
}

function DownloadIcon() {
  return (
    <svg className="icon" width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.75v7.5M4.75 7.25 8 10.5l3.25-3.25M3 13.25h10" />
    </svg>
  )
}
