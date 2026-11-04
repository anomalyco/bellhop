import type { Actor, Autonomy, Issue, RequestField, RequestType, RouteTarget } from "../shared/api"
import { bad, choice, email, input, now, sql, str } from "./core"
import { agentAccessSQL } from "./permissions"

export const autonomy = (x: unknown) => choice(x, ["suggest", "approve_actions", "autonomous"] as const, "autonomy")
const flag = (x: unknown, key: string) => (typeof x === "boolean" ? x : bad(`Invalid ${key}`))
const kinds = ["text", "textarea", "email", "url", "number", "select"] as const
function checkFieldBytes(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) bad("fields JSON exceeds 256 KiB")
}
export function fieldDefinitions(raw: unknown): RequestField[] {
  if (!Array.isArray(raw) || raw.length > 30) bad("Expected at most 30 fields")
  const keys = new Set<string>()
  const fields = raw.map((value) => {
    const b = input(value),
      key = str(b.key, "field key", 40)
    if (!/^[a-z0-9_]{1,40}$/.test(key) || keys.has(key)) bad(`Invalid or duplicate field key: ${key}`)
    keys.add(key)
    const kind = choice(b.kind, kinds, key + " kind"),
      label = str(b.label, key + " label", 120).trim(),
      required = b.required === undefined ? false : flag(b.required, key + " required"),
      internal = b.internal === undefined ? false : flag(b.internal, key + " internal"),
      verify = b.verify === undefined ? false : flag(b.verify, key + " verify")
    if (verify && (kind !== "email" || internal)) bad(`${key}: verification requires a requester-visible email field`)
    let options: string[] | undefined
    if (kind === "select") {
      if (!Array.isArray(b.options) || !b.options.length || b.options.length > 100)
        bad(`${key}: expected 1–100 options`)
      options = b.options.map((x) => str(x, key + " option", 120).trim())
      if (new Set(options).size !== options.length) bad(`${key}: duplicate option`)
    } else if (b.options !== undefined) bad(`${key}: options require select`)
    return {
      key,
      label,
      kind,
      required,
      ...(options && { options }),
      ...(b.help !== undefined && { help: str(b.help, key + " help", 512, true) }),
      ...(verify && { verify }),
      ...(internal && { internal })
    }
  })
  checkFieldBytes(fields)
  return fields
}
export function routeTarget(v: unknown): RouteTarget {
  if (v === null) return null
  const b = input(v)
  if (Object.keys(b).length !== 1) bad("Expected one route target")
  if (b.member !== undefined) return { member: email(b.member) }
  if (b.agent !== undefined) return { agent: str(b.agent, "agent id", 100) }
  if (b.group !== undefined) return { group: str(b.group, "group id", 100) }
  return bad("Unknown route target")
}
export function lookupRoute(app: string, target: RouteTarget) {
  if (!target) return { query: "SELECT NULL", args: [] as string[] }
  if ("group" in target)
    return { query: "SELECT id FROM handoff_groups WHERE app_id=? AND id=?", args: [app, target.group] }
  return "member" in target
    ? {
        query: `SELECT json_object('type','member','id',u.id,'name',u.name,'avatar_url',u.avatar_url,'role',m.role) FROM users u JOIN members m ON m.user_id=u.id WHERE m.app_id=? AND u.email=?`,
        args: [app, target.member]
      }
    : {
        query: `SELECT json_object('type','agent','id',g.id,'name',g.name) FROM agents g JOIN (${agentAccessSQL}) acl ON acl.agent_id=g.id WHERE acl.app_id=? AND g.id=? AND acl.role IN ('responder','member','admin')`,
        args: [app, target.agent]
      }
}
type Stored = Omit<RequestType, "fields" | "route" | "archived" | "require_verification"> & {
  fields: string
  route: string | null
  archived: number
  require_verification: number
  version: number
}
export type Config = RequestType & { version: number }
const cols =
  "t.id,t.name,t.description,t.fields,t.route,t.require_verification,t.autonomy,t.position,t.archived,t.version"
