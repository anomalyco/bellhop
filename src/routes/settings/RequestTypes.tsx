import { useState, type FormEvent } from "react"
import type { AppAgent, AppDetail, AppSettings, Autonomy, RequestField, RequestType, RequestTypeInput, RouteTarget } from "../../../shared/api"
import { t as tc } from "../../i18n/core"
import { useT } from "../../i18n/helpdesk"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { load, setData, useResource } from "../../lib/cache"
import { ArrowUpIcon, PlusIcon, XIcon } from "../../ui/icons"
import { Button } from "../../ui/primitives"
import { AutonomyChoice } from "../../ui/helpdesk/Autonomy"
import "../../styles/agents.css"
import "../../styles/features.css"
import "../../styles/helpdesk.css"

const kinds: RequestField["kind"][] = ["text", "textarea", "email", "url", "number", "select"]
const keyShape = /^[a-z0-9_]{1,40}$/

/** "Billing email" → "billing_email": the field's key until the admin edits it. */
const keyFrom = (label: string) =>
  label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)

/** A field being edited: the definition, its options as text, and whether the key still follows the label. */
interface Draft extends RequestField {
  uid: string
  optionsText: string
  autoKey: boolean
}
let seq = 0
const draftOf = (f: RequestField): Draft => ({ ...f, uid: `f${++seq}`, optionsText: (f.options ?? []).join("\n"), autoKey: false })
const fieldOf = (d: Draft): RequestField => {
  const options = d.optionsText
    .split("\n")
    .map((o) => o.trim())
    .filter(Boolean)
  return {
    key: d.key,
    label: d.label.trim(),
    kind: d.kind,
    required: d.required,
    ...(d.kind === "select" && { options }),
    ...(d.help?.trim() && { help: d.help.trim() }),
    ...(d.kind === "email" && !d.internal && d.verify && { verify: true }),
    ...(d.internal && { internal: true }),
  }
}

/** Who a route goes to, by name, from the workspace's agents and members (groups aren't listed yet: "A group"). */
function routeName(route: RouteTarget | null, agents: AppAgent[] | undefined, settings: AppSettings | undefined, group: string) {
  if (!route) return null
  if ("agent" in route) return agents?.find((a) => a.id === route.agent)?.client_name ?? null
  if ("group" in route) return group
  const m = settings?.members.find((x) => x.email.toLowerCase() === route.member.toLowerCase())
  return m ? (m.name ?? m.email) : route.member
}

/** A route as the picker's value ("agent:…", "member:…", "group:…", or "" for nobody), and back. */
const routeValue = (route: RouteTarget | null | undefined) =>
  !route ? "" : "agent" in route ? `agent:${route.agent}` : "member" in route ? `member:${route.member}` : `group:${route.group}`
const routeOf = (value: string): RouteTarget => {
  const [kind] = value.split(":", 1)
  const id = value.slice(kind!.length + 1)
  return kind === "agent" ? { agent: id } : kind === "member" ? { member: id } : kind === "group" ? { group: id } : null
}

/**
 * Settings → Request types (admins, help desks): the kinds of request people pick from, in order, each with its
 * form fields, whether it needs a verified email, where new requests go, and the agent's mode. Archived types keep
 * their requests and can be restored.
 */
