import { useState, type ReactNode } from "react"
import type { Actor, AppAgent, AppDetail, AppSettings, AuditEntry, AuditPage, SavedReply, Tier } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { setData, useResource } from "../../lib/cache"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { ActorAvatar, ActorName, actorName } from "../../ui/Actor"
import { ChevronDownIcon } from "../../ui/icons"
import { Menu, MenuHeader, MenuItem } from "../../ui/Menu"
import { Button } from "../../ui/primitives"
import { AppLink } from "../../ui/SiteLink"
import "../../styles/insights.css"

/** What each action reads as after the actor's name; `t` is the target as words, `d` the entry's data. */
type Raw = Record<string, unknown> | null
const known = (n: Names, raw: Raw) => !!raw && (typeof raw.email === "string" || !!n.of(String(raw.type), raw.id))
const sentences: Record<string, (t: ReactNode, d: Record<string, unknown>, n: Names, raw: Raw) => ReactNode> = {
  "member.invited": (t, d, n, raw) => <>{known(n, raw) ? <>invited {t}</> : "sent an invitation"}{d.role ? ` as ${d.role}` : ""}</>,
  "member.accepted": (_t, d) => <>accepted an invitation{d.role ? ` as ${d.role}` : ""}</>,
  "member.declined": () => <>declined an invitation</>,
  "member.role_changed": (t, d) => <>changed {t}'s role{change(d)}</>,
  "member.removed": (t, _d, n, raw) => (raw?.type === "invitation" && !known(n, raw) ? <>withdrew an invitation</> : <>removed {t}</>),
  "member.left": () => <>left the workspace</>,
  "app.updated": (_t, d) => <>updated the workspace{fields(d)}</>,
  "app.created": () => <>created the workspace</>,
  "app.ownership_transferred": (t) => <>made {t} an owner</>,
  "agent.created": (t, d) => <>gave {t} access{d.to ? ` as ${d.to}` : ""}</>,
  "agent.access_changed": (t, d) => <>changed {t}'s access{change(d)}</>,
  "agent.updated": (t) => <>updated {t}</>,
  "agent.rotated": (t) => <>rotated {t}'s secret</>,
  "agent.revoked": (t) => <>revoked {t}</>,
  "webhook.updated": (_t, d) => <>{d.enabled === false ? "removed the webhook" : "updated the webhook"}</>,
  "webhook.rotated": () => <>rotated the webhook secret</>,
  "webhook.tested": () => <>sent a test ping</>,
  "webhook.redelivered": () => <>redelivered a webhook</>,
  "label.created": (t) => <>created {t}</>,
  "label.updated": (t) => <>updated {t}</>,
  "label.deleted": (t) => <>deleted {t}</>,
  "template.created": (t) => <>created {t}</>,
  "template.updated": (t) => <>updated {t}</>,
  "template.deleted": (t) => <>deleted {t}</>,
  "saved_reply.created": (t) => <>created {t}</>,
  "saved_reply.updated": (t) => <>updated {t}</>,
  "saved_reply.deleted": (t) => <>deleted {t}</>,
  "tier.created": (t) => <>created {t}</>,
  "tier.updated": (t) => <>updated {t}</>,
  "tier.deleted": (t) => <>deleted {t}</>,
  "tier.assigned": (t, d, n) => (d.tier_id === null ? <>removed the tier from {t}</> : <>set {n.tier(d.tier_id)} on {t}</>),
  "issue.deleted": (t) => <>deleted {t}</>,
  "issue.hidden": (t, d) => <>hid {t}{d.reason ? ` as ${String(d.reason).replace("_", " ")}` : ""}</>,
  "issue.unhidden": (t) => <>unhid {t}</>,
  "issue.transferred": (t, d) => <>moved {t}{d.to ? <> to <span className="mono audit-target">{String(d.to)}</span></> : ""}</>,
  "issue.locked": (t) => <>locked {t}</>,
  "issue.unlocked": (t) => <>unlocked {t}</>,
  "issue.pinned": (t) => <>pinned {t}</>,
  "issue.unpinned": (t) => <>unpinned {t}</>,
  "issue.made_private": (t) => <>made {t} private</>,
  "issue.made_public": (t) => <>made {t} public</>,
  "comment.hidden": (t, d) => <>hid {t}{d.reason ? ` as ${String(d.reason).replace("_", " ")}` : ""}</>,
  "comment.unhidden": (t) => <>unhid {t}</>,
  "comment.deleted": (t) => <>deleted {t}</>,
  "actor.blocked": (t, d) => <>blocked {t}{d.hide_content ? " and hid what they wrote" : ""}</>,
  "actor.unblocked": (t) => <>unblocked {t}</>,
  "import.started": (_t, d) => <>started importing {d.repo ? <span className="mono audit-target">{String(d.repo)}</span> : "a repository"} from GitHub</>,
  "app.exported": () => <>downloaded the workspace export</>,
  "report_key.created": (t) => <>created {t}</>,
  "report_key.revoked": (t) => <>revoked {t}</>,
}

