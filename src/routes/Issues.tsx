import { memo, useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { useLocation, useSearch } from "wouter"
import type { AppDetail, IssueList, IssueSummary, LiveEvent } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { invalidate, load, setData, useResource } from "../lib/cache"
import { applyActivity, applyActorUpdate, applySummary, formatQuery, listKey, parseQuery, visibleState, type Filter } from "../lib/issues"
import { useLive } from "../lib/live"
import { appPath } from "../lib/site"
import { Time, useUntil } from "../lib/time"
import { ActorAvatar, actorName } from "../ui/Actor"
import { ChevronDownIcon, CommentIcon, PlusIcon, SearchIcon, TagIcon, XIcon } from "../ui/icons"
import { Menu, MenuItem } from "../ui/Menu"
import { Button, Dots, Label, StateIcon } from "../ui/primitives"
import { AppLayout, Page } from "../ui/Shell"
import { AppLink } from "../ui/SiteLink"

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
          <button type="button" className="btn" data-variant="default" disabled>
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

function SearchBox({
  query,
  filtered,
  onSubmit,
  onClear,
}: {
  query: string
  filtered: boolean
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
        aria-label="Search issues"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search issues"
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
  const slug = app.slug
  const search = useSearch()
  const [, navigate] = useLocation()
  const q = new URLSearchParams(search).get("q") ?? "is:open"
  const filter = parseQuery(q)
  const key = listKey(slug, filter)
  const { data, error } = useResource<IssueList>(key, () => api.issues(slug, { state: filter.state, label: filter.label, q: filter.text }))
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
    },
    (reconnected) => {
      // Events sent while we were away are gone; refetch what's on screen.
      if (reconnected) {
        invalidate(keys.lists(slug))
        load(key, () => api.issues(slug, { state: filter.state, label: filter.label, q: filter.text })).catch(() => {})
      }
    },
  )

  const loadMore = async () => {
    if (!data?.next_cursor) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await api.issues(slug, { state: filter.state, label: filter.label, q: filter.text, cursor: data.next_cursor })
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
        {shown && shown.issues.length === 0 && (
          <div className="list-empty">
            {filtered ? (
              <>
                No results.{" "}
                <button type="button" className="link-button" onClick={() => go({ ...filter, label: "", text: "" })}>
                  Clear filters
                </button>
              </>
            ) : filter.state === "open" ? (
              <>
                No open issues. <AppLink slug={slug} href={appPath(slug, "/new")}>Open one</AppLink>
              </>
            ) : (
              "No closed issues."
            )}
          </div>
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

function SkeletonRows() {
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
        <button type="button" className="btn" data-variant="default" data-active={value ? "" : undefined} {...props}>
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

const IssueRow = memo(function IssueRow({
  slug,
  issue,
  onLabel,
}: {
  slug: string
  issue: IssueSummary
  onLabel: (name: string) => void
}) {
  const active = useUntil(issue.activity?.expires_at)
  const href = appPath(slug, `/issues/${issue.number}`)
  return (
    <div className="issue-row">
      <StateIcon state={visibleState(issue)} />
      <div className="issue-row-main">
        <div className="issue-row-title">
          <AppLink slug={slug} href={href} className="issue-title">
            {issue.title}
          </AppLink>
          {issue.labels.map((label) => (
            <button key={label.id} type="button" className="label-button" onClick={() => onLabel(label.name)} title={label.description}>
              <Label name={label.name} color={label.color} />
            </button>
          ))}
        </div>
        <div className="issue-meta">
          <span className="mono">#{issue.number}</span> · {actorName(issue.author)} opened <Time iso={issue.created_at} />
        </div>
      </div>
      <div className="issue-row-side">
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
