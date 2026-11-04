import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { flushSync } from "react-dom"
import { useLocation, useSearch } from "wouter"
import type { AppDetail, IssueList, IssueSort, IssueSummary, LiveEvent } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { invalidate, load, setData, useResource } from "../lib/cache"
import { applyActivity, applyActorUpdate, applySummary, dropIssue, fetchList, formatQuery, listKey, parseQuery, removeIssue, visibleState, type Filter } from "../lib/issues"
import { useLive } from "../lib/live"
import { flip } from "../lib/motion"
import { appPath } from "../lib/site"
import { Time, useUntil } from "../lib/time"
import { ActorAvatar, TierBadge, actorName } from "../ui/Actor"
import { ChevronDownIcon, CommentIcon, EyeOffIcon, LockIcon, PinIcon, PlusIcon, SearchIcon, SortIcon, TagIcon, ThumbIcon, XIcon } from "../ui/icons"
import { Menu, MenuItem } from "../ui/Menu"
import { AppIcon, Button, Dots, Label, StateIcon } from "../ui/primitives"
import { AppLayout, Page, cachedOutsider } from "../ui/Shell"
import { AppLink } from "../ui/SiteLink"
import { NoClosed, NoIssues, NoResults } from "../ui/onboarding/EmptyStates"
import { SetupChecklist, useSetupChecklistSettled } from "../ui/onboarding/SetupChecklist"
import { MineFilter } from "../ui/features/QuickLinks"
import { FilterMenu } from "../ui/features/FilterMenu"
import { tKey, tr, useT, type PlainKey } from "../i18n/core"
import { formatNumber } from "../i18n"
import { sorts } from "../ui/features/FilterMenu"
import { DeskHome } from "./helpdesk/Home"
import { deskOutsider } from "../lib/helpdesk"
import { ReviewFlags, useReviewQueue } from "../ui/helpdesk/Review"

export function Issues({ slug }: { slug: string }) {
  return (
    <AppLayout slug={slug} tab="issues" loading={<IssuesLoading slug={slug} />}>
      {(app) => <IssuesBody app={app} />}
    </AppLayout>
  )
}

function IssuesLoading({ slug }: { slug: string }) {
  const t = useT()
  const search = useSearch()
  const q = new URLSearchParams(search).get("q") ?? "is:open"
  const filter = parseQuery(q)
  const stateHref = (state: Filter["state"]) => {
    const next = formatQuery({ ...filter, state })
    return appPath(slug, next === "is:open" ? "" : `?q=${encodeURIComponent(next)}`)
  }
  // A requester never sees the list, not even its skeleton
  if (cachedOutsider(slug)) return <Page>{null}</Page>
  return (
    <Page>
      <div className="list-toolbar">
        <nav className="segmented list-states" aria-label={t("list.states")}>
          <AppLink slug={slug} href={stateHref("open")} aria-current={filter.state === "open" ? "page" : undefined}>
            <StateIcon state="open" size={14} />
            {t("state.open")}
          </AppLink>
          <AppLink slug={slug} href={stateHref("closed")} aria-current={filter.state === "closed" ? "page" : undefined}>
            <StateIcon state="closed" size={14} />
            {t("state.closed")}
          </AppLink>
        </nav>
        <div className="input list-search">
          <SearchIcon size={14} />
          <input aria-label={t("list.search")} defaultValue={q} placeholder={t("list.search")} spellCheck={false} readOnly />
        </div>
        <div className="list-label">
          <MineFilter filter={filter} disabled />
          <FilterMenu query={q} disabled />
          <button type="button" className="btn list-sort" data-variant="default" disabled>
            <SortIcon size={14} />
            <span className="filter-text list-sort-text">{tKey(sortLabel[filter.sort ?? "newest"])}</span>
            <ChevronDownIcon size={14} />
          </button>
          <button type="button" className="btn" data-variant="default" data-active={filter.label ? "" : undefined} disabled>
            <TagIcon size={14} />
            <span className="filter-text">{filter.label || t("list.label")}</span>
            <ChevronDownIcon size={14} />
          </button>
        </div>
        <AppLink slug={slug} href={appPath(slug, "/new")} className="btn list-new" data-variant="primary" aria-label={t("list.newIssue")}>
          <PlusIcon size={14} />
          <span className="list-new-text">{t("list.newIssue")}</span>
        </AppLink>
      </div>
      <section className="issue-list" aria-label={t("list.issues")}>
        <SkeletonRows />
      </section>
    </Page>
  )
}

