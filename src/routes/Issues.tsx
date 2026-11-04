import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { useLocation, useSearch } from "wouter"
import type { AppDetail, IssueList, IssueSort, IssueSummary, LiveEvent } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { invalidate, load, setData, useResource } from "../lib/cache"
import { applyActivity, applyActorUpdate, applySummary, dropIssue, fetchList, formatQuery, listKey, parseQuery, removeIssue, visibleState, type Filter } from "../lib/issues"
import { useLive } from "../lib/live"
import { appPath } from "../lib/site"
import { Time, useUntil } from "../lib/time"
import { ActorAvatar, actorName } from "../ui/Actor"
import { ChevronDownIcon, CommentIcon, EyeOffIcon, LockIcon, PinIcon, PlusIcon, SearchIcon, SortIcon, TagIcon, ThumbIcon, XIcon } from "../ui/icons"
import { Menu, MenuItem } from "../ui/Menu"
import { AppIcon, Button, Dots, Label, StateIcon } from "../ui/primitives"
import { AppLayout, Page } from "../ui/Shell"
import { AppLink } from "../ui/SiteLink"
import { NoClosed, NoIssues, NoResults } from "../ui/onboarding/EmptyStates"
import { SetupChecklist, useSetupChecklistSettled } from "../ui/onboarding/SetupChecklist"

export function Issues({ slug }: { slug: string }) {
  return (
    <AppLayout slug={slug} tab="issues" loading={<IssuesLoading slug={slug} />}>
      {(app) => <IssuesBody app={app} />}
    </AppLayout>
  )
}

function IssuesLoading({ slug }: { slug: string }) {
  const search = useSearch()
  const q = new URLSearchParams(search).get("q") ?? "is:open"
  const filter = parseQuery(q)
  const stateHref = (state: Filter["state"]) => {
    const next = formatQuery({ ...filter, state })
    return appPath(slug, next === "is:open" ? "" : `?q=${encodeURIComponent(next)}`)
  }
  return (
    <Page>
      <div className="list-toolbar">
        <nav className="segmented list-states" aria-label="Issue state">
          <AppLink slug={slug} href={stateHref("open")} aria-current={filter.state === "open" ? "page" : undefined}>
            <StateIcon state="open" size={14} />
            Open
          </AppLink>
          <AppLink slug={slug} href={stateHref("closed")} aria-current={filter.state === "closed" ? "page" : undefined}>
            <StateIcon state="closed" size={14} />
            Closed
          </AppLink>
        </nav>
        <div className="input list-search">
          <SearchIcon size={14} />
          <input aria-label="Search issues" defaultValue={q} placeholder="Search issues" spellCheck={false} readOnly />
        </div>
        <div className="list-label">
          <button type="button" className="btn list-sort" data-variant="default" disabled>
            <SortIcon size={14} />
            <span className="filter-text list-sort-text">{sortLabel[filter.sort ?? "newest"]}</span>
            <ChevronDownIcon size={14} />
          </button>
          <button type="button" className="btn" data-variant="default" data-active={filter.label ? "" : undefined} disabled>
            <TagIcon size={14} />
            <span className="filter-text">{filter.label || "Label"}</span>
            <ChevronDownIcon size={14} />
          </button>
        </div>
        <AppLink slug={slug} href={appPath(slug, "/new")} className="btn list-new" data-variant="primary">
          <PlusIcon size={14} />
          New issue
        </AppLink>
      </div>
      <section className="issue-list" aria-label="Issues">
        <SkeletonRows />
      </section>
    </Page>
  )
}

export function SearchBox({
  query,
  filtered,
  placeholder = "Search issues",
  onSubmit,
  onClear,
}: {
  query: string
  filtered: boolean
  placeholder?: string
  onSubmit: (draft: string) => void
  onClear: () => void
}) {
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
        <button type="button" className="input-clear" aria-label="Clear filters" onClick={onClear}>
          <XIcon size={14} />
        </button>
      )}
    </form>
  )
}

function IssuesBody({ app }: { app: AppDetail }) {
  // For admins the setup checklist sits above the toolbar; keep the skeleton until it knows whether it shows, so
  // it never pushes a painted toolbar down.
  if (!useSetupChecklistSettled(app)) return <IssuesLoading slug={app.slug} />
  return <IssuesList app={app} />
}

