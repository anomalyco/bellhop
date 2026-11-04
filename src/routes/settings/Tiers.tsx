import { useState, type CSSProperties, type FormEvent } from "react"
import type { AppDetail, AppSettings, Person, Tier, TierRules } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { invalidate, setData, useResource } from "../../lib/cache"
import { atLeast, canSetup } from "../../lib/roles"
import { Time } from "../../lib/time"
import { ActorAvatar, actorName } from "../../ui/Actor"
import { ColorField, randomColor, validColor } from "../../ui/ColorField"
import { ChevronDownIcon, PlusIcon } from "../../ui/icons"
import { Menu, MenuItem } from "../../ui/Menu"
import { Avatar, Button, Label } from "../../ui/primitives"
import "../../styles/tiers.css"

const noRules: TierRules = { label_ids: [], assignee_id: null, private: false, agents_reply: true }

/** Settings → Tiers: statuses for people (VIP, Pro, Beta) with what happens when they open an issue. Admins edit
 *  tiers; members see them and add or remove people. Only the team and agents ever see tiers. */
export function Tiers({ app }: { app: AppDetail }) {
  const slug = app.slug
  const admin = canSetup(app.role)
  const { data: tiers, error } = useResource<Tier[]>(keys.tiers(slug), () => api.tiers(slug), 5_000)
  const { data: settings } = useResource<AppSettings>(keys.settings(slug), () => api.settings(slug), 10_000)
  const [editing, setEditing] = useState<string | "new" | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const sorted = [...(tiers ?? [])].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
  const assignees = (settings?.members ?? []).filter((m) => m.joined && atLeast(m.role, "member"))

  const store = (tier: Tier) =>
    setData<Tier[]>(keys.tiers(slug), (list) => (list?.some((t) => t.id === tier.id) ? list.map((t) => (t.id === tier.id ? tier : t)) : [...(list ?? []), tier]))

  return (
    <div>
      <div className="settings-heading">
        <h1>Tiers</h1>
        {admin && editing !== "new" && (
          <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setEditing("new")}>
            New tier
          </Button>
        )}
      </div>
      <p className="settings-lede">
        Give people a status, like VIP, Pro or Beta, and decide what happens when they open an issue. Only the team and agents see tiers.
      </p>
      {!admin && <p className="settings-readonly">Only admins and owners can change tiers. You can add and remove people.</p>}
      <section className="box tiers">
        {editing === "new" && (
          <TierForm
            app={app}
            assignees={assignees}
            onDone={(tier) => {
              if (tier) {
                store(tier)
                setOpen(tier.id)
              }
              setEditing(null)
            }}
          />
        )}
        {!tiers && !error && <div className="box-row skeleton-row" />}
        {!!error && !tiers && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {tiers?.length === 0 && editing !== "new" && <div className="box-empty">No tiers yet.{admin ? " Create one for the people you look after first." : ""}</div>}
        {sorted.map((tier) =>
          editing === tier.id ? (
            <TierForm
              key={tier.id}
              app={app}
              tier={tier}
              assignees={assignees}
              onDone={(next) => {
                if (next) store(next)
                setEditing(null)
              }}
            />
          ) : (
            <TierRow
              key={tier.id}
              app={app}
              tier={tier}
              admin={admin}
              assigneeName={assignees.find((m) => m.id === tier.rules.assignee_id)?.name ?? null}
              open={open === tier.id}
              onToggle={() => setOpen(open === tier.id ? null : tier.id)}
              onEdit={() => setEditing(tier.id)}
              onDeleted={() => setData<Tier[]>(keys.tiers(slug), (list) => list?.filter((t) => t.id !== tier.id))}
            />
          ),
        )}
      </section>
    </div>
  )
}

/** "Adds bug, urgent · Assigns Ryan · Private · Humans only" */
function rulesSummary(app: AppDetail, rules: TierRules, assigneeName: string | null) {
  const parts: string[] = []
  const labels = app.labels.filter((l) => rules.label_ids.includes(l.id)).map((l) => l.name)
  if (labels.length) parts.push(`Adds ${labels.join(", ")}`)
  if (rules.assignee_id) parts.push(`Assigns ${assigneeName ?? "a teammate"}`)
  if (rules.private) parts.push("Private")
  if (!rules.agents_reply) parts.push("Humans only")
  return parts.length ? parts.join(" · ") : "No special handling"
}