export function SearchBox({
  query,
  filtered,
  placeholder,
  onSubmit,
  onClear,
}: {
  query: string
  filtered: boolean
  placeholder?: string
  onSubmit: (draft: string) => void
  onClear: () => void
}) {
  const t = useT()
  placeholder ??= t("list.search")
  const [draft, setDraft] = useState(query)
  useEffect(() => setDraft(query), [query])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    onSubmit(draft)
  }

  return (
    <form className="input list-search" onSubmit={submit} role="search">
      <SearchIcon size={14} />
      <input
        aria-label={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
      />
      {filtered && (
        <button type="button" className="input-clear" aria-label={t("list.clearFilters")} onClick={onClear}>
          <XIcon size={14} />
        </button>
      )}
    </form>
  )
}

function IssuesBody({ app }: { app: AppDetail }) {
  // For admins the setup checklist sits above the toolbar; keep the skeleton until it knows whether it shows, so
  // it never pushes a painted toolbar down.
  const settled = useSetupChecklistSettled(app)
  // A help desk's requesters get its home, never a list
  if (deskOutsider(app)) return <DeskHome app={app} />
  if (!settled) return <IssuesLoading slug={app.slug} />
  return <IssuesList app={app} />
}

function IssuesList({ app }: { app: AppDetail }) {
  const t = useT()
  const slug = app.slug
  const search = useSearch()
  const [, navigate] = useLocation()
  const q = new URLSearchParams(search).get("q") ?? "is:open"
  const filter = parseQuery(q)
  const key = listKey(slug, filter)
  const { data, error } = useResource<IssueList>(key, () => fetchList(slug, filter))
  const lastList = useRef<{ slug: string; list: IssueList } | null>(null)
  if (data) lastList.current = { slug, list: data }
  else if (lastList.current?.slug !== slug) lastList.current = null
  // Help desk team: which requests wait on a review (held agent drafts, pending approvals). Rows wait for it the
  // first time, so their flags never arrive late and move the list.
  const review = useReviewQueue(app, filter.state)
  const revealed = useRef(false)
  const reviewWait = !!review && !review.ready && !revealed.current
  const shown = reviewWait ? undefined : (data ?? (error ? undefined : lastList.current?.list))
  if (shown) revealed.current = true
  const pending = !data && !error && !!shown
  // Rows that replace the skeleton fade in; rows already cached at first paint are simply there.
  const hadSkeleton = useRef(false)
  if (!shown && !error) hadSkeleton.current = true
  const listEl = useRef<HTMLElement>(null)

  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)

  const filterRef = useRef(filter)
  filterRef.current = filter

  const go = useCallback(
    (f: Filter) => {
      const next = formatQuery(f)
      navigate(appPath(slug, next === "is:open" ? "" : `?q=${encodeURIComponent(next)}`))
    },
    [slug, navigate],
  )

  const onLabel = useCallback((label: string) => go({ ...filterRef.current, label }), [go])

  useLive(
    `/api/live/apps/${encodeURIComponent(slug)}`,
    (event: LiveEvent) => {
      if (event.type === "activity") return applyActivity(slug, event.issue_id, event.activity)
      if (event.type === "actor.updated") return applyActorUpdate(slug, event.previous_id, event.actor)
      // Someone else's change to the list: new rows rise in, rows that leave fade out, and the rest slide.
      flip(listEl.current, () =>
        flushSync(() => {
          if (event.type === "issue.created") applySummary(slug, event.issue, true)
          else if (event.type === "issue.updated") applySummary(slug, event.issue)
          else if (event.type === "issue.deleted") removeIssue(slug, event.issue_id, event.number)
          else if (event.type === "issue.moved") dropIssue(slug, event.issue_id)
        }),
      )
    },
    (reconnected) => {
      // Events sent while we were away are gone; refetch what's on screen.
      if (reconnected) {
        invalidate(keys.lists(slug))
        load(key, () => fetchList(slug, filter)).catch(() => {})
      }
    },
  )

  const loadMore = async () => {
    if (!data?.next_cursor) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await fetchList(slug, filter, data.next_cursor)
      setData<IssueList>(key, (list) => {
        if (!list) return page
        const seen = new Set(list.issues.map((i) => i.id))
        return { ...page, issues: [...list.issues, ...page.issues.filter((i) => !seen.has(i.id))] }
      })
    } catch (e) {
      setMoreError(errorMessage(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const counts = data?.counts ?? (filter.label || filter.text ? shown?.counts ?? null : app.counts)
  const filtered = !!(filter.label || filter.text)

  const stateHref = (state: Filter["state"]) => {
    const next = formatQuery({ ...filter, state })
    return appPath(slug, next === "is:open" ? "" : `?q=${encodeURIComponent(next)}`)
  }

  return (
    <Page>
      <SetupChecklist app={app} />
      <div className="list-toolbar">
        <nav className="segmented list-states" aria-label={t("list.states")}>
          <AppLink slug={slug} href={stateHref("open")} aria-current={filter.state === "open" ? "page" : undefined}>
            <StateIcon state="open" size={14} />
            {t("state.open")}
            {counts && <span className="segmented-count">{formatNumber(counts.open)}</span>}
          </AppLink>
          <AppLink slug={slug} href={stateHref("closed")} aria-current={filter.state === "closed" ? "page" : undefined}>
            <StateIcon state="closed" size={14} />
            {t("state.closed")}
            {counts && <span className="segmented-count">{formatNumber(counts.closed)}</span>}
          </AppLink>
        </nav>
        <SearchBox
          query={q}
          filtered={filtered}
          onSubmit={(draft) => go(parseQuery(draft))}
          onClear={() => go({ ...filter, label: "", text: "" })}
        />
        <div className="list-label">
          <MineFilter filter={filter} onChange={go} />
          <FilterMenu query={q} slug={slug} member={!!app.role} review={review} onChange={(next) => go(parseQuery(next))} />
          <SortMenu value={filter.sort ?? "newest"} onChange={(sort) => go({ ...filter, sort: sort === "newest" ? undefined : sort })} />
          <LabelFilter app={app} value={filter.label} onChange={(label) => go({ ...filter, label })} />
        </div>
        <AppLink slug={slug} href={appPath(slug, "/new")} className="btn list-new" data-variant="primary" aria-label={t("list.newIssue")}>
          <PlusIcon size={14} />
          <span className="list-new-text">{t("list.newIssue")}</span>
        </AppLink>
      </div>

      <section
        ref={listEl}
        className="issue-list"
        aria-label={t("list.issues")}
        data-pending={pending || undefined}
        data-reveal={(hadSkeleton.current && !!shown) || undefined}
        aria-busy={pending || undefined}
      >
        {!!error && !shown && <div className="list-empty">{errorMessage(error)}</div>}
        {!shown && !error && <SkeletonRows />}
        {/* Inside the list, where the skeleton was, so it never pushes painted rows down */}
        {!!shown?.pinned?.length && !filtered && <PinStrip slug={slug} issues={shown.pinned.slice(0, 3)} />}
        {shown && shown.issues.length === 0 && (
          filtered ? (
            <NoResults query={[filter.label && `label:${filter.label}`, filter.text].filter(Boolean).join(" ")} onClear={() => go({ ...filter, label: "", text: "" })} />
          ) : filter.state === "closed" ? (
            <NoClosed openHref={stateHref("open")} />
          ) : (
            <NoIssues newIssueHref={appPath(slug, "/new")} />
          )
        )}
        {shown?.issues.map((issue) => (
          <IssueRow key={issue.id} slug={slug} issue={issue} onLabel={onLabel} held={!!review?.held.has(issue.id)} approval={!!review?.approvals.has(issue.id)} />
        ))}
        {shown?.next_cursor && (
          <div className="list-footer">
            <Button onClick={loadMore} disabled={loadingMore || pending}>
              {loadingMore ? t("common.loading") : t("common.loadMore")}
            </Button>
            {moreError && <span className="field-error">{moreError}</span>}
          </div>
        )}
      </section>
    </Page>
  )
}

export function SkeletonRows() {
  return (
    <>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="issue-row skeleton-row">
          <span className="skeleton" style={{ width: 16, height: 16, borderRadius: 8 }} />
          <span className="skeleton-lines">
            <span className="skeleton" style={{ width: `${55 - i * 6}%`, height: 14 }} />
            <span className="skeleton" style={{ width: 180, height: 10 }} />
          </span>
        </div>
      ))}
    </>
  )
}

