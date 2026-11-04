import { useEffect, useState, type FormEvent } from "react"
import type { AppDetail, ImportJob } from "../../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { load, setData, useResource } from "../../lib/cache"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { Button, Dots } from "../../ui/primitives"
import { AppLink } from "../../ui/SiteLink"
import { t, tr, tKey, useT } from "../../i18n/settings"
import { t as tc } from "../../i18n/core"
import { formatNumber, sentenceGap } from "../../i18n"
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
  useT()
  return (
    <div className="data">
      <div className="settings-heading">
        <h1>{tKey("section.data")}</h1>
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
        {t("data.export")}
      </h2>
      <p className="data-text">{t("data.exportText")}</p>
      <div className="data-actions">
        <a className="btn" data-variant="default" href={api.exportUrl(app.slug)} download={`${app.slug}.ndjson`}>
          <DownloadIcon />
          {t("data.download")}
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
        {t("data.import")}
      </h2>
      <p className="data-text">{t("data.importText")}</p>
      <form className="data-form" onSubmit={start} aria-disabled={disabled || undefined}>
        <fieldset disabled={disabled} className="data-fieldset">
          <div className="field">
            <label className="field-label" htmlFor="gh-repo">
              {t("data.repo")}
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
              {repo.trim() && !repoOk ? t("data.repoInvalid") : repo.trim() && name !== repo.trim() ? t("data.repoImports", { name }) : t("data.repoHint")}
            </p>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="gh-token">
              {t("data.token")}
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
              {tr("data.tokenHint", { issues: <strong>{t("data.tokenIssues")}</strong> })}{" "}
              <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">
                {t("data.createToken")}
              </a>
            </p>
          </div>
          <div className="field">
            <span className="field-label" id="gh-state-label">
              {t("data.issues")}
            </span>
            <div className="segmented" role="radiogroup" aria-labelledby="gh-state-label">
              {(["all", "open"] as const).map((v) => (
                <button key={v} type="button" role="radio" aria-checked={filter === v} aria-pressed={filter === v} onClick={() => setFilter(v)}>
                  {v === "all" ? t("data.all") : t("data.open")}
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
              {busy ? t("data.checking") : t("data.start")}
            </Button>
            {active && <span className="data-hint">{t("data.running")}</span>}
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
  if (e.code === "import_active") return t("data.errActive")
  if (e.code === "github_validation") {
    const m = e.message.toLowerCase()
    if (e.status === 429 || m.includes("rate limit")) return t("data.errRateLimit")
    if (m.includes("rejected the token")) return t("data.errToken")
    if (m.includes("not found")) return t("data.errNotFound")
    if (m.includes("lacks permission")) return t("data.errPermission")
    if (m.includes("temporarily unavailable")) return t("data.errUnavailable")
    if (m.includes("does not match")) return t("data.errMoved")
    return t("data.githubSaid", { message: e.message })
  }
  if (/does not match/i.test(e.message)) return t("data.errMoved")
  if (e.code === "invalid_input") return t("data.errInput")
  return e.message
}

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`)

const stateText = (state: ImportJob["state"]) =>
  ({ queued: t("data.queued"), running: t("data.importing"), done: t("data.done"), failed: t("data.failed") })[state]

function Progress({ slug, job, onDismiss }: { slug: string; job: ImportJob; onDismiss: () => void }) {
  const active = job.state === "queued" || job.state === "running"
  const n = job.imported
  return (
    <div className="import-job" data-state={job.state} role="status" aria-live="polite">
      <div className="import-job-head">
        <span className="import-state" data-state={job.state}>
          {active && <Dots />}
          {stateText(job.state)}
        </span>
        <a className="import-repo mono" href={`https://github.com/${job.repo}`} target="_blank" rel="noopener">
          {job.repo} ↗
        </a>
        <span className="spacer" />
        {!active && (
          <Button size="small" variant="invisible" onClick={onDismiss}>
            {tc("common.dismiss")}
          </Button>
        )}
      </div>
      <p className="import-counts">
        <span>{tr("data.countIssues", { count: n.issues, n: <strong>{formatNumber(n.issues)}</strong> })}</span>
        <span>{tr("data.countComments", { count: n.comments, n: <strong>{formatNumber(n.comments)}</strong> })}</span>
        <span>{tr("data.countLabels", { count: n.labels, n: <strong>{formatNumber(n.labels)}</strong> })}</span>
      </p>
      <p className="import-meta">
        {job.state === "queued" && t("data.waiting") + sentenceGap()}
        {job.state === "running" && t("data.copying") + sentenceGap()}
        {tr("data.started", { time: <Time iso={job.created_at} /> })}
        {job.finished_at && (
          <>
            {" · "}
            {tr("data.finished", { time: <Time iso={job.finished_at} /> })}
          </>
        )}
      </p>
      {job.state === "failed" && (
        <p className="import-error">
          {job.error ? sentence(job.error) : t("data.stopped")}
          {sentenceGap()}
          <span className="import-error-note">{t("data.stoppedNote")}</span>
        </p>
      )}
      {job.state === "done" && (
        <p className="import-done">
          <AppLink slug={slug} href={appPath(slug, "/?q=" + encodeURIComponent("is:open"))}>
            {t("data.see")}
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