function TierRow({
  app,
  tier,
  admin,
  assigneeName,
  open,
  onToggle,
  onEdit,
  onDeleted,
}: {
  app: AppDetail
  tier: Tier
  admin: boolean
  assigneeName: string | null
  open: boolean
  onToggle: () => void
  onEdit: () => void
  onDeleted: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteTier(app.slug, tier.id)
      invalidate(`people:${app.slug}:`)
      onDeleted()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="tier" data-open={open || undefined} style={{ "--tier": `#${tier.color}` } as CSSProperties}>
      <div className="box-row tier-row">
        <button type="button" className="tier-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="tier-swatch" aria-hidden="true" />
          <span className="tier-main">
            <span className="tier-name-line">
              <span className="tier-name">{tier.name}</span>
              <span className="tier-count">{tier.count === 1 ? "1 person" : `${tier.count} people`}</span>
            </span>
            {tier.description && <span className="tier-description">{tier.description}</span>}
            <span className="tier-rules">{rulesSummary(app, tier.rules, assigneeName)}</span>
          </span>
          <ChevronDownIcon size={14} />
        </button>
        {admin &&
          (confirming ? (
            <div className="tier-confirm">
              <span className="tier-confirm-text">
                Delete {tier.name}? {tier.count ? `${tier.count === 1 ? "1 person loses" : `${tier.count} people lose`} the tier.` : ""}
              </span>
              <Button size="small" variant="invisible" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button size="small" variant="danger" onClick={remove} disabled={busy}>
                Delete
              </Button>
            </div>
          ) : (
            <div className="settings-row-actions tier-actions">
              <Button size="small" variant="invisible" onClick={onEdit}>
                Edit
              </Button>
              <Button size="small" variant="invisible" onClick={() => setConfirming(true)}>
                Delete
              </Button>
            </div>
          ))}
      </div>
      {error && <p className="field-error tier-error">{error}</p>}
      {open && <TierPeople slug={app.slug} tier={tier} />}
    </div>
  )
}