function IssuesList({ app }: { app: AppDetail }) {
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
  const shown = data ?? (error ? undefined : lastList.current?.list)
  const pending = !data && !error && !!shown

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
      if (event.type === "issue.created") applySummary(slug, event.issue, true)
      else if (event.type === "issue.updated") applySummary(slug, event.issue)
      else if (event.type === "activity") applyActivity(slug, event.issue_id, event.activity)
      else if (event.type === "actor.updated") applyActorUpdate(slug, event.previous_id, event.actor)
      else if (event.type === "issue.deleted") removeIssue(slug, event.issue_id, event.number)
      else if (event.type === "issue.moved") dropIssue(slug, event.issue_id)
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
        <nav className="segmented list-states" aria-label="Issue state">
          <AppLink slug={slug} href={stateHref("open")} aria-current={filter.state === "open" ? "page" : undefined}>
            <StateIcon state="open" size={14} />
            Open
            {counts && <span className="segmented-count">{counts.open}</span>}
          </AppLink>
          <AppLink slug={slug} href={stateHref("closed")} aria-current={filter.state === "closed" ? "page" : undefined}>
            <StateIcon state="closed" size={14} />
            Closed
            {counts && <span className="segmented-count">{counts.closed}</span>}
          </AppLink>
        </nav>
        <SearchBox
          query={q}
          filtered={filtered}
          onSubmit={(draft) => go(parseQuery(draft))}
          onClear={() => go({ ...filter, label: "", text: "" })}
        />
        <div className="list-label">
          <SortMenu value={filter.sort ?? "newest"} onChange={(sort) => go({ ...filter, sort: sort === "newest" ? undefined : sort })} />
          <LabelFilter app={app} value={filter.label} onChange={(label) => go({ ...filter, label })} />
        </div>
        <AppLink slug={slug} href={appPath(slug, "/new")} className="btn list-new" data-variant="primary">
          <PlusIcon size={14} />
          New issue
        </AppLink>
      </div>

      <section className="issue-list" aria-label="Issues" data-pending={pending || undefined} aria-busy={pending || undefined}>
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
          <IssueRow key={issue.id} slug={slug} issue={issue} onLabel={onLabel} />
        ))}
        {shown?.next_cursor && (
          <div className="list-footer">
            <Button onClick={loadMore} disabled={loadingMore || pending}>
              {loadingMore ? "Loading…" : "Load more"}
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
          aria-label={value ? `Label: ${value}` : "Filter by label"}
          {...props}
        >
          <TagIcon size={14} />
          <span className="filter-text">{value ? value : "Label"}</span>
          <ChevronDownIcon size={14} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-filter">
            <div className="input" data-size="small">
              <input placeholder="Filter labels" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter labels" />
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
                Clear label filter
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
            {shown.length === 0 && <div className="menu-empty">No labels.</div>}
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
}: {
  slug: string
  issue: IssueSummary
  onLabel?: (name: string) => void
  workspace?: { name: string; icon_url: string | null }
}) {
  const active = useUntil(issue.activity?.expires_at)
  const href = appPath(slug, `/issues/${issue.number}`)
  return (
    <div className="issue-row">
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
          <span className="mono">#{issue.number}</span> · {actorName(issue.author)} opened <Time iso={issue.created_at} />
          {issue.private && (
            <span className="row-flag" title="Only the team and the reporter can see it">
              <LockIcon size={12} />
              Private
            </span>
          )}
          {issue.hidden && (
            <span className="row-flag" title="Hidden by a moderator; only the team can see it">
              <EyeOffIcon size={12} />
              Hidden
            </span>
          )}
        </div>
      </div>
      <div className="issue-row-side">
        {(issue.votes ?? 0) > 0 && (
          <span className="issue-row-votes" title={`${issue.votes} ${issue.votes === 1 ? "person has" : "people have"} this too`}>
            <ThumbIcon size={14} />
            <span className="mono-num">{issue.votes}</span>
          </span>
        )}
        {active && issue.activity && (
          <span className="issue-row-activity" title={issue.activity.text ?? undefined}>
            <Dots />
            <span className="issue-row-activity-name">{actorName(issue.activity.actor)}</span>
          </span>
        )}
        {issue.assignee && (
          <span title={`Assigned to ${actorName(issue.assignee)}`} className="issue-row-assignee">
            <ActorAvatar actor={issue.assignee} size={20} />
          </span>
        )}
        <AppLink
          slug={slug}
          href={href}
          className="issue-row-comments"
          aria-label={`${issue.comment_count} comments`}
          data-zero={issue.comment_count === 0 || undefined}
        >
          <CommentIcon size={14} />
          <span className="mono-num">{issue.comment_count}</span>
        </AppLink>
      </div>
    </div>
  )
})

const sortLabel: Record<IssueSort, string> = {
  newest: "Newest",
  oldest: "Oldest",
  votes: "Most votes",
  updated: "Recently updated",
  comments: "Most comments",
}

/** How the list is ordered; the choice lives in the query as `sort:votes` and friends. */
function SortMenu({ value, onChange }: { value: IssueSort; onChange: (sort: IssueSort) => void }) {
  return (
    <Menu
      align="end"
      width={220}
      trigger={(props) => (
        <button type="button" className="btn list-sort" data-variant="default" aria-label={`Sort: ${sortLabel[value]}`} {...props}>
          <SortIcon size={14} />
          <span className="filter-text list-sort-text">{sortLabel[value]}</span>
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
            {sortLabel[s]}
          </MenuItem>
        ))
      }
    </Menu>
  )
}

/** Up to three pinned issues, compact, above the rows. */
function PinStrip({ slug, issues }: { slug: string; issues: IssueSummary[] }) {
  return (
    <nav className="pin-strip" aria-label="Pinned issues">
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
