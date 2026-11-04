import { Hono } from "hono"
import type { ImportJob } from "../shared/api"
import { auditActor, entry } from "./audit"
import { bad, body, choice, fail, missing, now, sha256, sql, str, uid, type Bindings } from "./core"
import { requireTeam } from "./permissions"

type Job = Omit<ImportJob, "imported" | "source"> & {
  app_id: string
  requester: string
  actor: string
  cipher: string | null
  version: number
  filter: "open" | "all"
  private_repo: number
  stage: "labels" | "issues" | "comments"
  page: number
  issues: number
  comments: number
  labels: number
  due: number
  failures: number
}
type Label = { name: string; color: string; description?: string | null }
type GHUser = { login: string } | null
type Post = { id: number; user: GHUser; body: string | null; created_at: string; updated_at: string }
type GHIssue = Post & {
  number: number
  title: string
  state: "open" | "closed"
  state_reason: string | null
  closed_at: string | null
  closed_by?: GHUser
  labels: Label[]
  comments: number
  pull_request?: unknown
}
type ImportMessage = { kind: "github.import"; id: string; version: number }
const seconds = () => Math.floor(Date.now() / 1000),
  enc = new TextEncoder()
const project = (j: Job): ImportJob => ({
  id: j.id,
  source: "github",
  repo: j.repo,
  state: j.state,
  imported: { issues: j.issues, comments: j.comments, labels: j.labels },
  error: j.error,
  created_at: j.created_at,
  finished_at: j.finished_at
})
const readJob = (env: Env, app: string, id: string) =>
  sql(
    env,
    "SELECT id,repo,state,issues,comments,labels,error,created_at,finished_at FROM github_jobs WHERE app_id=? AND id=?",
    app,
    id
  ).first<Job>()
const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data)),
  un64 = (s: string) => Uint8Array.from(atob(s), (x) => x.charCodeAt(0))
async function key(env: Env) {
  if (!env.COOKIE_SECRET || env.COOKIE_SECRET.length < 32) fail(503, "misconfigured", "Import encryption unavailable")
  const material = await crypto.subtle.importKey("raw", enc.encode(env.COOKIE_SECRET), "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("Bellhop"), info: enc.encode("github-import/v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}
const aad = (j: { id: string; app_id: string; repo: string }) => enc.encode(JSON.stringify([j.id, j.app_id, j.repo]))
async function seal(env: Env, token: string, j: Parameters<typeof aad>[0]) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  return (
    b64(iv) +
    "." +
    b64(
      new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(j) }, await key(env), enc.encode(token))
      )
    )
  )
}
async function open(env: Env, j: Job) {
  const [iv, data] = j.cipher!.split(".")
  return new TextDecoder().decode(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: un64(iv!), additionalData: aad(j) }, await key(env), un64(data!))
  )
}

