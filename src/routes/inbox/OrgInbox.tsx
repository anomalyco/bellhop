import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { useLocation, useSearch } from "wouter"
import type { InboxItem, InboxList, Issue, IssueRef, IssueSummary, LiveEvent, OrgDetail } from "../../../shared/api"
import { formatNumber } from "../../i18n"
import { tr, useT } from "../../i18n/inbox"
import { api, errorMessage, keys } from "../../lib/api"
import { invalidate, load, setData, useResource } from "../../lib/cache"
import {
  editQuery,
  fetchInbox,
  has,
  inboxKey,
  itemParam,
  metaFilters,
  parseItem,
  serverQuery,
  setOne,
  shortcutAllowed,
  toggle,
  tokens,
  valueOf,
  withMeta,
  type InboxState,
} from "../../lib/inbox"
import { useLive } from "../../lib/live"
import { flip, SPRING_30 } from "../../lib/motion"
import { homeUrl, orgPath } from "../../lib/site"
import { FilterMenu } from "../../ui/features/FilterMenu"
import { ArrowUpIcon, ChevronDownIcon, ImageIcon, MailIcon, PlusIcon, XIcon } from "../../ui/icons"
import { InboxDetail, type DetailHandle } from "../../ui/inbox/Detail"
import { InboxRow } from "../../ui/inbox/Row"
import { ShortcutsDialog } from "../../ui/inbox/Shortcuts"
import { Menu, MenuItem } from "../../ui/Menu"
import { AppIcon, Button } from "../../ui/primitives"
import { ErrorPage, Header, useMe } from "../../ui/Shell"
import { SiteLink } from "../../ui/SiteLink"
import { SearchBox } from "../Issues"
import { SignIn } from "../home/SignIn"
import "../../styles/feed.css"
import "../../styles/inbox.css"

const platforms = ["ios", "android", "macos", "web"]
const defaultLabels = ["bug", "idea", "question"]

/** Split view (list and detail side by side) from this width; below it the open feedback is the whole screen. */
const splitQuery = "(min-width: 960px)"
function useMedia(query: string) {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query)
      m.addEventListener("change", cb)
      return () => m.removeEventListener("change", cb)
    },
    () => window.matchMedia(query).matches,
    () => true,
  )
}

/** /o/<org> (every app) and /o/<org>/<app> (one app): the operator's feedback inbox. Signed-in org members only. */
export function OrgInboxPage({ org, app = null }: { org: string; app?: string | null }) {
  const { data: me } = useMe()
  if (!me) return <Header wide />
  if (!me.user) return <SignIn back={window.location.pathname + window.location.search} />
  return <OrgInbox org={org} app={app} />
}

