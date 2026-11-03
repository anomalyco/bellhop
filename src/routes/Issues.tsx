import { useEffect, useState, type FormEvent } from "react"
import { Link, useLocation, useSearch } from "wouter"
import type { AppDetail, IssueList, IssueSummary, LiveEvent } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { invalidate, load, setData, useResource } from "../lib/cache"
import { applyActivity, applySummary, formatQuery, listKey, parseQuery, prefetchIssue, visibleState, type Filter } from "../lib/issues"
import { useLive } from "../lib/live"
import { Time, useUntil } from "../lib/time"
import { ActorAvatar, actorName } from "../ui/Actor"
import { ChevronDownIcon, CommentIcon, PlusIcon, SearchIcon, XIcon } from "../ui/icons"
import { Menu, MenuItem } from "../ui/Menu"
import { AppLayout, Page } from "../ui/Shell"
import { Button, Dots, Label, StateIcon } from "../ui/primitives"

export function Issues({ slug }: { slug: string }) {
  return <AppLayout slug={slug} tab="issues">{(app) => <IssuesBody app={app} />}</AppLayout>
}

function IssuesBody({ app }: { app: AppDetail }) {
  const slug = app.slug
  const search = useSearch()
  const [, navigate] = useLocation()
  const q = new URLSearchParams(search).get("q") ?? "is:open"
  const filter = parseQuery(q)
  const key = listKey(slug, filter)
  const { data, error } = useResource<IssueList>(key, () => api.issues(slug, { state: filter.state, label: filter.label, q: filter.text }))
  const [draft, setDraft] = useState(q)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)

  useEffect(() => setDraft(q), [q])

  const go = (f: Filter) => {
    const next = formatQuery(f)
    navigate(next === "is:open" ? `/${slug}` : `/${slug}?q=${encodeURIComponent(next)}`)
  }

  useLive(
    `/api/live/apps/${encodeURIComponent(slug)}`,
    (event: LiveEvent) => {
      if (event.type === "issue.created") applySummary(slug, event.issue, true)
      else if (event.type === "issue.updated") applySummary(slug, event.issue)
      else if (event.type === "activity") applyActivity(slug, event.issue_id, event.activity)
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

  const submitSearch = (e: FormEvent) => {
    e.preventDefault()
    go(parseQuery(draft))
  }

  const counts = data?.counts ?? (filter.label || filter.text ? null : app.counts)
  const filtered = !!(filter.label || filter.text)

  return (
    <Page>
      <div className="list-toolbar">
        <form className="input list-search" onSubmit={submitSearch} role="search">
          <SearchIcon />
          <input
            aria-label="Search issues"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Search issues"
            spellCheck={false}
          />
          {filtered && (
            <button type="button" className="input-clear" aria-label="Clear filters" onClick={() => go({ ...filter, label: "", text: "" })}>
              <XIcon size={14} />
            </button>
          )}
        </form>
        <Link href={`/${slug}/new`} className="btn" data-variant="primary">
          <PlusIcon />
          New issue
        </Link>
      </div>

      <section className="box">
        <div className="box-header list-header">
          <Link
            href={`/${slug}${formatQuery({ ...filter, state: "open" }) === "is:open" ? "" : `?q=${encodeURIComponent(formatQuery({ ...filter, state: "open" }))}`}`}
            className="tab-link"
            aria-current={filter.state === "open" ? "page" : undefined}
          >
            <StateIcon state="open" />
            {counts ? <span className="mono-num">{counts.open}</span> : null} Open
          </Link>
          <Link
            href={`/${slug}?q=${encodeURIComponent(formatQuery({ ...filter, state: "closed" }))}`}
            className="tab-link"
            aria-current={filter.state === "closed" ? "page" : undefined}
          >
            <StateIcon state="closed" />
            {counts ? <span className="mono-num">{counts.closed}</span> : null} Closed
          </Link>
          <span className="spacer" />
          <LabelFilter app={app} value={filter.label} onChange={(label) => go({ ...filter, label })} />
        </div>

        {!!error && !data && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {!data && !error && <SkeletonRows />}
        {data && data.issues.length === 0 && (
          <div className="box-empty">
            {filtered ? (
              <>
                No results.{" "}
                <button type="button" className="link-button" onClick={() => go({ ...filter, label: "", text: "" })}>
                  Clear filters
                </button>
              </>
            ) : filter.state === "open" ? (
              <>
                No open issues. <Link href={`/${slug}/new`}>Open one</Link>
              </>
            ) : (
              "No closed issues."
            )}
          </div>
        )}
        {data?.issues.map((issue) => (
          <IssueRow key={issue.id} slug={slug} issue={issue} onLabel={(label) => go({ ...filter, label })} />
        ))}
        {data?.next_cursor && (
          <div className="box-footer">
            <Button size="small" onClick={loadMore} disabled={loadingMore}>
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
        <div key={i} className="box-row skeleton-row">
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
        <button type="button" className="btn" data-variant="invisible" data-size="small" {...props}>
          {value ? <span className="filter-active">Label: {value}</span> : "Label"}
          <ChevronDownIcon />
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

function IssueRow({ slug, issue, onLabel }: { slug: string; issue: IssueSummary; onLabel: (name: string) => void }) {
  const warm = () => prefetchIssue(slug, issue.number)
  const active = useUntil(issue.activity?.expires_at)
  const href = `/${slug}/issues/${issue.number}`
  return (
    <div className="box-row issue-row">
      <StateIcon state={visibleState(issue)} />
      <div className="issue-row-main">
        <div className="issue-row-title">
          <Link href={href} className="issue-title" onPointerEnter={warm} onFocus={warm}>
            {issue.title}
          </Link>
          {issue.labels.map((label) => (
            <button key={label.id} type="button" className="label-button" onClick={() => onLabel(label.name)} title={label.description}>
              <Label name={label.name} color={label.color} />
            </button>
          ))}
        </div>
        <div className="issue-meta">
          <span className="mono">#{issue.number}</span> opened <Time iso={issue.created_at} /> by {actorName(issue.author)}
        </div>
      </div>
      <div className="issue-row-side">
        {active && issue.activity && (
          <span className="activity issue-row-activity" title={issue.activity.text ?? undefined}>
            <Dots />
            <span className="issue-row-activity-name">{actorName(issue.activity.actor)}</span>
          </span>
        )}
        {issue.assignee && (
          <span title={`Assigned to ${actorName(issue.assignee)}`} className="issue-row-assignee">
            <ActorAvatar actor={issue.assignee} size={20} />
          </span>
        )}
        <Link href={href} className="issue-row-comments" aria-label={`${issue.comment_count} comments`} data-zero={issue.comment_count === 0 || undefined}>
          <CommentIcon />
          <span className="mono-num">{issue.comment_count}</span>
        </Link>
      </div>
    </div>
  )
}
