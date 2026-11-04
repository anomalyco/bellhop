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
import { t, tr, tKey, useT, type PlainKey } from "../../i18n/settings"
import { t as tc } from "../../i18n/core"
import { formatList } from "../../i18n"
import "../../styles/insights.css"

/** Each action as a whole sentence in the active language: `a` is the actor's name, `t` the target as words, `d` the
 *  entry's data. */
type Raw = Record<string, unknown> | null
type Sentence = (a: ReactNode, t: ReactNode, d: Record<string, unknown>, n: Names, raw: Raw) => ReactNode
const known = (n: Names, raw: Raw) => !!raw && (typeof raw.email === "string" || !!n.of(String(raw.type), raw.id))
const targetPhrase = (key: Parameters<typeof tr>[0]): Sentence => (actor, target) => (tr as (k: string, p: object) => ReactNode)(key, { actor, target })
const sentences: Record<string, Sentence> = {
  "member.invited": (actor, target, d, n, raw) =>
    known(n, raw)
      ? d.role
        ? tr("audit.invitedAs", { actor, target, role: role(d.role) })
        : tr("audit.invited", { actor, target })
      : d.role
        ? tr("audit.sentInvitationAs", { actor, role: role(d.role) })
        : tr("audit.sentInvitation", { actor }),
  "member.accepted": (actor, _t, d) => (d.role ? tr("audit.acceptedAs", { actor, role: role(d.role) }) : tr("audit.accepted", { actor })),
  "member.declined": (actor) => tr("audit.declined", { actor }),
  "member.role_changed": (actor, target, d) =>
    changed(d) ? tr("audit.roleChangedFromTo", { actor, target, from: role(d.from), to: role(d.to) }) : tr("audit.roleChanged", { actor, target }),
  "member.removed": (actor, target, _d, n, raw) =>
    raw?.type === "invitation" && !known(n, raw) ? tr("audit.withdrew", { actor }) : tr("audit.removed", { actor, target }),
  "member.left": (actor) => tr("audit.left", { actor }),
  "app.updated": (actor, _t, d) =>
    Array.isArray(d.fields) && d.fields.length
      ? tr("audit.appUpdatedFields", { actor, fields: formatList(d.fields.map((f) => field(String(f)))) })
      : tr("audit.appUpdated", { actor }),
  "app.created": (actor) => tr("audit.appCreated", { actor }),
  "app.ownership_transferred": targetPhrase("audit.madeOwner"),
  "agent.created": (actor, target, d) => (d.to ? tr("audit.agentCreatedAs", { actor, target, role: role(d.to) }) : tr("audit.agentCreated", { actor, target })),
  "agent.access_changed": (actor, target, d) =>
    changed(d) ? tr("audit.accessChangedFromTo", { actor, target, from: role(d.from), to: role(d.to) }) : tr("audit.accessChanged", { actor, target }),
  "agent.updated": targetPhrase("audit.updated"),
  "agent.rotated": targetPhrase("audit.agentRotated"),
  "agent.revoked": targetPhrase("audit.revoked"),
  "webhook.updated": (actor, _t, d) => (d.enabled === false ? tr("audit.webhookRemoved", { actor }) : tr("audit.webhookUpdated", { actor })),
  "webhook.rotated": (actor) => tr("audit.webhookRotated", { actor }),
  "webhook.tested": (actor) => tr("audit.webhookTested", { actor }),
  "webhook.redelivered": (actor) => tr("audit.webhookRedelivered", { actor }),
  "label.created": targetPhrase("audit.created"),
  "label.updated": targetPhrase("audit.updated"),
  "label.deleted": targetPhrase("audit.deleted"),
  "template.created": targetPhrase("audit.created"),
  "template.updated": targetPhrase("audit.updated"),
  "template.deleted": targetPhrase("audit.deleted"),
  "saved_reply.created": targetPhrase("audit.created"),
  "saved_reply.updated": targetPhrase("audit.updated"),
  "saved_reply.deleted": targetPhrase("audit.deleted"),
  "tier.created": targetPhrase("audit.created"),
  "tier.updated": targetPhrase("audit.updated"),
  "tier.deleted": targetPhrase("audit.deleted"),
  "tier.assigned": (actor, target, d, n) =>
    d.tier_id === null ? tr("audit.tierRemoved", { actor, target }) : tr("audit.tierSet", { actor, target, tier: n.tier(d.tier_id) }),
  "issue.deleted": targetPhrase("audit.deleted"),
  "issue.hidden": (actor, target, d) => (d.reason ? tr("audit.hidAs", { actor, target, reason: reason(d.reason) }) : tr("audit.hid", { actor, target })),
  "issue.unhidden": targetPhrase("audit.unhid"),
  "issue.transferred": (actor, target, d) =>
    d.to ? tr("audit.movedTo", { actor, target, to: <span className="mono audit-target">{String(d.to)}</span> }) : tr("audit.moved", { actor, target }),
  "issue.locked": targetPhrase("audit.locked"),
  "issue.unlocked": targetPhrase("audit.unlocked"),
  "issue.pinned": targetPhrase("audit.pinned"),
  "issue.unpinned": targetPhrase("audit.unpinned"),
  "issue.made_private": targetPhrase("audit.madePrivate"),
  "issue.made_public": targetPhrase("audit.madePublic"),
  "comment.hidden": (actor, target, d) => (d.reason ? tr("audit.hidAs", { actor, target, reason: reason(d.reason) }) : tr("audit.hid", { actor, target })),
  "comment.unhidden": targetPhrase("audit.unhid"),
  "comment.deleted": targetPhrase("audit.deleted"),
  "actor.blocked": (actor, target, d) => (d.hide_content ? tr("audit.blockedHid", { actor, target }) : tr("audit.blocked", { actor, target })),
  "actor.unblocked": targetPhrase("audit.unblocked"),
  "import.started": (actor, _t, d) =>
    d.repo ? tr("audit.importStarted", { actor, repo: <span className="mono audit-target">{String(d.repo)}</span> }) : tr("audit.importStartedRepo", { actor }),
  "app.exported": (actor) => tr("audit.exported", { actor }),
  "report_key.created": targetPhrase("audit.created"),
  "report_key.revoked": targetPhrase("audit.revoked"),
}

