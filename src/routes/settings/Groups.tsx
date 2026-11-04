import { useMemo, useState, type FormEvent } from "react"
import type { AppDetail, AppSettings, Group, GroupInput, Member } from "../../../shared/api"
import { t as tc } from "../../i18n/core"
import { formatList, getLocale } from "../../i18n"
import { useT } from "../../i18n/helpdesk"
import { api, errorMessage, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { PlusIcon } from "../../ui/icons"
import { Button } from "../../ui/primitives"
import { AvailabilitySwitch, putGroup, useGroups } from "../../ui/helpdesk/Handoff"
import "../../styles/agents.css"
import "../../styles/features.css"
import "../../styles/helpdesk.css"

/** Sunday-based day numbers (the API's), shown Monday first. */
const weekOrder = [1, 2, 3, 4, 5, 6, 0]
const dayName = (n: number, style: "short" | "long" = "short") =>
  new Intl.DateTimeFormat(getLocale(), { weekday: style, timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + n)))
const windowPresets = [15, 30, 60, 120, 240]
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
const zones = () => {
  try {
    return Intl.supportedValuesOf("timeZone")
  } catch {
    return [browserZone()]
  }
}
/** Members who can take requests: member role or higher, and joined. */
const eligible = (members: Member[] | undefined) => (members ?? []).filter((m) => m.joined && ["owner", "admin", "member"].includes(m.role))
const memberName = (m: Member | undefined, id: string) => (m ? (m.name ?? m.email) : id)

function useWindowText() {
  const t = useT()
  return (minutes: number) => (minutes % 60 === 0 && minutes >= 60 ? t("groups.hoursShort", { count: minutes / 60 }) : t("groups.minutes", { count: minutes }))
}

/**
 * Settings → Groups (admins, help desks): the teams requests escalate to. Each has members, how the next person is
 * picked, working hours and a response window; the list says who's available now. Your own availability sits on top.
 */
export function Groups({ app }: { app: AppDetail }) {
  const t = useT()
  const { data: list, error } = useGroups(app)
  const { data: settings } = useResource<AppSettings>(keys.settings(app.slug), () => api.settings(app.slug), 30_000)
  const [editing, setEditing] = useState<string | null>(null)
  const ready = !!list && !!settings
  return (
    <div className="groups-settings">
      <div className="settings-heading">
        <h1>{t("groups.title")}</h1>
        {editing === null && (
          <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setEditing("new")}>
            {t("groups.create")}
          </Button>
        )}
      </div>
      <p className="settings-lede">{t("groups.lede")}</p>
      <div className="box groups-availability">
        <div className="box-row">
          <AvailabilitySwitch app={app} />
        </div>
      </div>
      {editing === "new" && settings && (
        <GroupEditor
          app={app}
          members={settings.members}
          onCancel={() => setEditing(null)}
          onSaved={(g) => {
            putGroup(app.slug, g)
            setEditing(null)
          }}
        />
      )}
      {ready && (list.length > 0 || editing !== "new") && (
        <section className="box">
          {list.length === 0 && <div className="box-empty">{t("groups.none")}</div>}
          {list.map((g) =>
            editing === g.id ? (
              <div key={g.id} className="box-row group-row-editing">
                <GroupEditor
                  app={app}
                  group={g}
                  members={settings.members}
                  onCancel={() => setEditing(null)}
                  onSaved={(next) => {
                    putGroup(app.slug, next)
                    setEditing(null)
                  }}
                />
              </div>
            ) : (
              <GroupRow key={g.id} app={app} group={g} members={settings.members} onEdit={() => setEditing(g.id)} />
            ),
          )}
        </section>
      )}
      {!ready && !error && (
        <div className="box">
          <div className="box-row skeleton-row" />
        </div>
      )}
      {!!error && !list && <p className="field-error">{errorMessage(error)}</p>}
    </div>
  )
}