/** The action filter's choices, grouped. */
const actionGroups: { name: string; actions: [string, string][] }[] = [
  {
    name: "People",
    actions: [
      ["member.invited", "Invited"],
      ["member.accepted", "Accepted an invitation"],
      ["member.role_changed", "Role changed"],
      ["member.removed", "Removed"],
      ["member.left", "Left"],
      ["actor.blocked", "Blocked"],
      ["actor.unblocked", "Unblocked"],
      ["tier.assigned", "Tier set"],
    ],
  },
  {
    name: "Agents and integrations",
    actions: [
      ["agent.created", "Agent given access"],
      ["agent.access_changed", "Agent access changed"],
      ["agent.revoked", "Agent revoked"],
      ["webhook.updated", "Webhook updated"],
      ["webhook.rotated", "Webhook secret rotated"],
      ["report_key.created", "Report key created"],
      ["report_key.revoked", "Report key revoked"],
    ],
  },
  {
    name: "Moderation",
    actions: [
      ["issue.hidden", "Issue hidden"],
      ["comment.hidden", "Comment hidden"],
      ["issue.deleted", "Issue deleted"],
      ["comment.deleted", "Comment deleted"],
      ["issue.transferred", "Issue moved"],
      ["issue.made_private", "Made private"],
      ["issue.locked", "Locked"],
    ],
  },
  {
    name: "Setup",
    actions: [
      ["app.updated", "Workspace updated"],
      ["app.exported", "Workspace exported"],
      ["import.started", "GitHub import started"],
      ["label.created", "Label created"],
      ["label.deleted", "Label deleted"],
      ["template.updated", "Template updated"],
      ["saved_reply.created", "Saved reply created"],
      ["tier.created", "Tier created"],
    ],
  },
]
const actionLabel = (a: string) => actionGroups.flatMap((g) => g.actions).find(([id]) => id === a)?.[1] ?? a

function change(d: Record<string, unknown>) {
  return "from" in d || "to" in d ? ` from ${d.from ?? "none"} to ${d.to ?? "none"}` : ""
}
function fields(d: Record<string, unknown>) {
  return Array.isArray(d.fields) && d.fields.length ? ` (${d.fields.join(", ")})` : ""
}

/** Names for ids the log doesn't spell out (labels, tiers, saved replies, agents, members and invitations), from
 *  what this admin can already see; things deleted since fall back to "a label" and so on. */
interface Names {
  of: (type: string, id: unknown) => string | null
  tier: (id: unknown) => ReactNode
}

function useNames(app: AppDetail): Names {
  const slug = app.slug
  const { data: tiers } = useResource<Tier[]>(keys.tiers(slug), () => api.tiers(slug), 30_000)
  const { data: replies } = useResource<SavedReply[]>(keys.savedReplies(slug), () => api.savedReplies(slug), 30_000)
  const { data: agents } = useResource<AppAgent[]>(keys.appAgents(slug), () => api.appAgents(slug), 30_000)
  const { data: settings } = useResource<AppSettings>(keys.settings(slug), () => api.settings(slug), 30_000)
  const of = (type: string, id: unknown) => {
    if (typeof id !== "string") return null
    if (type === "label") return app.labels.find((l) => l.id === id)?.name ?? null
    if (type === "template") return app.templates.find((t) => t.id === id)?.name ?? null
    if (type === "tier") return tiers?.find((t) => t.id === id)?.name ?? null
    if (type === "saved_reply") return replies?.find((r) => r.id === id)?.name ?? null
    if (type === "agent") return agents?.find((a) => a.id === id)?.client_name ?? null
    if (type === "member" || type === "invitation") {
      const m = settings?.members.find((x) => x.id === id)
      return m ? (m.name ?? m.email) : null
    }
    return null
  }
  return {
    of,
    tier: (id) => {
      const name = of("tier", id)
      return name ? <span className="audit-target">{name}</span> : "a tier"
    },
  }
}