function LabelFilter({ app, value, onChange }: { app: AppDetail; value: string; onChange: (label: string) => void }) {
  const t = useT()
  const [query, setQuery] = useState("")
  const shown = app.labels.filter((l) => l.name.toLowerCase().includes(query.toLowerCase()))
  return (
    <Menu
      align="end"
      width={280}
      onOpenChange={(open) => !open && setQuery("")}
      trigger={(props) => (
        <button
          type="button"
          className="btn"
          data-variant="default"
          data-active={value ? "" : undefined}
          aria-label={value ? t("list.labelIs", { label: value }) : t("list.filterByLabel")}
          {...props}
        >
          <TagIcon size={14} />
          <span className="filter-text">{value ? value : t("list.label")}</span>
          <ChevronDownIcon size={14} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-filter">
            <div className="input" data-size="small">
              <input placeholder={t("list.filterLabels")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("list.filterLabels")} />
            </div>
          </div>
          <div className="menu-scroll">
            {value && (
              <MenuItem
                onSelect={() => {
                  onChange("")
                  close()
                }}
              >
                {t("list.clearLabel")}
              </MenuItem>
            )}
            {shown.map((label) => (
              <MenuItem
                key={label.id}
                checked={label.name === value}
                description={label.description || undefined}
                onSelect={() => {
                  onChange(label.name === value ? "" : label.name)
                  close()
                }}
              >
                <span className="label-dot" style={{ background: `#${label.color}` }} />
                {label.name}
              </MenuItem>
            ))}
            {shown.length === 0 && <div className="menu-empty">{t("list.noLabels")}</div>}
          </div>
        </>
      )}
    </Menu>
  )
}