function GroupRow({ app, group, members, onEdit }: { app: AppDetail; group: Group; members: Member[]; onEdit: () => void }) {
  const t = useT()
  const windowText = useWindowText()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const byId = new Map(members.map((m) => [m.id, m]))
  const h = group.hours
  const hours = h ? `${weekOrder.filter((d) => h.days.includes(d)).map((d) => dayName(d)).join(", ")} · ${h.start}–${h.end} (${h.timezone})` : t("groups.alwaysOn")
  const meta = [t("groups.memberCount", { count: group.member_ids.length }), t(`groups.${group.strategy}`), hours, group.response_minutes ? t("groups.windowSummary", { time: windowText(group.response_minutes) }) : null].filter(Boolean)
  // Off duty, the API lists nobody available; with hours set and nobody listed, say so
  const available = group.available_ids.map((id) => memberName(byId.get(id), id))
  const availability = available.length ? t("groups.availableNow", { names: formatList(available) }) : h ? t("groups.offHours") : t("groups.nobodyAvailable")
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteGroup(app.slug, group.id)
      putGroup(app.slug, { id: group.id, deleted: true })
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="box-row settings-row group-row">
      <div className="settings-row-main">
        <div className="group-row-name">{group.name}</div>
        <div className="issue-meta">{meta.join(" · ")}</div>
        <div className="issue-meta group-available" data-none={!available.length || undefined}>
          {availability}
        </div>
        {confirming && (
          <div className="group-confirm" role="group" aria-label={t("groups.deleteTitle", { name: group.name })}>
            <p className="group-confirm-title">{t("groups.deleteTitle", { name: group.name })}</p>
            <p className="api-hint">{t("groups.deleteText")}</p>
            <div className="api-actions">
              <Button size="small" variant="invisible" onClick={() => setConfirming(false)} disabled={busy} autoFocus>
                {tc("common.cancel")}
              </Button>
              <Button size="small" variant="danger" onClick={() => void remove()} disabled={busy}>
                {t("groups.deleteConfirm")}
              </Button>
            </div>
          </div>
        )}
        {error && <p className="field-error">{error}</p>}
      </div>
      {!confirming && (
        <div className="row group-row-actions">
          <Button size="small" onClick={onEdit}>
            {t("groups.edit")}
          </Button>
          <Button size="small" onClick={() => setConfirming(true)}>
            {t("groups.delete")}
          </Button>
        </div>
      )}
    </div>
  )
}

type Problem = "name" | "members" | "days" | "times" | "window"