function OrgInbox({ org, app }: { org: string; app: string | null }) {
  const t = useT()
  const { data: detail, error: orgError } = useResource<OrgDetail>(keys.org(org), () => api.org(org), 30_000)
  const search = useSearch()
  const [, navigate] = useLocation()
  const params = new URLSearchParams(search)
  const q = params.get("q") ?? ""
  const state: InboxState = params.get("state") === "closed" ? "closed" : "open"
  const open = parseItem(params.get("item"))
  const wide = useMedia(splitQuery)

  const sent = serverQuery(q, app)
  const key = inboxKey(org, state, sent)
  const { data, error } = useResource<InboxList>(key, () => fetchInbox(org, state, sent), 15_000)
  // The previous list stays (dimmed) while another filter loads, so nothing collapses under the reader
  const last = useRef<InboxList | null>(null)
  if (data) last.current = data
  const shown = data ?? (error ? undefined : (last.current ?? undefined))
  const pending = !data && !error && !!shown
  const listEl = useRef<HTMLDivElement>(null)
  const detailRef = useRef<DetailHandle>(null)
  const [cursor, setCursor] = useState<string | null>(null)
  const [help, setHelp] = useState(false)
  const [newer, setNewer] = useState<InboxItem[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  useEffect(() => setNewer([]), [key])

  const href = useCallback(
    (next: { q?: string; state?: InboxState; item?: string | null; app?: string | null }) => {
      const p = new URLSearchParams()
      const nq = next.q ?? q
      const ns = next.state ?? state
      const ni = next.item === undefined ? params.get("item") : next.item
      if (ns === "closed") p.set("state", "closed")
      if (nq) p.set("q", nq)
      if (ni) p.set("item", ni)
      const a = next.app === undefined ? app : next.app
      const s = p.toString()
      return orgPath(org, `${a ? `/${a}` : ""}${s ? `?${s}` : ""}`)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [org, app, q, state, search],
  )
  const go = (next: Parameters<typeof href>[0], replace = false) => navigate(href(next), { replace })
  const setQuery = (nq: string) => go({ q: nq.trim(), item: null })

  const items = shown?.items ?? []
  const openIndex = open ? items.findIndex((i) => i.app.slug === open.slug && i.number === open.number) : -1
  const cursorIndex = Math.max(
    0,
    items.findIndex((i) => i.id === cursor),
  )

  // The cursor follows the open feedback; with none open it stays where the keyboard left it
  useEffect(() => {
    if (openIndex >= 0) setCursor(items[openIndex]!.id)
  }, [openIndex, items])

  const focusRow = (id: string) => {
    const row = listEl.current?.querySelector<HTMLElement>(`[data-key="${id}"]`)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: "nearest" })
  }
  const openItem = (i: InboxItem, replace = false) => {
    setCursor(i.id)
    go({ item: itemParam(i) }, replace)
  }
  const step = (by: 1 | -1) => {
    if (!items.length) return
    const from = openIndex >= 0 ? openIndex : items.findIndex((i) => i.id === cursor)
    const next = items[Math.min(items.length - 1, Math.max(0, from < 0 ? 0 : from + by))]!
    setCursor(next.id)
    // Side by side, the open feedback follows the keyboard; on a phone the list keeps the screen until Enter
    if (wide && openIndex >= 0) openItem(next, true)
    requestAnimationFrame(() => focusRow(next.id))
  }
  const closeDetail = () => {
    const id = openIndex >= 0 ? items[openIndex]?.id : cursor
    go({ item: null })
    if (id) requestAnimationFrame(() => focusRow(id))
  }

  // Closing or reopening takes the feedback out of this tab's list; the next one takes its place
  const dropFromList = (id: string) => {
    const index = items.findIndex((i) => i.id === id)
    const next = items[index + 1] ?? items[index - 1] ?? null
    setData<InboxList>(key, (list) =>
      list
        ? {
            ...list,
            items: list.items.filter((i) => i.id !== id),
            counts: state === "open" ? { open: Math.max(0, list.counts.open - 1), closed: list.counts.closed + 1 } : { open: list.counts.open + 1, closed: Math.max(0, list.counts.closed - 1) },
          }
        : list,
    )
    invalidate(keys.inbox(org))
    return next
  }
  const onClosedChange = (issue: Issue) => {
    const item = items.find((i) => i.app.slug === open?.slug && i.number === issue.number)
    if (!item) return
    const fits = (issue.status === "closed") === (state === "closed")
    if (fits) return
    const next = dropFromList(item.id)
    if (wide && next) openItem(next, true)
  }
  const toggleCursor = async () => {
    const item = items[cursorIndex]
    if (!item) return
    const closed = item.status === "closed"
    const next = dropFromList(item.id)
    if (next) setCursor(next.id)
    try {
      await api.patchIssue(item.app.slug, item.number, closed ? { status: "open" } : { status: "closed", close_reason: "completed" })
    } catch {
      load(key, () => fetchInbox(org, state, sent)).catch(() => {})
    }
  }

  // Keyboard: j/k move, Enter/o open, Esc back, e close or reopen, l labels, a assign, r reply, n note, / search, ? help
  const keyState = useRef({ items, open, cursorIndex, wide })
  keyState.current = { items, open, cursorIndex, wide }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!shortcutAllowed(e) || document.querySelector(".fb-lightbox, .inbox-keys")) return
      const { items, open, cursorIndex } = keyState.current
      const current = items[cursorIndex]
      const ensureOpen = (then: () => void) => {
        if (open) return then()
        if (!current) return
        openItem(current)
        setTimeout(then, 120)
      }
      switch (e.key) {
        case "j":
        case "ArrowDown":
          e.preventDefault()
          step(1)
          break
        case "k":
        case "ArrowUp":
          e.preventDefault()
          step(-1)
          break
        case "Enter":
        case "o":
          if (current && !(open && current.app.slug === open.slug && current.number === open.number)) {
            e.preventDefault()
            openItem(current)
          }
          break
        case "Escape":
          if (open) {
            e.preventDefault()
            closeDetail()
          }
          break
        case "e":
          e.preventDefault()
          if (open) detailRef.current?.toggleClosed()
          else void toggleCursor()
          break
        case "l":
          e.preventDefault()
          ensureOpen(() => detailRef.current?.openLabels())
          break
        case "a":
          e.preventDefault()
          ensureOpen(() => detailRef.current?.openAssignee())
          break
        case "r":
        case "n":
          e.preventDefault()
          ensureOpen(() => detailRef.current?.compose(e.key === "r" ? "reply" : "note"))
          break
        case "/":
          e.preventDefault()
          document.querySelector<HTMLInputElement>(".inbox-toolbar .list-search input")?.focus()
          break
        case "?":
          e.preventDefault()
          setHelp(true)
          break
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  })

  // New feedback waits behind "N new" so the list never moves under the reader; changes update rows in place
  const plain = !tokens(q).length
  const appsBySlug = useMemo(() => new Map((detail?.apps ?? []).map((a) => [a.slug, a])), [detail])
  const onEvent = (slug: string, event: LiveEvent) => {
    const meta = appsBySlug.get(slug)
    if (!meta) return
    const asItem = (s: IssueSummary): InboxItem => ({ ...s, app: { slug, name: meta.name, icon_url: meta.icon_url } })
    if (event.type === "issue.created") {
      if (state === "open" && plain && (!app || app === slug) && event.issue.status !== "closed")
        setNewer((list) => [asItem(event.issue), ...list.filter((i) => i.id !== event.issue.id)])
    } else if (event.type === "issue.updated") {
      setData<InboxList>(key, (list) =>
        list?.items.some((i) => i.id === event.issue.id) ? { ...list, items: list.items.map((i) => (i.id === event.issue.id ? { ...i, ...event.issue } : i)) } : list,
      )
    } else if (event.type === "issue.deleted") {
      setData<InboxList>(key, (list) => (list ? { ...list, items: list.items.filter((i) => i.id !== event.issue_id) } : list))
    }
  }
  const showNewer = () => {
    const ids = new Set(newer.map((i) => i.id))
    flip(
      listEl.current,
      () =>
        flushSync(() => {
          setData<InboxList>(key, (list) =>
            list
              ? {
                  ...list,
                  items: [...newer, ...list.items.filter((i) => !ids.has(i.id))],
                  counts: { ...list.counts, open: list.counts.open + newer.filter((n) => !list.items.some((i) => i.id === n.id)).length },
                }
              : list,
          )
          setNewer([])
        }),
      { slide: SPRING_30, enterY: -4, stagger: 30, selector: ":scope > .inbox-row" },
    )
    listEl.current?.scrollTo({ top: 0, behavior: "smooth" })
  }

  const loadMore = async () => {
    if (!data?.next_cursor) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await fetchInbox(org, state, sent, data.next_cursor)
      setData<InboxList>(key, (list) => {
        if (!list) return page
        const ids = new Set(list.items.map((i) => i.id))
        return { ...page, items: [...list.items, ...page.items.filter((i) => !ids.has(i.id))] }
      })
    } catch (e) {
      setMoreError(errorMessage(e))
    } finally {
      setLoadingMore(false)
    }
  }

  if (orgError && !detail) return <><Header wide /><ErrorPage error={orgError} /></>
  const orgInfo = detail ?? null
  const showDetail = !!open
  const phoneDetail = showDetail && !wide
  const labelNames = [...new Set([...defaultLabels, ...items.flatMap((i) => i.labels.map((l) => l.name))])]

  return (
    <>
      <Header org={orgInfo ?? { slug: org, name: "", icon_url: null, role: "member" }} orgTab="inbox" wide />
      {orgInfo && <LiveRooms slugs={app ? [app] : orgInfo.apps.map((a) => a.slug)} onEvent={onEvent} onReconnect={() => load(key, () => fetchInbox(org, state, sent)).catch(() => {})} />}
      <div className="inbox" data-split={wide || undefined} data-detail={showDetail || undefined}>
        {wide && <Rail org={orgInfo} app={app} list={shown ?? null} hrefFor={(a) => href({ app: a, item: null })} />}
        {!phoneDetail && (
          <section className="inbox-list" aria-label={t("list.label")}>
            {/* Its row is held from the first paint (narrow screens), so the toolbar never moves when the org arrives */}
            {orgInfo ? (
              orgInfo.apps.length > 0 && <AppStrip org={orgInfo} app={app} list={shown ?? null} hrefFor={(a) => href({ app: a, item: null })} />
            ) : (
              <div className="inbox-strip" aria-hidden="true" data-pending="" />
            )}
            <div className="inbox-toolbar" data-loading={!shown || undefined}>
              <nav className="segmented inbox-states" aria-label={t("list.states")}>
                <SiteLink href={href({ state: "open", item: null })} aria-current={state === "open" ? "page" : undefined}>
                  {t("list.open")}
                  <span className="segmented-count">{formatNumber(shown?.counts.open ?? 0)}</span>
                </SiteLink>
                <SiteLink href={href({ state: "closed", item: null })} aria-current={state === "closed" ? "page" : undefined}>
                  {t("list.closed")}
                  <span className="segmented-count">{formatNumber(shown?.counts.closed ?? 0)}</span>
                </SiteLink>
              </nav>
              <SearchBox query={q} filtered={!!q} placeholder={t("list.search")} onSubmit={setQuery} onClear={() => setQuery("")} />
              <button type="button" className="btn inbox-keys-button" data-variant="ghost-muted" data-icon-only="" onClick={() => setHelp(true)} aria-label={t("keys.button")} title={`${t("keys.button")} (?)`}>
                ?
              </button>
            </div>
            <Chips q={q} labels={labelNames} onChange={setQuery} />
            <div className="inbox-newer-slot">
              {newer.length > 0 && (
                <button type="button" className="feed-newer" onClick={showNewer}>
                  <ArrowUpIcon size={14} />
                  {t("list.newer", { count: newer.length })}
                </button>
              )}
            </div>
            <div className="inbox-rows" ref={listEl} role="list" data-pending={pending || undefined} aria-busy={pending || !shown || undefined}>
              {!!error && !shown && <p className="inbox-note">{errorMessage(error)}</p>}
              {!shown && !error && <SkeletonRows />}
              {shown && items.length === 0 && orgInfo && <Empty org={orgInfo} app={app} q={q} state={state} list={shown} onClear={() => setQuery("")} />}
              {items.map((item, i) => (
                <InboxRow key={item.id} item={item} href={href({ item: itemParam(item) })} open={i === openIndex} cursor={i === cursorIndex && !!cursor} onOpen={(it) => openItem(it)} />
              ))}
              {shown?.next_cursor && (
                <div className="inbox-more">
                  <Button size="small" onClick={loadMore} disabled={loadingMore || pending}>
                    {loadingMore ? t("list.loading") : t("list.loadMore")}
                  </Button>
                  {moreError && <span className="field-error">{moreError}</span>}
                </div>
              )}
            </div>
          </section>
        )}
        {(wide || phoneDetail) && (
          <div className="inbox-pane">
            {open ? (
              <InboxDetail
                key={`${open.slug}/${open.number}`}
                org={org}
                slug={open.slug}
                number={open.number}
                handle={detailRef}
                wide={wide}
                onBack={closeDetail}
                onStep={items.length > 1 ? step : undefined}
                onFilter={(k, v) => go({ q: withMeta(q, k, v), item: params.get("item") })}
                onOpenRef={(slug, r: IssueRef) => go({ item: `${slug}/${r.number}` })}
                onClosedChange={onClosedChange}
              />
            ) : (
              <div className="inbox-pane-empty">
                <p>{t("detail.empty")}</p>
                <p className="inbox-pane-keys">{tr("detail.emptyKeys", { j: <kbd>j</kbd>, k: <kbd>k</kbd>, enter: <kbd>Enter</kbd>, help: <kbd>?</kbd> })}</p>
              </div>
            )}
          </div>
        )}
      </div>
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
    </>
  )
}