/** One issue in a list. In the home feed (`workspace` set) it also names its workspace, and labels don't filter. */
export const IssueRow = memo(function IssueRow({
  slug,
  issue,
  onLabel,
  workspace,
  held = false,
  approval = false,
}: {
  slug: string
  issue: IssueSummary
  onLabel?: (name: string) => void
  workspace?: { name: string; icon_url: string | null }
  /** Help desk team: an agent's draft or an approval waits for review on this request. */
  held?: boolean
  approval?: boolean
}) {
  const t = useT()
  const active = useUntil(issue.activity?.expires_at)
  const href = appPath(slug, `/issues/${issue.number}`)
  return (
    <div className="issue-row" data-key={issue.id}>
      <StateIcon state={visibleState(issue)} />
      <div className="issue-row-main">
        {workspace && (
          <AppLink slug={slug} href={appPath(slug)} className="issue-row-app">
            <AppIcon src={workspace.icon_url} size={14} />
            <span className="issue-row-app-name">{workspace.name}</span>
          </AppLink>
        )}
        <div className="issue-row-title">
          <AppLink slug={slug} href={href} className="issue-title">
            {issue.title}
          </AppLink>
          {issue.labels.map((label) =>
            onLabel ? (
              <button key={label.id} type="button" className="label-button" onClick={() => onLabel(label.name)} title={label.description}>
                <Label name={label.name} color={label.color} />
              </button>
            ) : (
              <span key={label.id} className="label-static" title={label.description}>
                <Label name={label.name} color={label.color} />
              </span>
            ),
          )}
        </div>
        <div className="issue-meta">
          {tr("row.meta", {
            number: <span className="mono">#{issue.number}</span>,
            author: (
              <>
                {actorName(issue.author)}
                {issue.author.type !== "agent" && issue.author.tier && (
                  <>
                    {" "}
                    <TierBadge tier={issue.author.tier} />
                  </>
                )}
              </>
            ),
            time: <Time iso={issue.created_at} />,
          })}
          {issue.private && (
            <span className="row-flag" title={t("row.privateTitle")}>
              <LockIcon size={12} />
              {t("row.private")}
            </span>
          )}
          {issue.hidden && (
            <span className="row-flag" title={t("row.hiddenTitle")}>
              <EyeOffIcon size={12} />
              {t("row.hidden")}
            </span>
          )}
          {(held || approval) && <ReviewFlags held={held} approval={approval} />}
        </div>
      </div>
      <div className="issue-row-side">
        {(issue.votes ?? 0) > 0 && (
          <span className="issue-row-votes" title={t("row.votes", { count: issue.votes ?? 0 })}>
            <ThumbIcon size={14} />
            <span className="mono-num">{formatNumber(issue.votes ?? 0)}</span>
          </span>
        )}
        {active && issue.activity && (
          <span className="issue-row-activity" title={issue.activity.text ?? undefined}>
            <Dots />
            <span className="issue-row-activity-name">{actorName(issue.activity.actor)}</span>
          </span>
        )}
        {issue.assignee && (
          <span title={t("row.assigned", { name: actorName(issue.assignee) })} className="issue-row-assignee">
            <ActorAvatar actor={issue.assignee} size={20} />
          </span>
        )}
        <AppLink
          slug={slug}
          href={href}
          className="issue-row-comments"
          aria-label={t("row.comments", { count: issue.comment_count })}
          data-zero={issue.comment_count === 0 || undefined}
        >
          <CommentIcon size={14} />
          <span className="mono-num">{formatNumber(issue.comment_count)}</span>
        </AppLink>
      </div>
    </div>
  )
})