const decode = (r: Stored): Config => ({
  ...r,
  fields: JSON.parse(r.fields),
  route: r.route ? JSON.parse(r.route) : null,
  archived: !!r.archived,
  require_verification: !!r.require_verification
})
export function visibleType(t: Config, team: boolean): RequestType {
  const { version, ...rest } = t
  return team ? rest : { ...rest, fields: t.fields.filter((f) => !f.internal), route: null, autonomy: null }
}
export async function types(env: Env, app: string, team: boolean) {
  return (
    await sql(
      env,
      `SELECT ${cols} FROM request_types t JOIN apps a ON a.id=t.app_id WHERE a.mode='helpdesk' AND a.id=? ${team ? "" : "AND t.archived=0"} ORDER BY t.position,t.id`,
      app
    ).all<Stored>()
  ).results.map((t) => visibleType(decode(t), team))
}
export async function config(env: Env, app: string, value: unknown, byName = false, archived = false) {
  const ref = str(value, "request_type", 120)
  const rs = await sql(
    env,
    `SELECT ${cols} FROM request_types t JOIN apps a ON a.id=t.app_id WHERE a.id=? AND a.mode='helpdesk' AND (t.id=? ${byName ? "OR t.name=? COLLATE NOCASE" : ""}) ${archived ? "" : "AND t.archived=0"} LIMIT 2`,
    app,
    ref,
    ...(byName ? [ref] : [])
  ).all<Stored>()
  if (rs.results.length !== 1) bad("Unknown, archived or ambiguous request type")
  return decode(rs.results[0]!)
}
export function formAnswers(t: RequestType, raw: unknown, team: boolean) {
  const b = raw === undefined ? {} : input(raw),
    answers = new Map<string, string>(),
    pub = new Map<string, string>(),
    verify = new Set<string>(),
    defs = new Map(t.fields.map((f) => [f.key, f]))
  checkFieldBytes(b)
  for (const k of Object.keys(b))
    if (!defs.has(k) || (!team && defs.get(k)!.internal)) bad(`${k}: field is not writable`)
  for (const f of t.fields) {
    if (f.internal && !team) continue
    const k = f.key,
      v = Object.hasOwn(b, k) ? b[k] : undefined
    if (v === undefined || (typeof v === "string" && !v.trim())) {
      if (f.required) bad(`${k}: required`)
      continue
    }
    const cap =
      f.kind === "textarea"
        ? 8192
        : f.kind === "url"
          ? 2048
          : f.kind === "email"
            ? 254
            : f.kind === "number"
              ? 64
              : 1024
    let text = str(v, k, cap).trim()
    if (f.kind === "select" && !f.options!.includes(text)) bad(`${k}: not a configured option`)
    if (
      f.kind === "number" &&
      (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text)))
    )
      bad(`${k}: expected a finite number`)
    if (f.kind === "email") {
      if (/[\p{Cc}\p{Cf}<>";,]/u.test(text)) bad(`${k}: invalid email`)
      try {
        text = email(text)
      } catch {
        bad(`${k}: invalid email`)
      }
      if (f.verify) verify.add(text)
    }
    if (f.kind === "url") {
      const u = URL.parse(text)
      if (!/^https?:\/\//i.test(text) || /[\\\s\p{Cc}]/u.test(text) || !u || !u.hostname || u.username || u.password)
        bad(`${k}: expected an absolute HTTP(S) URL`)
    }
    answers.set(k, text)
    if (!f.internal) pub.set(k, text)
  }
  return { all: Object.fromEntries(answers), public: Object.fromEntries(pub), verify: [...verify] }
}
export const typeGuard = (env: Env, test: string, ...args: unknown[]) =>
  sql(env, `INSERT INTO request_type_guard SELECT 0 WHERE NOT (${test})`, ...args)
// Don't replay a cached create response after a formerly public answer is hidden.
// Keep the nonce reservation so a retry cannot open the request a second time.
export function retireFormReplays(env: Env, app: string, filter: "type_id" | "issue_id", id: string) {
  return sql(
    env,
    `UPDATE api_replays SET cipher=NULL,status=410 WHERE route='/v1/conversations' AND length(scope)=64 AND key_id IN(SELECT id FROM api_keys WHERE app_id=?1) AND EXISTS(SELECT 1 FROM request_answers b JOIN issues i ON i.id=b.issue_id AND i.app_id=b.app_id WHERE b.app_id=?1 AND b.${filter}=?2 AND (api_replays.contact_id=json_extract(i.author,'$.id') OR (api_replays.contact_id IS NULL AND api_replays.scope IN(SELECT s.family FROM api_sessions s WHERE s.app_id=b.app_id AND coalesce(s.contact_id,s.anon_id)=json_extract(i.author,'$.id')))))`,
    app,
    id
  )
}
export function routingWrites(
  env: Env,
  app: string,
  id: string,
  t: Config,
  answers: ReturnType<typeof formAnswers>,
  operator: Actor,
  event: string,
  handoff: D1PreparedStatement[] = []
) {
  const group = t.route && "group" in t.route,
    target = lookupRoute(app, group ? null : t.route)
  return [
    typeGuard(
      env,
      `EXISTS(SELECT 1 FROM request_types t JOIN apps a ON a.id=t.app_id JOIN issues i ON i.app_id=a.id WHERE i.id=? AND a.id=? AND a.mode='helpdesk' AND t.id=? AND t.version=? AND NOT t.archived)`,
      id,
      app,
      t.id,
      t.version
    ),
    sql(
      env,
      `INSERT INTO request_answers VALUES(?,?,?,?,?) ON CONFLICT(issue_id) DO UPDATE SET type_id=excluded.type_id,answers=excluded.answers,public_answers=excluded.public_answers`,
      id,
      app,
      t.id,
      JSON.stringify(answers.all),
      JSON.stringify(answers.public)
    ),
    sql(
      env,
      `UPDATE issues SET assignee=CASE WHEN EXISTS(SELECT 1 FROM handoffs h WHERE h.issue_id=issues.id AND h.ended_at IS NULL) THEN assignee ELSE (${target.query}) END,revision=revision+1,updated_at=max(updated_at,?) WHERE id=? AND app_id=?`,
      ...target.args,
      now(),
      id,
      app
    ),
    ...handoff,
    sql(
      env,
      `INSERT INTO request_route_events SELECT ?,i.id,i.app_id,?,json_object('request_type',?,'target',json(?),'outcome',CASE WHEN i.assignee IS NOT NULL THEN 'assigned' WHEN ? THEN 'target_unavailable' ELSE 'unassigned' END,'assignee',json(i.assignee)),? FROM issues i WHERE id=? AND app_id=?`,
      event,
      JSON.stringify(operator),
      t.id,
      JSON.stringify(t.route),
      Number(!!t.route),
      now(),
      id,
      app
    ),
    sql(
      env,
      `INSERT INTO mail_signal(issue_id,kind,ref,actor,target) SELECT id,'assigned',?,?,json_extract(assignee,'$.id') FROM issues WHERE id=? AND app_id=? AND json_extract(assignee,'$.type')='member' AND NOT EXISTS(SELECT 1 FROM handoffs h WHERE h.issue_id=issues.id AND h.ended_at IS NULL)`,
      event,
      operator.id,
      id,
      app
    )
  ]
}
// Never put team answers on mixed-audience Room summaries. Public keys must have
// been public at submission AND still be visible in the current definition.
export function requestJson(team: boolean) {
  return `(SELECT json_object('request_type',CASE WHEN t.id IS NULL THEN NULL ELSE json_object('id',t.id,'name',t.name) END,'fields',json(coalesce(${team ? "b.answers" : `(SELECT json_group_object(p.key,p.value) FROM json_each(b.public_answers) p WHERE EXISTS(SELECT 1 FROM json_each(t.fields) f WHERE json_extract(f.value,'$.key')=p.key AND NOT coalesce(json_extract(f.value,'$.internal'),0)))`},'{}'))${team ? ",'effective_autonomy',coalesce(t.autonomy,a.default_autonomy)" : ""}) FROM apps a LEFT JOIN request_answers b ON b.app_id=a.id AND b.issue_id=i.id LEFT JOIN request_types t ON t.app_id=b.app_id AND t.id=b.type_id WHERE a.id=i.app_id AND a.mode='helpdesk')`
}
export type TypeInfo = Pick<Issue, "request_type" | "fields"> & { effective_autonomy?: Autonomy }
export const typeInfo = (value: string | null): TypeInfo =>
  value ? JSON.parse(value) : { request_type: null, fields: {} }