class GitHubError extends Error {
  constructor(
    message: string,
    readonly retryAt?: number,
    readonly limited = false
  ) {
    super(message)
  }
}
async function github<T>(repo: string, path: string, token: string): Promise<{ data: T; more: boolean }> {
  let r: Response
  try {
    r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "User-Agent": "Bellhop-Importer",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    })
  } catch {
    throw new GitHubError("GitHub temporarily unavailable", seconds() + 30)
  }
  if (!r.ok) {
    const secondary =
      r.status === 403 &&
      /rate limit/i.test((await r.json<{ message?: string }>().catch(() => ({ message: "" }))).message ?? "")
    if (r.status !== 403) await r.body?.cancel()
    const retry = r.headers.get("Retry-After"),
      reset = Number(r.headers.get("X-RateLimit-Reset")) || 0
    if (
      r.status === 429 ||
      (r.status === 403 && (secondary || retry !== null || r.headers.get("X-RateLimit-Remaining") === "0"))
    ) {
      const after =
        retry === null ? 0 : /^\d+$/.test(retry) ? seconds() + Number(retry) : Math.ceil(Date.parse(retry) / 1000) || 0
      throw new GitHubError(
        "GitHub rate limit reached",
        Math.max(seconds() + 1, after, reset, !after && !reset ? seconds() + 60 : 0),
        true
      )
    }
    if (r.status >= 500) throw new GitHubError("GitHub temporarily unavailable", seconds() + 30)
    throw new GitHubError(
      r.status === 401
        ? "GitHub rejected the token"
        : r.status === 404
          ? "Repository not found or token has no access"
          : r.status === 403
            ? "GitHub token lacks permission"
            : "GitHub rejected the repository request"
    )
  }
  // Never forward credentials to a Link target. GitHub page numbers are local cursor state.
  const data = await r.json<T>().catch(() => {
    throw new GitHubError("Invalid GitHub response")
  })
  return { data, more: /;\s*rel="next"/.test(r.headers.get("Link") ?? "") }
}
const message = (j: { id: string; version: number }): ImportMessage => ({
  kind: "github.import",
  id: j.id,
  version: j.version
})
async function dispatch(env: Env, j: { id: string; version: number }, delay = 0) {
  // Cron recovers the committed checkpoint if the producer or worker is interrupted.
  if (delay > 43200) return
  await env.WEBHOOKS.send(message(j), { delaySeconds: delay })
}
const routes = "/api/apps/:slug/import"
export const imports = new Hono<Bindings>()
imports.get(routes + "/:id", async (c) => {
  requireTeam(c, "setup")
  return c.json(project((await readJob(c.env, c.var.app.id, c.req.param("id")!)) ?? missing()))
})
imports.post(routes + "/github", async (c) => {
  requireTeam(c, "setup")
  const b = await body(c),
    repo = str(b.repo, "repo", 140).toLowerCase(),
    token = str(b.token, "token", 4096),
    filter = choice(b.state === undefined ? "all" : b.state, ["open", "all"] as const, "state")
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/.test(repo) ||
    [".", ".."].includes(repo.split("/")[1]!) ||
    /[^\x21-\x7e]/.test(token)
  )
    bad("Expected a GitHub owner/name and token")
  const env = c.env,
    app = c.var.app.id,
    j = { id: uid(), app_id: app, repo }
  if (await sql(env, `SELECT 1 FROM github_jobs WHERE app_id=? AND cipher IS NOT NULL`, app).first())
    fail(409, "import_active", "A workspace import is already running")
  let privateRepo = true
  try {
    const { data } = await github<{ private: boolean; full_name: string; visibility?: string }>(repo, "", token)
    if (data.full_name?.toLowerCase() !== repo) bad("Repository name does not match")
    privateRepo = data.private !== false || data.visibility !== "public"
  } catch (e) {
    if (e instanceof GitHubError) {
      if (e.retryAt) c.header("Retry-After", String(Math.max(1, e.retryAt - seconds())))
      fail(e.limited ? 429 : e.retryAt ? 503 : 400, "github_validation", e.message)
    }
    throw e
  }
  try {
    await env.DB.batch([
      sql(
        env,
        `INSERT INTO github_jobs(id,app_id,repo,filter,private_repo,requester,actor,cipher,created_at,wake) VALUES(?,?,?,?,?,?,?,?,?,unixepoch()+120)`,
        j.id,
        app,
        repo,
        filter,
        Number(privateRepo),
        c.var.user!.id,
        auditActor(c.var.actor),
        await seal(env, token, j),
        now()
      ),
      entry(env, app, c.var.actor, "import.started", { type: "import", id: j.id }, { repo, filter })
    ])
  } catch (e) {
    if (String(e).includes("github_jobs.app_id")) fail(409, "import_active", "A workspace import is already running")
    throw e
  }
  await dispatch(env, { id: j.id, version: 0 }).catch(() => {})
  return c.json(project((await readJob(env, app, j.id)) ?? missing()), 202)
})

async function actor(app: string, user: GHUser) {
  const login = user?.login || "ghost",
    id = "gh-" + (await sha256(app + "\0" + login.toLowerCase())).slice(0, 32)
  return JSON.stringify({ type: "guest", id, name: "@" + login, handle: "guest-" + id.slice(3, 7) })
}
function date(s: string) {
  return new Date(s).toISOString()
}
function labelWrite(env: Env, j: Job, l: Label) {
  const color = /^[a-f\d]{6}$/i.test(l.color) ? l.color.toLowerCase() : "ededed"
  return [
    sql(
      env,
      `INSERT INTO labels(id,app_id,name,color,description) VALUES(?,?,?,?,?) ON CONFLICT(app_id,name) DO NOTHING`,
      uid(),
      j.app_id,
      l.name,
      color,
      l.description ?? ""
    ),
    count(env, j, "labels"),
    sql(env, "UPDATE labels SET color=? WHERE app_id=? AND name=? AND color!=?", color, j.app_id, l.name, color)
  ]
}
const count = (env: Env, j: Job, field: "labels" | "issues" | "comments") =>
  sql(env, `UPDATE github_jobs SET ${field}=${field}+changes() WHERE id=?`, j.id)