const sortLabel: Record<IssueSort, PlainKey> = Object.fromEntries(sorts) as Record<IssueSort, PlainKey>

/** How the list is ordered; the choice lives in the query as `sort:votes` and friends. */
function SortMenu({ value, onChange }: { value: IssueSort; onChange: (sort: IssueSort) => void }) {
  const t = useT()
  return (
    <Menu
      align="end"
      width={220}
      trigger={(props) => (
        <button type="button" className="btn list-sort" data-variant="default" aria-label={t("list.sortBy", { sort: tKey(sortLabel[value]) })} {...props}>
          <SortIcon size={14} />
          <span className="filter-text list-sort-text">{tKey(sortLabel[value])}</span>
          <ChevronDownIcon size={14} />
        </button>
      )}
    >
      {(close) =>
        (Object.keys(sortLabel) as IssueSort[]).map((s) => (
          <MenuItem
            key={s}
            checked={s === value}
            onSelect={() => {
              close()
              if (s !== value) onChange(s)
            }}
          >
            {tKey(sortLabel[s])}
          </MenuItem>
        ))
      }
    </Menu>
  )
}

/** Up to three pinned issues, compact, above the rows. */
function PinStrip({ slug, issues }: { slug: string; issues: IssueSummary[] }) {
  const t = useT()
  return (
    <nav className="pin-strip" aria-label={t("list.pinned")}>
      {issues.map((issue) => (
        <AppLink key={issue.id} slug={slug} href={appPath(slug, `/issues/${issue.number}`)} className="pin-card">
          <span className="pin-card-top">
            <PinIcon size={12} />
            <StateIcon state={visibleState(issue)} size={14} />
            <span className="mono pin-card-number">#{issue.number}</span>
          </span>
          <span className="pin-card-title">{issue.title}</span>
        </AppLink>
      ))}
    </nav>
  )
}