const nouns: Record<string, [string, string]> = {
  label: ["label", "a label"],
  template: ["template", "a template"],
  tier: ["tier", "a tier"],
  saved_reply: ["saved reply", "a saved reply"],
  agent: ["agent", "an agent"],
  report_key: ["report key", "a report key"],
  member: ["", "a member"],
  invitation: ["", "an invitation"],
  actor: ["", "someone"],
  person: ["", "someone"],
  delivery: ["", "a delivery"],
  webhook: ["", "the webhook"],
  app: ["", "the workspace"],
}

/** The target as words: "#12", "label bug", an email, a key's preview, or "a label" when it's gone. */
function Target({ slug, target, names }: { slug: string; target: AuditEntry["target"]; names: Names }) {
  if (!target) return <>something</>
  const t = target as Record<string, unknown>
  const type = String(t.type ?? "")
  if ((type === "issue" || type === "comment") && typeof t.number === "number") {
    const link = (
      <AppLink slug={slug} href={appPath(slug, `/issues/${t.number}`)} className="audit-target">
        #{t.number}
      </AppLink>
    )
    return type === "comment" ? <>a comment on {link}</> : link
  }
  const [noun, fallback] = nouns[type] ?? ["", type ? `a ${type.replace(/_/g, " ")}` : "it"]
  const name = t.name ?? t.email ?? t.preview ?? t.handle ?? names.of(type, t.id)
  if (typeof name === "string")
    return (
      <>
        {noun && `${noun} `}
        <span className={t.preview ? "audit-target mono" : "audit-target"}>{name}</span>
      </>
    )
  if (typeof t.number === "number") return <span className="audit-target">#{t.number}</span>
  return <>{fallback}</>
}