/** The action filter's choices, grouped (labels from audit.action.<id>). */
const actionGroups: { name: PlainKey; actions: string[] }[] = [
  {
    name: "audit.group.people",
    actions: ["member.invited", "member.accepted", "member.role_changed", "member.removed", "member.left", "actor.blocked", "actor.unblocked", "tier.assigned"],
  },
  {
    name: "audit.group.agents",
    actions: ["agent.created", "agent.access_changed", "agent.revoked", "webhook.updated", "webhook.rotated", "report_key.created", "report_key.revoked"],
  },
  {
    name: "audit.group.moderation",
    actions: ["issue.hidden", "comment.hidden", "issue.deleted", "comment.deleted", "issue.transferred", "issue.made_private", "issue.locked"],
  },
  {
    name: "audit.group.setup",
    actions: ["app.updated", "app.exported", "import.started", "label.created", "label.deleted", "template.updated", "saved_reply.created", "tier.created"],
  },
]
const actionLabel = (a: string) => (actionGroups.some((g) => g.actions.includes(a)) ? tKey(`audit.action.${a}` as PlainKey) : a)

const changed = (d: Record<string, unknown>) => "from" in d || "to" in d
/** A role (or "none") inside a sentence; anything unknown as it was stored. */
const role = (v: unknown) =>
  v == null ? t("audit.none") : ["owner", "admin", "member", "viewer", "responder"].includes(String(v)) ? tKey(`roleWord.${v}` as PlainKey) : String(v)
const reason = (v: unknown) => (["spam", "abuse", "off_topic"].includes(String(v)) ? tKey(`audit.reason.${v}` as PlainKey) : String(v).replace("_", " "))
const fields = ["name", "description", "public", "visibility", "nudge_days", "mode", "helpdesk", "icon"]
const field = (f: string) => (fields.includes(f) ? tKey(`audit.field.${f}` as PlainKey) : f.replace(/_/g, " "))

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
      return name ? <span className="audit-target">{name}</span> : t("audit.a.tier")
    },
  }
}

const named = ["label", "template", "tier", "saved_reply", "agent", "report_key"]
const fallbacks = [...named, "member", "invitation", "actor", "person", "delivery", "webhook", "app"]