/** One list room per app (the org has no room of its own): created and changed issues as they happen. */
function LiveRooms({ slugs, onEvent, onReconnect }: { slugs: string[]; onEvent: (slug: string, e: LiveEvent) => void; onReconnect: () => void }) {
  return (
    <>
      {slugs.map((s) => (
        <LiveRoom key={s} slug={s} onEvent={onEvent} onReconnect={onReconnect} />
      ))}
    </>
  )
}
function LiveRoom({ slug, onEvent, onReconnect }: { slug: string; onEvent: (slug: string, e: LiveEvent) => void; onReconnect: () => void }) {
  useLive(`/api/live/apps/${encodeURIComponent(slug)}`, (e) => onEvent(slug, e), (reconnected) => reconnected && onReconnect())
  return null
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="inbox-row inbox-row-skeleton" aria-hidden="true">
          <span className="skeleton" style={{ width: 18, height: 18, borderRadius: 4 }} />
          <span className="inbox-row-main">
            <span className="skeleton" style={{ width: `${62 - i * 5}%`, height: 13 }} />
            <span className="skeleton" style={{ width: 160, height: 10, marginTop: 6 }} />
          </span>
        </div>
      ))}
    </>
  )
}

/** The org and its apps, with open counts for the current query; settings and the older places at the foot. */
function Rail({ org, app, list, hrefFor }: { org: OrgDetail | null; app: string | null; list: InboxList | null; hrefFor: (app: string | null) => string }) {
  const t = useT()
  if (!org) return <aside className="inbox-rail" aria-hidden="true" />
  const open = (slug: string) => list?.by_app.find((b) => b.slug === slug)?.open
  const admin = org.role === "owner" || org.role === "admin"
  const total = list ? (app ? list.by_app.reduce((n, b) => n + b.open, 0) : list.counts.open) : undefined
  return (
    <aside className="inbox-rail" aria-label={t("rail.label")}>
      <nav className="inbox-rail-apps">
        <SiteLink href={hrefFor(null)} className="inbox-rail-row" aria-current={!app ? "page" : undefined}>
          <span className="inbox-rail-all" aria-hidden="true">
            <AppIcon src={org.icon_url} size={16} name={org.name} />
          </span>
          <span className="inbox-rail-name">{t("rail.all")}</span>
          <span className="inbox-rail-count mono">{total !== undefined ? formatNumber(total) : ""}</span>
        </SiteLink>
        {org.apps.map((a) => (
          <SiteLink key={a.slug} href={hrefFor(a.slug)} className="inbox-rail-row" aria-current={app === a.slug ? "page" : undefined}>
            <AppIcon src={a.icon_url} size={16} name={a.name} />
            <span className="inbox-rail-name">{a.name}</span>
            <span className="inbox-rail-count mono" aria-label={open(a.slug) !== undefined ? t("rail.openCount", { count: open(a.slug)! }) : undefined}>
              {open(a.slug) !== undefined ? formatNumber(open(a.slug)!) : ""}
            </span>
          </SiteLink>
        ))}
      </nav>
      <div className="inbox-rail-foot">
        {admin && (
          <SiteLink href={orgPath(org.slug, "/settings/apps?new=1")} className="inbox-rail-link">
            <PlusIcon size={12} />
            {t("rail.newApp")}
          </SiteLink>
        )}
        {admin && (
          <SiteLink href={orgPath(org.slug, "/settings")} className="inbox-rail-link">
            {t("rail.settings")}
          </SiteLink>
        )}
        <SiteLink href={homeUrl("/workspaces")} className="inbox-rail-link">
          {t("rail.workspaces")}
        </SiteLink>
        <SiteLink href={homeUrl("/?feed=1")} className="inbox-rail-link">
          {t("rail.publicFeed")}
        </SiteLink>
      </div>
    </aside>
  )
}