function GroupEditor({ app, group, members, onCancel, onSaved }: { app: AppDetail; group?: Group; members: Member[]; onCancel: () => void; onSaved: (g: Group) => void }) {
  const t = useT()
  const windowText = useWindowText()
  const id = group?.id ?? "new"
  const people = eligible(members)
  const [name, setName] = useState(group?.name ?? "")
  const [picked, setPicked] = useState<string[]>(group?.member_ids ?? [])
  const [strategy, setStrategy] = useState<Group["strategy"]>(group?.strategy ?? "round_robin")
  const [scheduled, setScheduled] = useState(!!group?.hours)
  const [zone, setZone] = useState(group?.hours?.timezone ?? browserZone())
  const [days, setDays] = useState<number[]>(group?.hours?.days ?? [1, 2, 3, 4, 5])
  const [start, setStart] = useState(group?.hours?.start ?? "09:00")
  const [end, setEnd] = useState(group?.hours?.end ?? "17:00")
  const initialWindow = group?.response_minutes ?? null
  const [windowMode, setWindowMode] = useState<string>(initialWindow === null ? "off" : windowPresets.includes(initialWindow) ? String(initialWindow) : "custom")
  const [custom, setCustom] = useState(initialWindow !== null && !windowPresets.includes(initialWindow) ? String(initialWindow) : "45")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  // UTC first (the browser's list leaves it out), and a saved zone the list lacks stays selectable
  const timezones = useMemo(() => {
    const all = ["UTC", ...zones().filter((z) => z !== "UTC")]
    return all.includes(zone) ? all : [zone, ...all]
  }, [zone])
  const minutes = windowMode === "off" ? null : windowMode === "custom" ? Number(custom) : Number(windowMode)
  const problems = new Set<Problem>()
  if (!name.trim()) problems.add("name")
  if (!picked.length) problems.add("members")
  if (scheduled && !days.length) problems.add("days")
  if (scheduled && (start === end || !start || !end)) problems.add("times")
  if (minutes !== null && (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440)) problems.add("window")
  const shown = (p: Problem) => checked && problems.has(p)
  // Members no longer eligible stay listed while they're in the group, so saving doesn't drop them silently
  const listed = [...people, ...picked.filter((x) => !people.some((m) => m.id === x)).map((x) => members.find((m) => m.id === x) ?? ({ id: x, email: x, name: null, avatar_url: null, role: "member", joined: true } as Member))]

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setChecked(true)
    if (problems.size) return
    setBusy(true)
    setError(null)
    const input: GroupInput = {
      name: name.trim(),
      member_ids: picked,
      strategy,
      hours: scheduled ? { timezone: zone, days: [...days].sort(), start, end } : null,
      response_minutes: minutes,
    }
    try {
      onSaved(group ? await api.patchGroup(app.slug, group.id, input) : await api.createGroup(app.slug, input))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="type-editor group-editor" onSubmit={submit} noValidate>
      <div className="field">
        <label className="field-label" htmlFor={`group-name-${id}`}>
          {t("groups.name")}
        </label>
        <div className="input" data-invalid={shown("name") ? "" : undefined}>
          <input id={`group-name-${id}`} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("groups.namePlaceholder")} maxLength={120} autoFocus autoComplete="off" />
        </div>
        {shown("name") && <p className="field-error">{t("groups.errorName")}</p>}
      </div>

      <fieldset className="type-fields">
        <legend className="field-label">{t("groups.members")}</legend>
        <p className="api-hint">{people.length ? t("groups.membersHint") : t("groups.noEligible")}</p>
        <div className="group-members">
          {listed.map((m) => (
            <label key={m.id} className="checkbox group-member">
              <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked((list) => (e.target.checked ? [...list, m.id] : list.filter((x) => x !== m.id)))} />
              <span className="group-member-name">{m.name ?? m.email}</span>
              {m.name && <span className="group-member-email">{m.email}</span>}
            </label>
          ))}
        </div>
        {shown("members") && <p className="field-error">{t("groups.errorMembers")}</p>}
      </fieldset>

      <fieldset className="type-fields">
        <legend className="field-label">{t("groups.strategy")}</legend>
        <div className="autonomy" role="radiogroup" aria-label={t("groups.strategy")}>
          {(["round_robin", "least_busy"] as const).map((s) => (
            <label key={s} className="autonomy-option" data-current={strategy === s || undefined}>
              <input type="radio" name={`group-strategy-${id}`} checked={strategy === s} onChange={() => setStrategy(s)} />
              <span className="autonomy-text">
                <span className="autonomy-title">{t(`groups.${s}`)}</span>
                <span className="autonomy-hint">{t(`groups.${s}Text`)}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="type-fields">
        <legend className="field-label">{t("groups.hours")}</legend>
        <div className="autonomy" role="radiogroup" aria-label={t("groups.hours")}>
          {[false, true].map((on) => (
            <label key={String(on)} className="autonomy-option" data-current={scheduled === on || undefined}>
              <input type="radio" name={`group-hours-${id}`} checked={scheduled === on} onChange={() => setScheduled(on)} />
              <span className="autonomy-text">
                <span className="autonomy-title">{on ? t("groups.scheduled") : t("groups.always")}</span>
                <span className="autonomy-hint">{on ? t("groups.scheduledText") : t("groups.alwaysText")}</span>
              </span>
            </label>
          ))}
        </div>
        {scheduled && (
          <div className="group-hours">
            <div className="field">
              <label className="field-label" htmlFor={`group-zone-${id}`}>
                {t("groups.timezone")}
              </label>
              <select id={`group-zone-${id}`} className="select" value={zone} onChange={(e) => setZone(e.target.value)}>
                {timezones.map((z) => (
                  <option key={z} value={z}>
                    {z.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span className="field-label" id={`group-days-${id}`}>
                {t("groups.days")}
              </span>
              <div className="group-days" role="group" aria-labelledby={`group-days-${id}`}>
                {weekOrder.map((d) => (
                  <label key={d} className="group-day" data-on={days.includes(d) || undefined} title={dayName(d, "long")}>
                    <input type="checkbox" checked={days.includes(d)} aria-label={dayName(d, "long")} onChange={(e) => setDays((list) => (e.target.checked ? [...list, d] : list.filter((x) => x !== d)))} />
                    <span aria-hidden="true">{dayName(d)}</span>
                  </label>
                ))}
              </div>
              {shown("days") && <p className="field-error">{t("groups.errorDays")}</p>}
            </div>
            <div className="group-times">
              <div className="field">
                <label className="field-label" htmlFor={`group-start-${id}`}>
                  {t("groups.start")}
                </label>
                <div className="input" data-invalid={shown("times") ? "" : undefined}>
                  <input id={`group-start-${id}`} type="time" value={start} step={300} onChange={(e) => setStart(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label className="field-label" htmlFor={`group-end-${id}`}>
                  {t("groups.end")}
                </label>
                <div className="input" data-invalid={shown("times") ? "" : undefined}>
                  <input id={`group-end-${id}`} type="time" value={end} step={300} onChange={(e) => setEnd(e.target.value)} />
                </div>
              </div>
            </div>
            {shown("times") ? <p className="field-error">{t("groups.errorTimes")}</p> : start && end && end < start && <p className="api-hint">{t("groups.overnight")}</p>}
          </div>
        )}
      </fieldset>

      <fieldset className="type-fields">
        <legend className="field-label">{t("groups.window")}</legend>
        <p className="api-hint">{t("groups.windowText")}</p>
        <div className="group-window" role="radiogroup" aria-label={t("groups.window")}>
          {["off", ...windowPresets.map(String), "custom"].map((v) => (
            <button key={v} type="button" className="group-chip" role="radio" aria-checked={windowMode === v} onClick={() => setWindowMode(v)}>
              {v === "off" ? t("groups.windowOff") : v === "custom" ? t("groups.windowCustom") : windowText(Number(v))}
            </button>
          ))}
        </div>
        {windowMode === "custom" && (
          <div className="field group-window-custom">
            <label className="field-label" htmlFor={`group-window-${id}`}>
              {t("groups.windowMinutesLabel")}
            </label>
            <div className="input" data-invalid={shown("window") ? "" : undefined}>
              <input id={`group-window-${id}`} type="number" inputMode="numeric" min={5} max={1440} value={custom} onChange={(e) => setCustom(e.target.value)} />
            </div>
          </div>
        )}
        {shown("window") && <p className="field-error">{t("groups.errorWindow")}</p>}
      </fieldset>

      {error && <p className="field-error">{error}</p>}
      <div className="api-actions">
        <Button variant="invisible" onClick={onCancel} disabled={busy}>
          {tc("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? t("groups.saving") : t("groups.save")}
        </Button>
      </div>
    </form>
  )
}