/** The target as words: "#12", "label bug", an email, a key's preview, or "a label" when it's gone. */
function Target({ slug, target, names }: { slug: string; target: AuditEntry["target"]; names: Names }) {
  if (!target) return <>{t("audit.something")}</>
  const raw = target as Record<string, unknown>
  const type = String(raw.type ?? "")
  if ((type === "issue" || type === "comment") && typeof raw.number === "number") {
    const link = (
      <AppLink slug={slug} href={appPath(slug, `/issues/${raw.number}`)} className="audit-target">
        #{raw.number}
      </AppLink>
    )
    return type === "comment" ? <>{tr("audit.commentOn", { issue: link })}</> : link
  }
  const name = raw.name ?? raw.email ?? raw.preview ?? raw.handle ?? names.of(type, raw.id)
  if (typeof name === "string") {
    const node = <span className={raw.preview ? "audit-target mono" : "audit-target"}>{name}</span>
    return named.includes(type) ? <>{(tr as (k: string, p: object) => ReactNode)(`audit.target.${type}`, { name: node })}</> : node
  }
  if (typeof raw.number === "number") return <span className="audit-target">#{raw.number}</span>
  if (fallbacks.includes(type)) return <>{tKey(`audit.a.${type}` as PlainKey)}</>
  return <>{type ? t("audit.aThing", { type: type.replace(/_/g, " ") }) : t("audit.it")}</>
}

/** Before/after and other details, one row each; arrays and objects as compact JSON. */
function Details({ entry }: { entry: AuditEntry }) {
  const rows: [string, ReactNode][] = []
  const d = entry.data ?? {}
  if ("from" in d || "to" in d)
    rows.push([
      t("audit.change"),
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
const show = (v: unknown) => (v === null || v === undefined ? t("audit.none") : typeof v === "string" ? v : JSON.stringify(v))

/**
 * Settings → Audit log (admins): what people and agents did here, newest first, kept for 90 days. Filter by who
 * and by action; each entry opens its details (before and after).
 */
export function AuditLog({ app }: { app: AppDetail }) {
  useT()
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
        <h1>{tKey("section.audit")}</h1>
      </div>
      <p className="settings-lede">{t("audit.lede")}</p>
      <div className="audit-filters">
        <Menu
          align="start"
          width={260}
          trigger={(p) => (
            <button type="button" className="btn audit-filter" data-variant="default" data-active={actor ? "" : undefined} aria-label={actor ? t("audit.actorLabel", { name: actorName(actor) }) : t("audit.filterActor")} {...p}>
              <span className="filter-text">{actor ? actorName(actor) : t("audit.anyone")}</span>
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
                {t("audit.anyone")}
              </MenuItem>
              {[...actors.values()].map((a) => (
                <MenuItem
                  key={a.id}
                  checked={actor?.id === a.id}
                  description={a.type === "agent" ? t("audit.agent") : a.type === "guest" ? t("audit.guest") : undefined}
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
            <button type="button" className="btn audit-filter" data-variant="default" data-active={action ? "" : undefined} aria-label={action ? t("audit.actionLabel", { name: actionLabel(action) }) : t("audit.filterAction")} {...p}>
              <span className="filter-text">{action ? actionLabel(action) : t("audit.allActions")}</span>
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
                {t("audit.allActions")}
              </MenuItem>
              {actionGroups.map((g) => (
                <div key={g.name}>
                  <MenuHeader>
                    <span className="menu-item-description">{tKey(g.name)}</span>
                  </MenuHeader>
                  {g.actions.map((id) => (
                    <MenuItem
                      key={id}
                      checked={action === id}
                      onSelect={() => {
                        setAction(id)
                        close()
                      }}
                    >
                      {actionLabel(id)}
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
            {t("audit.clear")}
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
        {data?.entries.length === 0 && <div className="box-empty">{filtered ? t("audit.noMatch") : t("audit.empty")}</div>}
        {data?.entries.map((e) => <Row key={e.id} slug={app.slug} entry={e} names={names} />)}
      </section>
      {(data?.next_cursor || moreError) && (
        <div className="audit-foot">
          {data?.next_cursor && (
            <Button onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? tc("common.loading") : tc("common.loadMore")}
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
  const actor = <ActorName actor={entry.actor} badge={entry.actor.type === "agent"} />
  const hasDetails = Object.keys(entry.data ?? {}).length > 0
  return (
    <div className="box-row audit-row">
      <ActorAvatar actor={entry.actor} size={24} />
      <div className="audit-main">
        <p className="audit-text">
          {sentence
            ? sentence(actor, target, entry.data ?? {}, names, entry.target)
            : tr("audit.other", { actor, action: entry.action.replace(/[._]/g, " "), target })}
        </p>
      </div>
      <div className="audit-side">
        <Time iso={entry.created_at} />
        {hasDetails && (
          <button type="button" className="audit-toggle" aria-expanded={open} aria-label={open ? t("audit.hideDetails") : t("audit.showDetails")} onClick={() => setOpen(!open)}>
            {t("audit.details")}
            <ChevronDownIcon size={12} />
          </button>
        )}
      </div>
      {open && <Details entry={entry} />}
    </div>
  )
}