/** Phones and narrow windows: the apps as a row of chips above the list. */
function AppStrip({ org, app, list, hrefFor }: { org: OrgDetail; app: string | null; list: InboxList | null; hrefFor: (app: string | null) => string }) {
  const t = useT()
  const open = (slug: string) => list?.by_app.find((b) => b.slug === slug)?.open
  return (
    <nav className="inbox-strip" aria-label={t("rail.label")}>
      <SiteLink href={hrefFor(null)} className="inbox-strip-chip" aria-current={!app ? "page" : undefined}>
        {t("rail.all")}
      </SiteLink>
      {org.apps.map((a) => (
        <SiteLink key={a.slug} href={hrefFor(a.slug)} className="inbox-strip-chip" aria-current={app === a.slug ? "page" : undefined}>
          <AppIcon src={a.icon_url} size={14} name={a.name} />
          {a.name}
          {!!open(a.slug) && <span className="mono inbox-strip-count">{formatNumber(open(a.slug)!)}</span>}
        </SiteLink>
      ))}
    </nav>
  )
}

/** Platform, screenshot, email and label filters over the query, its meta filters as removable chips, and the shared Filters menu. */
function Chips({ q, labels, onChange }: { q: string; labels: string[]; onChange: (q: string) => void }) {
  const t = useT()
  const platform = valueOf(q, "platform")
  const label = valueOf(q, "label")
  const metas = metaFilters(q)
  const any = !!q.trim()
  return (
    <div className="inbox-chips">
      <Menu
        align="start"
        width={200}
        trigger={(p) => (
          <button type="button" className="inbox-chip" data-on={platform ? "" : undefined} {...p}>
            {platform ? <span className="mono">{platform}</span> : t("chip.platform")}
            <ChevronDownIcon size={12} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem checked={!platform} onSelect={() => (close(), onChange(setOne(q, "platform", null)))}>
              {t("chip.anyPlatform")}
            </MenuItem>
            {platforms.map((p) => (
              <MenuItem key={p} checked={platform === p} onSelect={() => (close(), onChange(setOne(q, "platform", p)))}>
                <span className="mono">{p}</span>
              </MenuItem>
            ))}
          </>
        )}
      </Menu>
      <button type="button" className="inbox-chip" data-on={has(q, "has", "screenshot") ? "" : undefined} aria-pressed={has(q, "has", "screenshot")} onClick={() => onChange(toggle(q, "has", "screenshot"))}>
        <ImageIcon size={12} />
        {t("chip.screenshot")}
      </button>
      <button type="button" className="inbox-chip" data-on={has(q, "has", "email") ? "" : undefined} aria-pressed={has(q, "has", "email")} onClick={() => onChange(toggle(q, "has", "email"))}>
        <MailIcon size={12} />
        {t("chip.email")}
      </button>
      <Menu
        align="start"
        width={200}
        trigger={(p) => (
          <button type="button" className="inbox-chip" data-on={label ? "" : undefined} {...p}>
            {label ?? t("chip.label")}
            <ChevronDownIcon size={12} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem checked={!label} onSelect={() => (close(), onChange(setOne(q, "label", null)))}>
              {t("chip.anyLabel")}
            </MenuItem>
            {labels.map((l) => (
              <MenuItem key={l} checked={label === l} onSelect={() => (close(), onChange(setOne(q, "label", l)))}>
                {l}
              </MenuItem>
            ))}
          </>
        )}
      </Menu>
      {metas.map((m) => {
        const name = t("chip.meta", { key: m.key, value: m.value })
        return (
          <button key={m.raw} type="button" className="inbox-chip" data-on="" onClick={() => onChange(editQuery(q, (tk) => tk.raw === m.raw))} aria-label={t("chip.remove", { filter: name })}>
            <span className="mono">
              {m.key}={m.value}
            </span>
            <XIcon size={12} />
          </button>
        )
      })}
      <FilterMenu query={q} onChange={onChange} />
      {any && (
        <button type="button" className="inbox-chip inbox-chip-clear" onClick={() => onChange("")}>
          {t("chip.clear")}
        </button>
      )}
    </div>
  )
}