const guard = (env: Env, j: Job, adminCheck = false) =>
  sql(env, "INSERT INTO github_step VALUES(?,?,?)", j.id, j.version, Number(adminCheck))
async function finish(env: Env, j: Job, error: string | null) {
  await env.DB.batch([
    guard(env, j),
    sql(
      env,
      `UPDATE github_jobs SET state=?,cipher=NULL,error=?,finished_at=?,version=version+1 WHERE id=?`,
      error ? "failed" : "done",
      error,
      now(),
      j.id
    ),
    sql(env, "DELETE FROM github_threads WHERE job=?", j.id),
    entry(
      env,
      j.app_id,
      JSON.parse(j.actor),
      error ? "import.failed" : "import.completed",
      { type: "import", id: j.id },
      { repo: j.repo, issues: j.issues, comments: j.comments, labels: j.labels },
      "1"
    )
  ])
}
async function step(env: Env, j: Job) {
  if (
    !(await sql(
      env,
      "SELECT 1 FROM members WHERE app_id=? AND user_id=? AND role IN ('owner','admin')",
      j.app_id,
      j.requester
    ).first())
  )
    return finish(env, j, "Requester no longer has admin access")
  if (Date.parse(j.created_at) < Date.now() - 7 * 86400000) return finish(env, j, "Import expired; start a new import")
  const token = await open(env, j),
    q = [guard(env, j, true)],
    suffix = `per_page=20&page=${j.page}`
  let stage = j.stage,
    page = j.page + 1
  if (stage === "labels") {
    const { data, more } = await github<Label[]>(j.repo, "/labels?" + suffix, token)
    for (const l of data) q.push(...labelWrite(env, j, l))
    if (!more) {
      stage = "issues"
      page = 1
    }
  } else if (stage === "issues") {
    const { data, more } = await github<GHIssue[]>(
      j.repo,
      `/issues?sort=created&direction=asc&state=${j.filter}&${suffix}`,
      token
    )
    for (const i of data) {
      if (i.pull_request || (j.filter === "open" && i.state !== "open")) continue
      const id = uid(),
        au = await actor(j.app_id, i.user),
        reason =
          i.state === "closed"
            ? ["duplicate", "not_planned"].includes(i.state_reason ?? "")
              ? i.state_reason
              : "completed"
            : null
      const existing = "SELECT id FROM issues WHERE github_workspace=? AND github_repo=? AND github_number=?",
        args = [j.app_id, j.repo, i.number]
      q.push(
        sql(env, `UPDATE apps SET issue_seq=issue_seq+1 WHERE id=? AND NOT EXISTS(${existing})`, j.app_id, ...args),
        sql(
          env,
          `INSERT INTO issues(id,app_id,number,title,body,status,close_reason,author,created_at,updated_at,private,github_workspace,github_repo,github_number)
        SELECT ?,id,issue_seq,?,?,?,?,?,?,?,max(default_private,?),id,?,? FROM apps WHERE id=? AND changes()=1`,
          id,
          i.title,
          i.body ?? "",
          i.state,
          reason,
          au,
          date(i.created_at),
          date(i.updated_at),
          j.private_repo,
          j.repo,
          i.number,
          j.app_id
        ),
        count(env, j, "issues"),
        sql(
          env,
          `INSERT INTO issue_labels SELECT i.id,l.id FROM issues i JOIN labels l ON l.app_id=i.app_id WHERE i.id=? AND l.name IN(SELECT value FROM json_each(?))`,
          id,
          JSON.stringify(i.labels.map((l) => l.name))
        )
      )
      if (reason && i.closed_at)
        q.push(
          sql(
            env,
            `INSERT INTO issue_events SELECT ?,id,'status_changed',?,json_object('from','open','to','closed','close_reason',?),? FROM issues WHERE id=?`,
            uid(),
            await actor(j.app_id, i.closed_by ?? null),
            reason,
            date(i.closed_at),
            id
          )
        )
      if (i.comments)
        q.push(
          sql(
            env,
            `INSERT OR IGNORE INTO github_threads SELECT ?,?,id FROM issues WHERE id=(${existing}) AND app_id=?`,
            j.id,
            i.number,
            ...args,
            j.app_id
          )
        )
    }
    if (!more) {
      stage = "comments"
      page = 1
    }
  } else {
    const thread = await sql(
      env,
      "SELECT number,issue FROM github_threads WHERE job=? ORDER BY number LIMIT 1",
      j.id
    ).first<{ number: number; issue: string }>()
    if (!thread) return finish(env, j, null)
    const { data, more } = await github<Post[]>(j.repo, `/issues/${thread.number}/comments?${suffix}`, token)
    for (const c of data)
      q.push(
        sql(
          env,
          `INSERT INTO comments(id,issue_id,author,body,created_at,updated_at,writer_version,github_id)
      SELECT ?,id,?,?,?,?,1,? FROM issues WHERE id=? AND app_id=? AND NOT EXISTS(SELECT 1 FROM comments WHERE issue_id=? AND github_id=?)`,
          uid(),
          await actor(j.app_id, c.user),
          c.body ?? "",
          date(c.created_at),
          date(c.updated_at),
          c.id,
          thread.issue,
          j.app_id,
          thread.issue,
          c.id
        ),
        count(env, j, "comments")
      )
    if (!more) {
      q.push(sql(env, "DELETE FROM github_threads WHERE job=? AND number=?", j.id, thread.number))
      page = 1
    }
  }
  q.push(
    sql(
      env,
      `UPDATE github_jobs SET state='running',stage=?,page=?,due=0,wake=unixepoch()+120,failures=0,version=version+1 WHERE id=?`,
      stage,
      page,
      j.id
    )
  )
  await env.DB.batch(q)
  await dispatch(env, { id: j.id, version: j.version + 1 }).catch(() => {})
}
export async function importMessage(env: Env, m: Message<ImportMessage>) {
  const j = await sql(
    env,
    `SELECT * FROM github_jobs WHERE id=? AND version=? AND cipher IS NOT NULL`,
    m.body.id,
    m.body.version
  ).first<Job>()
  if (!j || j.due > seconds()) return m.ack()
  try {
    await step(env, j)
  } catch (e) {
    if (String(e).includes("stale github step")) return m.ack()
    if (e instanceof GitHubError && e.retryAt && (e.limited || j.failures < 6)) {
      const due = Math.min(e.retryAt, Math.ceil(Date.parse(j.created_at) / 1000) + 7 * 86400),
        changed = await sql(
          env,
          `UPDATE github_jobs SET state='running',due=?,wake=?,version=version+1,failures=failures+? WHERE id=? AND version=? AND cipher IS NOT NULL`,
          due,
          due + 120,
          Number(!e.limited),
          j.id,
          j.version
        ).run()
      if (changed.meta.changes)
        await dispatch(env, { id: j.id, version: j.version + 1 }, Math.max(0, due - seconds())).catch(() => {})
    } else {
      await finish(env, j, e instanceof GitHubError ? e.message : "Import could not process this page")
    }
  }
  m.ack()
}
export async function wakeImports(env: Env) {
  // Bound credential lifetime even during a prolonged queue outage.
  const expired = await sql(
    env,
    `SELECT * FROM github_jobs WHERE cipher IS NOT NULL AND created_at<strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') LIMIT 50`
  ).all<Job>()
  for (const j of expired.results) {
    try {
      await finish(env, j, "Import expired; start a new import")
    } catch (e) {
      if (!String(e).includes("stale github step")) throw e
    }
  }
  const jobs = await sql(
    env,
    `UPDATE github_jobs SET wake=unixepoch()+120 WHERE id IN(SELECT id FROM github_jobs WHERE cipher IS NOT NULL AND wake<=unixepoch() AND due<=unixepoch() ORDER BY wake LIMIT 50) RETURNING id,version`
  ).all<{ id: string; version: number }>()
  if (jobs.results.length) await env.WEBHOOKS.sendBatch(jobs.results.map((j) => ({ body: message(j) })))
}