export function RequestTypes({ app }: { app: AppDetail }) {
  const t = useT()
  const key = keys.requestTypes(app.slug)
  const { data: list, error } = useResource<RequestType[]>(key, () => api.requestTypes(app.slug), 5_000)
  const { data: agents, error: agentsError } = useResource<AppAgent[]>(keys.appAgents(app.slug), () => api.appAgents(app.slug), 30_000)
  const { data: settings, error: settingsError } = useResource<AppSettings>(keys.settings(app.slug), () => api.settings(app.slug), 30_000)
  // Rows name where each type goes, so they wait for the agents and members too
  const ready = !!list && (!!agents || !!agentsError) && (!!settings || !!settingsError)
  const [editing, setEditing] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [moving, setMoving] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const sorted = [...(list ?? [])].sort((a, b) => a.position - b.position)
  const active = sorted.filter((x) => !x.archived)
  const archived = sorted.filter((x) => x.archived)

  const replace = (next: RequestType) => setData<RequestType[]>(key, (l) => (l?.some((x) => x.id === next.id) ? l.map((x) => (x.id === next.id ? next : x)) : [...(l ?? []), next]))

  // Reorder: swap with the neighbour, then number the active types 0…n-1, saving only the ones that moved
  const move = async (index: number, by: -1 | 1) => {
    const order = [...active]
    const [item] = order.splice(index, 1)
    order.splice(index + by, 0, item!)
    setMoving(true)
    setProblem(null)
    setData<RequestType[]>(key, (l) => l?.map((x) => ({ ...x, position: order.findIndex((o) => o.id === x.id) === -1 ? x.position : order.findIndex((o) => o.id === x.id) })))
    try {
      for (const [position, type] of order.entries()) if (type.position !== position) replace(await api.patchRequestType(app.slug, type.id, { position }))
    } catch (e) {
      setProblem(errorMessage(e))
      load(key, () => api.requestTypes(app.slug)).catch(() => {})
    } finally {
      setMoving(false)
    }
  }

  const archive = async (type: RequestType, archived: boolean) => {
    setProblem(null)
    try {
      replace(await api.patchRequestType(app.slug, type.id, { archived }))
    } catch (e) {
      setProblem(errorMessage(e))
    }
  }

  return (
    <div className="request-types">
      <div className="settings-heading">
        <h1>{t("types.title")}</h1>
        {editing === null && (
          <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setEditing("new")}>
            {t("types.create")}
          </Button>
        )}
      </div>
      <p className="settings-lede">{t("types.lede")}</p>
      {problem && <p className="field-error">{problem}</p>}

      {editing === "new" && (
        <TypeEditor
          app={app}
          agents={agents}
          settings={settings}
          onCancel={() => setEditing(null)}
          onSaved={(next) => {
            replace(next)
            setEditing(null)
          }}
        />
      )}

      {/* Rows wait for the list, so nothing below the heading moves when it arrives */}
      {ready && (active.length > 0 || editing !== "new") && (
        <section className="box">
          {active.length === 0 && editing !== "new" && <div className="box-empty">{t("types.none")}</div>}
          {active.map((type, i) =>
            editing === type.id ? (
              <div key={type.id} className="box-row type-row-editing">
                <TypeEditor
                  app={app}
                  agents={agents}
                  settings={settings}
                  type={type}
                  onCancel={() => setEditing(null)}
                  onSaved={(next) => {
                    replace(next)
                    setEditing(null)
                  }}
                />
              </div>
            ) : (
              <TypeRow
                key={type.id}
                type={type}
                route={routeName(type.route, agents, settings, t("types.group"))}
                first={i === 0}
                last={i === active.length - 1}
                busy={moving}
                onMove={(by) => void move(i, by)}
                onEdit={() => setEditing(type.id)}
                onArchive={() => void archive(type, true)}
              />
            ),
          )}
        </section>
      )}
      {!ready && !error && <div className="box"><div className="box-row skeleton-row" /></div>}
      {!!error && !list && <p className="field-error">{errorMessage(error)}</p>}

      {ready && archived.length > 0 && (
        <div className="type-archived">
          <button type="button" className="link-button" onClick={() => setShowArchived(!showArchived)} aria-expanded={showArchived}>
            {showArchived ? t("types.hideArchived") : t("types.showArchived", { count: archived.length })}
          </button>
          {showArchived && (
            <section className="box">
              {archived.map((type) => (
                <div key={type.id} className="box-row settings-row type-row" data-archived="">
                  <div className="settings-row-main">
                    <div className="type-row-name">
                      {type.name}
                      <span className="api-kind-badge">{t("types.archived")}</span>
                    </div>
                    {type.description && <div className="issue-meta">{type.description}</div>}
                  </div>
                  <Button size="small" onClick={() => void archive(type, false)}>
                    {t("types.restore")}
                  </Button>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

function TypeRow({
  type,
  route,
  first,
  last,
  busy,
  onMove,
  onEdit,
  onArchive,
}: {
  type: RequestType
  route: string | null
  first: boolean
  last: boolean
  busy: boolean
  onMove: (by: -1 | 1) => void
  onEdit: () => void
  onArchive: () => void
}) {
  const t = useT()
  const meta = [
    t("types.fieldCount", { count: type.fields.length }),
    route ? t("types.routedTo", { name: route }) : t("types.unrouted"),
    type.autonomy && t(`autonomy.${type.autonomy}`),
  ].filter(Boolean)
  return (
    <div className="box-row settings-row type-row">
      <div className="type-order">
        <Button iconOnly size="small" variant="ghost-muted" icon={<ArrowUpIcon size={14} />} aria-label={t("types.moveUp", { name: type.name })} title={t("types.moveUp", { name: type.name })} disabled={first || busy} onClick={() => onMove(-1)} />
        <Button
          iconOnly
          size="small"
          variant="ghost-muted"
          icon={<ArrowUpIcon size={14} style={{ transform: "rotate(180deg)" }} />}
          aria-label={t("types.moveDown", { name: type.name })}
          title={t("types.moveDown", { name: type.name })}
          disabled={last || busy}
          onClick={() => onMove(1)}
        />
      </div>
      <div className="settings-row-main">
        <div className="type-row-name">{type.name}</div>
        {type.description && <div className="issue-meta">{type.description}</div>}
        <div className="issue-meta">{meta.join(" · ")}</div>
      </div>
      <div className="row type-row-actions">
        <Button size="small" onClick={onEdit}>
          {t("types.edit")}
        </Button>
        <Button size="small" onClick={onArchive}>
          {t("types.archive")}
        </Button>
      </div>
    </div>
  )
}

/** Create or edit one type: name, description, verification, fields, routing and the agent's mode. */
function TypeEditor({
  app,
  type,
  agents,
  settings,
  onCancel,
  onSaved,
}: {
  app: AppDetail
  type?: RequestType
  agents: AppAgent[] | undefined
  settings: AppSettings | undefined
  onCancel: () => void
  onSaved: (t: RequestType) => void
}) {
  const t = useT()
  const id = type?.id ?? "new"
  const [name, setName] = useState(type?.name ?? "")
  const [description, setDescription] = useState(type?.description ?? "")
  const [verify, setVerify] = useState(type?.require_verification ?? false)
  const [fields, setFields] = useState<Draft[]>(() => (type?.fields ?? []).map(draftOf))
  const [route, setRoute] = useState(() => routeValue(type?.route))
  // A type routed to a group (set elsewhere; groups can't be picked here yet) keeps that route unless changed
  const savedGroup = type?.route && "group" in type.route ? routeValue(type.route) : null
  const [autonomy, setAutonomy] = useState<Autonomy>(type?.autonomy ?? app.helpdesk.default_autonomy ?? "suggest")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  // Agents that can be assigned (responder and up) and members who joined
  const eligible = (agents ?? []).filter((a) => a.role !== "viewer")
  const members = (settings?.members ?? []).filter((m) => m.joined)

  const problems = fieldProblems(fields)
  const update = (uid: string, patch: Partial<Draft>) =>
    setFields((list) =>
      list.map((f) => {
        if (f.uid !== uid) return f
        const next = { ...f, ...patch }
        if (patch.label !== undefined && next.autoKey) next.key = keyFrom(patch.label)
        if (patch.key !== undefined) next.autoKey = false
        if (next.kind !== "email" || next.internal) next.verify = false
        return next
      }),
    )
  const moveField = (index: number, by: -1 | 1) =>
    setFields((list) => {
      const next = [...list]
      const [item] = next.splice(index, 1)
      next.splice(index + by, 0, item!)
      return next
    })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setChecked(true)
    if (!name.trim()) return setError(t("types.errorName"))
    if (problems.size) return setError(t("types.errorFields"))
    setBusy(true)
    setError(null)
    const target = routeOf(route)
    const input: RequestTypeInput = {
      name: name.trim(),
      description: description.trim(),
      fields: fields.map(fieldOf),
      require_verification: verify,
      route: target,
      autonomy,
    }
    try {
      onSaved(type ? await api.patchRequestType(app.slug, type.id, input) : await api.createRequestType(app.slug, input))
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="type-editor" onSubmit={submit} noValidate>
      <div className="field">
        <label className="field-label" htmlFor={`type-name-${id}`}>
          {t("types.name")}
        </label>
        <div className="input" data-invalid={checked && !name.trim() ? "" : undefined}>
          <input id={`type-name-${id}`} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("types.namePlaceholder")} maxLength={120} autoFocus autoComplete="off" />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`type-description-${id}`}>
          {t("types.description")}
        </label>
        <div className="input">
          <input id={`type-description-${id}`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("types.descriptionPlaceholder")} maxLength={2000} autoComplete="off" />
        </div>
      </div>
      <label className="visibility" htmlFor={`type-verify-${id}`}>
        <input id={`type-verify-${id}`} type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />
        <span className="visibility-text">
          <span className="visibility-title">{t("types.requireVerification")}</span>
          <span className="visibility-hint">{t("types.requireVerificationText")}</span>
        </span>
      </label>

      <fieldset className="type-fields">
        <legend className="field-label">{t("types.fields")}</legend>
        <p className="api-hint">{fields.length ? t("types.fieldsHint") : t("types.noFields")}</p>
        {fields.map((f, i) => (
          <FieldEditor
            key={f.uid}
            field={f}
            problems={checked ? (problems.get(f.uid) ?? []) : []}
            first={i === 0}
            last={i === fields.length - 1}
            onChange={(patch) => update(f.uid, patch)}
            onMove={(by) => moveField(i, by)}
            onRemove={() => setFields((list) => list.filter((x) => x.uid !== f.uid))}
          />
        ))}
        <div>
          <Button
            size="small"
            icon={<PlusIcon size={14} />}
            onClick={() => setFields((list) => [...list, { uid: `f${++seq}`, key: "", label: "", kind: "text", required: false, optionsText: "", autoKey: true }])}
          >
            {t("types.addField")}
          </Button>
        </div>
      </fieldset>

      <div className="field">
        <label className="field-label" htmlFor={`type-route-${id}`}>
          {t("types.routing")}
        </label>
        <select id={`type-route-${id}`} className="select" value={route} onChange={(e) => setRoute(e.target.value)}>
          <option value="">{t("types.routeNobody")}</option>
          {savedGroup && <option value={savedGroup}>{t("types.group")}</option>}
          {eligible.length > 0 && (
            <optgroup label={t("types.agents")}>
              {eligible.map((a) => (
                <option key={a.id} value={`agent:${a.id}`}>
                  {a.client_name}
                </option>
              ))}
            </optgroup>
          )}
          {members.length > 0 && (
            <optgroup label={t("types.members")}>
              {members.map((m) => (
                <option key={m.id} value={`member:${m.email}`}>
                  {m.name ? `${m.name} (${m.email})` : m.email}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      <div className="field">
        <span className="field-label">{t("types.autonomy")}</span>
        <AutonomyChoice name={`type-autonomy-${id}`} value={autonomy} onChange={setAutonomy} label={t("types.autonomy")} />
      </div>

      {/* "Check the fields" goes once they're fixed; the name's message once there's a name */}
      {error && !(error === t("types.errorFields") && !problems.size) && !(error === t("types.errorName") && name.trim()) && <p className="field-error">{error}</p>}
      <div className="api-actions">
        <Button variant="invisible" onClick={onCancel} disabled={busy}>
          {tc("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t("types.saving") : t("types.save")}
        </Button>
      </div>
    </form>
  )
}

type Problem = "label" | "key" | "options"

/** Every field's problems, by its draft id: a label, a well-formed unique key, and options for choices. */
function fieldProblems(fields: Draft[]) {
  const out = new Map<string, Problem[]>()
  const seen = new Map<string, number>()
  for (const f of fields) seen.set(f.key, (seen.get(f.key) ?? 0) + 1)
  for (const f of fields) {
    const list: Problem[] = []
    if (!f.label.trim()) list.push("label")
    if (!keyShape.test(f.key) || seen.get(f.key)! > 1) list.push("key")
    if (f.kind === "select") {
      const options = f.optionsText
        .split("\n")
        .map((o) => o.trim())
        .filter(Boolean)
      if (!options.length || new Set(options).size !== options.length) list.push("options")
    }
    if (list.length) out.set(f.uid, list)
  }
  return out
}

function FieldEditor({
  field,
  problems,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  field: Draft
  problems: Problem[]
  first: boolean
  last: boolean
  onChange: (patch: Partial<Draft>) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const t = useT()
  const id = field.uid
  const name = field.label.trim() || t("field.untitled")
  return (
    <div className="field-editor" role="group" aria-label={name}>
      <div className="field-editor-head">
        <div className="field">
          <label className="field-label" htmlFor={`${id}-label`}>
            {t("field.label")}
          </label>
          <div className="input" data-invalid={problems.includes("label") ? "" : undefined}>
            <input id={`${id}-label`} value={field.label} onChange={(e) => onChange({ label: e.target.value })} placeholder={t("field.labelPlaceholder")} maxLength={120} autoComplete="off" />
          </div>
        </div>
        <div className="field field-editor-kind">
          <label className="field-label" htmlFor={`${id}-kind`}>
            {t("field.kind")}
          </label>
          <select id={`${id}-kind`} className="select" value={field.kind} onChange={(e) => onChange({ kind: e.target.value as RequestField["kind"] })}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {t(`field.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field-editor-tools">
          <Button iconOnly size="small" variant="ghost-muted" icon={<ArrowUpIcon size={14} />} aria-label={t("field.moveUp", { label: name })} title={t("field.moveUp", { label: name })} disabled={first} onClick={() => onMove(-1)} />
          <Button
            iconOnly
            size="small"
            variant="ghost-muted"
            icon={<ArrowUpIcon size={14} style={{ transform: "rotate(180deg)" }} />}
            aria-label={t("field.moveDown", { label: name })}
            title={t("field.moveDown", { label: name })}
            disabled={last}
            onClick={() => onMove(1)}
          />
          <Button iconOnly size="small" variant="ghost-muted" icon={<XIcon size={14} />} aria-label={t("field.remove", { label: name })} title={t("field.remove", { label: name })} onClick={onRemove} />
        </div>
      </div>
      <div className="field">
        <label className="field-label" htmlFor={`${id}-key`}>
          {t("field.key")}
        </label>
        <div className="input field-editor-key" data-invalid={problems.includes("key") ? "" : undefined}>
          <input id={`${id}-key`} className="mono" value={field.key} onChange={(e) => onChange({ key: e.target.value.toLowerCase() })} maxLength={40} spellCheck={false} autoCapitalize="none" autoComplete="off" />
        </div>
        <p className={problems.includes("key") ? "field-error" : "api-hint"}>{problems.includes("key") ? t("field.errorKey") : t("field.keyHint")}</p>
      </div>
      {field.kind === "select" && (
        <div className="field">
          <label className="field-label" htmlFor={`${id}-options`}>
            {t("field.options")}
          </label>
          <textarea id={`${id}-options`} className="textarea" rows={3} value={field.optionsText} onChange={(e) => onChange({ optionsText: e.target.value })} aria-invalid={problems.includes("options")} />
          <p className={problems.includes("options") ? "field-error" : "api-hint"}>{problems.includes("options") ? t("field.errorOptions") : t("field.optionsHint")}</p>
        </div>
      )}
      <div className="field">
        <label className="field-label" htmlFor={`${id}-help`}>
          {t("field.help")}
        </label>
        <div className="input">
          <input id={`${id}-help`} value={field.help ?? ""} onChange={(e) => onChange({ help: e.target.value })} placeholder={t("field.helpPlaceholder")} maxLength={512} autoComplete="off" />
        </div>
      </div>
      <div className="field-editor-flags">
        <label className="checkbox">
          <input type="checkbox" checked={field.required} onChange={(e) => onChange({ required: e.target.checked })} />
          {t("field.required")}
        </label>
        {field.kind === "email" && !field.internal && (
          <label className="checkbox">
            <input type="checkbox" checked={!!field.verify} onChange={(e) => onChange({ verify: e.target.checked })} />
            {t("field.verify")}
          </label>
        )}
        <label className="checkbox" title={t("field.internalHint")}>
          <input type="checkbox" checked={!!field.internal} onChange={(e) => onChange({ internal: e.target.checked })} />
          {t("field.internal")}
        </label>
      </div>
      {field.internal && <p className="api-hint">{t("field.internalHint")}</p>}
    </div>
  )
}