/** No apps, no feedback yet (with how to send the first), nothing open, nothing closed, or nothing matching. */
function Empty({ org, app, q, state, list, onClear }: { org: OrgDetail; app: string | null; q: string; state: InboxState; list: InboxList; onClear: () => void }) {
  const t = useT()
  const admin = org.role === "owner" || org.role === "admin"
  if (!org.apps.length)
    return (
      <EmptyBox title={t("empty.noAppsTitle", { org: org.name })}>
        <p>{t("empty.noAppsText")}</p>
        {admin && (
          <SiteLink href={orgPath(org.slug, "/settings/apps?new=1")} className="btn" data-variant="primary" data-size="small">
            <PlusIcon size={12} />
            {t("empty.createApp")}
          </SiteLink>
        )}
      </EmptyBox>
    )
  if (q.trim())
    return (
      <EmptyBox>
        <p>{t("empty.noResults", { query: q.trim() })}</p>
        <Button size="small" onClick={onClear}>
          {t("empty.clear")}
        </Button>
      </EmptyBox>
    )
  if (list.counts.open + list.counts.closed === 0) {
    const target = org.apps.find((a) => a.slug === app) ?? org.apps[0]!
    const origin = new URL(homeUrl("/"), window.location.href).origin
    const curl = `curl ${origin}/api/apps/${target.slug}/feedback \\
  -H "Authorization: Bearer $REPORT_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"message": "Export stops at 99%", "email": "you@example.com", "app": {"name": "${target.name}", "version": "1.0"}}'`
    return (
      <EmptyBox title={t("empty.noFeedbackTitle")}>
        <p>{t("empty.noFeedbackText")}</p>
        <pre className="inbox-curl mono">{curl}</pre>
        <a href={homeUrl("/docs/feedback")} className="inbox-docs-link">
          {t("empty.docs")}
        </a>
      </EmptyBox>
    )
  }
  return <EmptyBox>{state === "open" ? <p>{t("empty.allDone")}</p> : <p>{t("empty.noClosed")}</p>}</EmptyBox>
}

function EmptyBox({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="inbox-empty">
      {title && <h2 className="inbox-empty-title">{title}</h2>}
      {children}
    </div>
  )
}