/** Before/after and other details, one row each; arrays and objects as compact JSON. */
function Details({ entry }: { entry: AuditEntry }) {
  const rows: [string, ReactNode][] = []
  const d = entry.data ?? {}
  if ("from" in d || "to" in d)
    rows.push([
      "Change",
      <>
        {show(d.from)} <span className="audit-change">→</span> {show(d.to)}
      </>,
    ])
  for (const [k, v] of Object.entries(d)) if (k !== "from" && k !== "to") rows.push([k.replace(/_/g, " "), show(v)])
  if (entry.target) for (const [k, v] of Object.entries(entry.target)) if (k !== "type" && k !== "id") rows.push([k, show(v)])
  return (
    <dl className="audit-details">
      {rows.map(([k, v]) => (
        <div key={k} className="audit-detail">
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}
const show = (v: unknown) => (v === null || v === undefined ? "none" : typeof v === "string" ? v : JSON.stringify(v))

/**
 * Settings → Audit log (admins): what people and agents did here, newest first, kept for 90 days. Filter by who
 * and by action; each entry opens its details (before and after).
 */
export function AuditLog({ app }: { app: AppDetail }) {
  const [actor, setActor] = useState<Actor | null>(null)
  const [action, setAction] = useState("")
  const key = keys.audit(app.slug, actor?.id ?? "", action)
  const { data, error } = useResource<AuditPage>(key, () => api.audit(app.slug, { actor: actor?.id, action: action || undefined }), 5_000)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  // Who can be picked: everyone seen in the unfiltered log so far (it has no separate roster of actors).
  const [seen, setSeen] = useState<Map<string, Actor>>(new Map())
  const all = useResource<AuditPage>(keys.audit(app.slug), () => api.audit(app.slug), 30_000).data
  const actors = new Map(seen)
  for (const e of [...(all?.entries ?? []), ...(data?.entries ?? [])]) if (!actors.has(e.actor.id)) actors.set(e.actor.id, e.actor)

  const loadMore = async () => {
    if (!data?.next_cursor) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await api.audit(app.slug, { actor: actor?.id, action: action || undefined, cursor: data.next_cursor })
      setData<AuditPage>(key, (prev) => (prev ? { entries: [...prev.entries, ...page.entries.filter((e) => !prev.entries.some((p) => p.id === e.id))], next_cursor: page.next_cursor } : page))
      setSeen((m) => {
        const next = new Map(m)
        for (const e of page.entries) next.set(e.actor.id, e.actor)
        return next
      })
    } catch (e) {
      setMoreError(errorMessage(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const filtered = !!actor || !!action
  const names = useNames(app)
  return (
    <div>
      <div className="settings-heading">
        <h1>Audit log</h1>
      </div>
      <p className="settings-lede">What people and agents changed in this workspace. Kept for 90 days.</p>
      <div className="audit-filters">
        <Menu
          align="start"
          width={260}
          trigger={(p) => (
            <button type="button" className="btn audit-filter" data-variant="default" data-active={actor ? "" : undefined} aria-label={actor ? `Actor: ${actorName(actor)}` : "Filter by actor"} {...p}>
              <span className="filter-text">{actor ? actorName(actor) : "Anyone"}</span>
              <ChevronDownIcon size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="menu-scroll">
              <MenuItem
                checked={!actor}
                onSelect={() => {
                  setActor(null)
                  close()
                }}
              >
                Anyone
              </MenuItem>
              {[...actors.values()].map((a) => (
                <MenuItem
                  key={a.id}
                  checked={actor?.id === a.id}
                  description={a.type === "agent" ? "Agent" : a.type === "guest" ? "Guest" : undefined}
                  onSelect={() => {
                    setActor(a)
                    close()
                  }}
                >
                  {actorName(a)}
                </MenuItem>
              ))}
            </div>
          )}
        </Menu>
        <Menu
          align="start"
          width={280}
          trigger={(p) => (
            <button type="button" className="btn audit-filter" data-variant="default" data-active={action ? "" : undefined} aria-label={action ? `Action: ${actionLabel(action)}` : "Filter by action"} {...p}>
              <span className="filter-text">{action ? actionLabel(action) : "All actions"}</span>
              <ChevronDownIcon size={14} />
            </button>
          )}
        >
          {(close) => (
            <div className="menu-scroll">
              <MenuItem
                checked={!action}
                onSelect={() => {
                  setAction("")
                  close()
                }}
              >
                All actions
              </MenuItem>
              {actionGroups.map((g) => (
                <div key={g.name}>
                  <MenuHeader>
                    <span className="menu-item-description">{g.name}</span>
                  </MenuHeader>
                  {g.actions.map(([id, label]) => (
                    <MenuItem
                      key={id}
                      checked={action === id}
                      onSelect={() => {
                        setAction(id)
                        close()
                      }}
                    >
                      {label}
                    </MenuItem>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Menu>
        {filtered && (
          <Button
            size="small"
            variant="invisible"
            onClick={() => {
              setActor(null)
              setAction("")
            }}
          >
            Clear
          </Button>
        )}
      </div>
      <section className="box audit-list" aria-busy={!data || undefined}>
        {!data && !error && (
          <>
            <div className="box-row skeleton-row" />
            <div className="box-row skeleton-row" />
          </>
        )}
        {!!error && !data && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {data?.entries.length === 0 && <div className="box-empty">{filtered ? "Nothing matches these filters." : "Nothing recorded yet."}</div>}
        {data?.entries.map((e) => <Row key={e.id} slug={app.slug} entry={e} names={names} />)}
      </section>
      {(data?.next_cursor || moreError) && (
        <div className="audit-foot">
          {data?.next_cursor && (
            <Button onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : "Load more"}
            </Button>
          )}
          {moreError && <span className="field-error">{moreError}</span>}
        </div>
      )}
    </div>
  )
}

function Row({ slug, entry, names }: { slug: string; entry: AuditEntry; names: Names }) {
  const [open, setOpen] = useState(false)
  const sentence = sentences[entry.action]
  const target = <Target slug={slug} target={entry.target} names={names} />
  const hasDetails = Object.keys(entry.data ?? {}).length > 0
  return (
    <div className="box-row audit-row">
      <ActorAvatar actor={entry.actor} size={24} />
      <div className="audit-main">
        <p className="audit-text">
          <ActorName actor={entry.actor} badge={entry.actor.type === "agent"} />{" "}
          {sentence ? sentence(target, entry.data ?? {}, names, entry.target) : <>{entry.action.replace(/[._]/g, " ")} · {target}</>}
        </p>
      </div>
      <div className="audit-side">
        <Time iso={entry.created_at} />
        {hasDetails && (
          <button type="button" className="audit-toggle" aria-expanded={open} aria-label={open ? "Hide details" : "Show details"} onClick={() => setOpen(!open)}>
            Details
            <ChevronDownIcon size={12} />
          </button>
        )}
      </div>
      {open && <Details entry={entry} />}
    </div>
  )
}