/** A tier's people, each removable, and "Add by email" (it applies when they sign in, like an invite). */
function TierPeople({ slug, tier }: { slug: string; tier: Tier }) {
  const key = keys.people(slug, tier.id)
  const { data: people, error } = useResource<Person[]>(key, () => api.people(slug, { tier: tier.id }), 5_000)
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const refresh = () => {
    invalidate(`people:${slug}:`)
    invalidate(keys.tiers(slug))
  }
  const add = async (e: FormEvent) => {
    e.preventDefault()
    if (!email.trim() || busy) return
    setBusy("add")
    setProblem(null)
    try {
      const person = await api.setTier(slug, { email: email.trim() }, tier.id)
      setData<Person[]>(key, (list) => [person, ...(list ?? []).filter((p) => p.email !== person.email || !person.email)])
      setEmail("")
      refresh()
    } catch (err) {
      setProblem(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }
  const remove = async (p: Person, id: string) => {
    setBusy(id)
    setProblem(null)
    try {
      await api.setTier(slug, p.actor ? { actor_id: p.actor.id } : { email: p.email! }, null)
      setData<Person[]>(key, (list) => list?.filter((x) => x !== p))
      refresh()
    } catch (err) {
      setProblem(errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="tier-people">
      <form className="tier-add" onSubmit={add}>
        <div className="input" data-size="small">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" aria-label={`Add to ${tier.name} by email`} autoComplete="off" />
        </div>
        <Button type="submit" size="small" disabled={!email.trim() || busy === "add"}>
          {busy === "add" ? "Adding…" : "Add by email"}
        </Button>
      </form>
      <p className="tier-add-hint">Accounts get the tier when they sign in with that email. Guests get it from their comments ("…" → Set tier).</p>
      {problem && <p className="field-error">{problem}</p>}
      {!people && !error && <div className="tier-person skeleton-row" />}
      {!!error && !people && <p className="muted-text">{errorMessage(error)}</p>}
      {people?.length === 0 && <p className="tier-empty">No one has this tier yet.</p>}
      {people?.map((p, i) => {
        const id = p.actor?.id ?? p.email ?? String(i)
        return (
          <div key={id} className="tier-person">
            {p.actor ? <ActorAvatar actor={p.actor} size={24} /> : <Avatar seed={p.email ?? id} name={p.email ?? "?"} size={24} />}
            <div className="tier-person-main">
              <span className="tier-person-name">{p.actor ? actorName(p.actor) : p.email}</span>
              <span className="tier-person-meta">
                {p.actor ? (
                  <>
                    {p.actor.type === "guest" ? "Guest" : (p.email ?? "Account")}
                    {` · ${p.issue_count === 1 ? "1 issue" : `${p.issue_count} issues`}`}
                    {p.last_seen_at && (
                      <>
                        {" · seen "}
                        <Time iso={p.last_seen_at} />
                      </>
                    )}
                  </>
                ) : (
                  "Hasn't signed in yet"
                )}
              </span>
            </div>
            <Button size="small" variant="invisible" onClick={() => remove(p, id)} disabled={busy === id}>
              Remove
            </Button>
          </div>
        )
      })}
    </div>
  )
}

/** Create or edit a tier: name, colour, description, then what happens when someone with it opens an issue. */
function TierForm({
  app,
  tier,
  assignees,
  onDone,
}: {
  app: AppDetail
  tier?: Tier
  assignees: AppSettings["members"]
  onDone: (tier: Tier | null) => void
}) {
  const [name, setName] = useState(tier?.name ?? "")
  const [color, setColor] = useState(tier?.color ?? randomColor())
  const [description, setDescription] = useState(tier?.description ?? "")
  const [rules, setRules] = useState<TierRules>(tier?.rules ?? noRules)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const id = tier?.id ?? "new"
  const chosen = app.labels.filter((l) => rules.label_ids.includes(l.id))
  const assignee = assignees.find((m) => m.id === rules.assignee_id)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !validColor(color) || saving) return
    setSaving(true)
    setError(null)
    try {
      const input = { name: name.trim(), color: color.toLowerCase(), description: description.trim(), rules }
      onDone(tier ? await api.patchTier(app.slug, tier.id, input) : await api.createTier(app.slug, input))
    } catch (err) {
      setError(errorMessage(err))
      setSaving(false)
    }
  }

  return (
    <form className="box-row tier-form" onSubmit={save}>
      <div className="tier-form-grid">
        <div className="field">
          <label className="field-label" htmlFor={`tier-name-${id}`}>
            Name
          </label>
          <div className="input">
            <input id={`tier-name-${id}`} value={name} onChange={(e) => setName(e.target.value)} placeholder="VIP" required maxLength={40} autoFocus />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`tier-color-${id}`}>
            Colour
          </label>
          <ColorField id={`tier-color-${id}`} value={color} onChange={setColor} />
        </div>
        <div className="field tier-form-wide">
          <label className="field-label" htmlFor={`tier-description-${id}`}>
            Description
          </label>
          <div className="input">
            <input
              id={`tier-description-${id}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional: who gets it and why"
              maxLength={200}
            />
          </div>
        </div>
      </div>

      <fieldset className="tier-rules-form">
        <legend className="field-label">When they open an issue</legend>
        <div className="tier-rule">
          <span className="tier-rule-label">Add labels</span>
          <div className="tier-rule-value">
            {chosen.map((l) => (
              <Label key={l.id} name={l.name} color={l.color} />
            ))}
            <Menu
              align="start"
              width={260}
              trigger={(p) => (
                <Button size="small" {...p} disabled={!app.labels.length}>
                  {chosen.length ? "Change" : app.labels.length ? "Choose labels" : "No labels yet"}
                </Button>
              )}
            >
              {() => (
                <div className="menu-scroll">
                  {app.labels.map((l) => {
                    const on = rules.label_ids.includes(l.id)
                    return (
                      <MenuItem
                        key={l.id}
                        checked={on}
                        description={l.description || undefined}
                        onSelect={() => setRules((r) => ({ ...r, label_ids: on ? r.label_ids.filter((x) => x !== l.id) : [...r.label_ids, l.id] }))}
                      >
                        <span className="label-dot" style={{ background: `#${l.color}` }} />
                        {l.name}
                      </MenuItem>
                    )
                  })}
                </div>
              )}
            </Menu>
          </div>
        </div>
        <div className="tier-rule">
          <span className="tier-rule-label">Assign to</span>
          <div className="tier-rule-value">
            <Menu
              align="start"
              width={260}
              trigger={(p) => (
                <button type="button" className="btn tier-assignee" data-variant="default" data-size="small" {...p}>
                  <span className="tier-assignee-name">{assignee ? assignee.name || assignee.email : "No one"}</span>
                  <ChevronDownIcon size={12} />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    checked={!rules.assignee_id}
                    onSelect={() => {
                      setRules((r) => ({ ...r, assignee_id: null }))
                      close()
                    }}
                  >
                    No one
                  </MenuItem>
                  {assignees.map((m) => (
                    <MenuItem
                      key={m.id}
                      checked={rules.assignee_id === m.id}
                      description={m.email}
                      onSelect={() => {
                        setRules((r) => ({ ...r, assignee_id: m.id }))
                        close()
                      }}
                    >
                      {m.name || m.email}
                    </MenuItem>
                  ))}
                </>
              )}
            </Menu>
          </div>
        </div>
        <label className="checkbox tier-check">
          <input type="checkbox" checked={rules.private} onChange={(e) => setRules((r) => ({ ...r, private: e.target.checked }))} />
          <span>
            Make their issues private
            <span className="tier-check-hint">Only the team and they can see them, whatever the workspace's default.</span>
          </span>
        </label>
        <label className="checkbox tier-check">
          <input type="checkbox" checked={rules.agents_reply} onChange={(e) => setRules((r) => ({ ...r, agents_reply: e.target.checked }))} />
          <span>
            Agents can reply
            <span className="tier-check-hint">Off: on their issues, agents can only leave internal notes, and a person on the team answers.</span>
          </span>
        </label>
      </fieldset>

      {error && <p className="field-error">{error}</p>}
      <div className="tier-form-actions">
        <Button variant="invisible" onClick={() => onDone(null)}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving || !name.trim() || !validColor(color)}>
          {saving ? "Saving…" : tier ? "Save" : "Create tier"}
        </Button>
      </div>
    </form>
  )
}
