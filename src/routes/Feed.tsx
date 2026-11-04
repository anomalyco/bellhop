import { useCallback, useEffect, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { useLocation, useSearch } from "wouter"
import type { Activity, App, FeedApp, FeedIssue, FeedList, LiveEvent } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { invalidate, load, setData, updateAll, useResource } from "../lib/cache"
import { formatQuery, parseQuery, type Filter } from "../lib/issues"
import { useLive } from "../lib/live"
import { flip, SPRING_30 } from "../lib/motion"
import { RailReports } from "../ui/features/QuickLinks"
import { appPath } from "../lib/site"
import { ArrowUpIcon, PlusIcon } from "../ui/icons"
import { AppIcon, Button, StateIcon } from "../ui/primitives"
import { Header, Page, useMe } from "../ui/Shell"
import { AppLink, SiteLink } from "../ui/SiteLink"
import { NoClosed, NoOpen, NoPublicWorkspaces, NoResults } from "../ui/onboarding/EmptyStates"
import { IssueRow, SearchBox, SkeletonRows } from "./Issues"
import "../styles/feed.css"

export const feedKey = (f: Pick<Filter, "state" | "text">) => `${keys.feed}${f.state}|${f.text}`
export const fetchFeed = (f: Pick<Filter, "state" | "text">, cursor?: string) => api.feed({ state: f.state, q: f.text || undefined, cursor })

const fits = (issue: FeedIssue, key: string) => {
  const [state, text] = key.slice(keys.feed.length).split("|")
  const closed = issue.status === "closed"
  return (state === "closed") === closed && (!text || issue.title.toLowerCase().includes(text.toLowerCase()))
}
const byActivity = (a: FeedIssue, b: FeedIssue) => Date.parse(b.updated_at) - Date.parse(a.updated_at)

/**
 * blhp.app: issues from every public workspace, most recently active first, for everyone. A rail beside it lists
 * your workspaces (signed in) and the public ones; on narrow screens the rail follows the feed.
 */
export function Feed() {
  const { data: me } = useMe()
  const signedIn = !!me?.user
  const search = useSearch()
  const [, navigate] = useLocation()
  const params = new URLSearchParams(search)
  // Old sign-in links were /?next=…; sign-in has its own page now.
  const next = params.get("next")
  useEffect(() => {
    if (next) navigate(`/signin?${new URLSearchParams({ next })}`, { replace: true })
  }, [next, navigate])

  const q = params.get("q") ?? "is:open"
  const filter = parseQuery(q)
  const key = feedKey(filter)
  const { data, error } = useResource<FeedList>(key, () => fetchFeed(filter), 15_000)
  // Keep the previous list on screen (dimmed) while switching tabs or searching, instead of blanking.
  const last = useRef<FeedList | null>(null)
  if (data) last.current = data
  const shown = data ?? (error ? undefined : (last.current ?? undefined))
  const pending = !data && !error && !!shown
  const hadSkeleton = useRef(false)
  if (!shown && !error) hadSkeleton.current = true
  const listEl = useRef<HTMLElement>(null)

  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  // New and newly active issues wait behind a button instead of pushing the list down while someone reads it.
  const [newer, setNewer] = useState<FeedIssue[]>([])
  useEffect(() => setNewer([]), [key])

  const go = useCallback(
    (f: Filter) => {
      const nextQ = formatQuery({ ...f, label: "" })
      navigate(nextQ === "is:open" ? "/" : `/?q=${encodeURIComponent(nextQ)}`)
    },
    [navigate],
  )

  useLive(
    "/api/live/feed",
    (event: LiveEvent) => {
      if (event.type === "feed.issue") {
        const issue = event.issue
        let seen = false
        updateAll<FeedList>(keys.feed, (list) => {
          if (!list.issues.some((i) => i.id === issue.id)) return undefined
          seen = true
          return { ...list, issues: list.issues.map((i) => (i.id === issue.id ? issue : i)) }
        })
        if (!seen && Date.now() - Date.parse(issue.created_at) < 120_000) {
          // Opened just now: one more in its tab's count, in every cached list.
          const tab = issue.status === "closed" ? "closed" : "open"
          updateAll<FeedList>(keys.feed, (list) => ({ ...list, counts: { ...list.counts, [tab]: list.counts[tab] + 1 } }))
        }
        if (!seen && fits(issue, key)) setNewer((list) => [issue, ...list.filter((i) => i.id !== issue.id)])
        else if (seen) setNewer((list) => list.map((i) => (i.id === issue.id ? issue : i)))
      } else if (event.type === "activity") {
        applyFeedActivity(event.issue_id, event.activity)
        setNewer((list) => list.map((i) => (i.id === event.issue_id ? { ...i, activity: event.activity } : i)))
      }
    },
    (reconnected) => {
      if (!reconnected) return
      invalidate(keys.feed)
      load(key, () => fetchFeed(filter)).catch(() => {})
    },
  )

  // The waiting issues join the top of the list: they drop in a few at a time and the rows below slide down.
  const showNewer = () => {
    const ids = new Set(newer.map((i) => i.id))
    flip(
      listEl.current,
      () =>
        flushSync(() => {
          setData<FeedList>(key, (list) => (list ? { ...list, issues: [...[...newer].sort(byActivity), ...list.issues.filter((i) => !ids.has(i.id))] } : list))
          setNewer([])
        }),
      { slide: SPRING_30, enterY: -4, stagger: 30 },
    )
    window.scrollTo({ top: 0, behavior: "smooth" })
  }

  const loadMore = async () => {
    if (!data?.next_cursor) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await fetchFeed(filter, data.next_cursor)
      setData<FeedList>(key, (list) => {
        if (!list) return page
        const ids = new Set(list.issues.map((i) => i.id))
        return { ...page, issues: [...list.issues, ...page.issues.filter((i) => !ids.has(i.id))] }
      })
    } catch (e) {
      setMoreError(errorMessage(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const counts = shown?.counts ?? null
  const searching = !!filter.text
  const stateHref = (state: Filter["state"]) => {
    const nextQ = formatQuery({ ...filter, label: "", state })
    return nextQ === "is:open" ? "/" : `/?q=${encodeURIComponent(nextQ)}`
  }
  const nothingPublic = !!data && !searching && data.counts.open + data.counts.closed === 0

  return (
    <>
      <Header />
      <Page>
        <div className="feed">
          <div className="feed-main">
            {/* Held invisible until the counts arrive, so the tabs don't widen under the reader */}
            <div className="list-toolbar feed-toolbar" data-loading={!counts || undefined}>
              <nav className="segmented list-states" aria-label="Issue state">
                <SiteLink href={stateHref("open")} aria-current={filter.state === "open" ? "page" : undefined}>
                  <StateIcon state="open" size={14} />
                  Open
                  <span className="segmented-count">{counts?.open ?? 0}</span>
                </SiteLink>
                <SiteLink href={stateHref("closed")} aria-current={filter.state === "closed" ? "page" : undefined}>
                  <StateIcon state="closed" size={14} />
                  Closed
                  <span className="segmented-count">{counts?.closed ?? 0}</span>
                </SiteLink>
              </nav>
              <SearchBox
                query={q}
                filtered={searching}
                placeholder="Search public issues"
                onSubmit={(draft) => go(parseQuery(draft))}
                onClear={() => go({ ...filter, text: "" })}
              />
            </div>

            {/* A zero-height sticky slot: the button floats over the top of the list and follows the reader down */}
            <div className="feed-newer-slot">
              {newer.length > 0 && (
                <button type="button" className="feed-newer" onClick={showNewer}>
                  <ArrowUpIcon size={14} />
                  {newer.length === 1 ? "1 newer issue" : `${newer.length} newer issues`}
                </button>
              )}
            </div>

            <section
              ref={listEl}
              className="issue-list"
              aria-label="Public issues"
              data-pending={pending || undefined}
              data-reveal={(hadSkeleton.current && !!shown) || undefined}
              aria-busy={pending || !shown || undefined}
            >
              {!!error && !shown && <div className="list-empty">{errorMessage(error)}</div>}
              {!shown && !error && <SkeletonRows />}
              {shown &&
                shown.issues.length === 0 &&
                (nothingPublic ? (
                  <NoPublicWorkspaces signedIn={signedIn} />
                ) : searching ? (
                  <NoResults query={filter.text} onClear={() => go({ ...filter, text: "" })} />
                ) : filter.state === "closed" ? (
                  <NoClosed openHref="/" />
                ) : (
                  <NoOpen closedHref={stateHref("closed")} />
                ))}
              {shown?.issues.map((issue) => <IssueRow key={issue.id} slug={issue.app.slug} issue={issue} workspace={issue.app} />)}
              {shown?.next_cursor && (
                <div className="list-footer">
                  <Button onClick={loadMore} disabled={loadingMore || pending}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                  {moreError && <span className="field-error">{moreError}</span>}
                </div>
              )}
            </section>
          </div>
          <Rail feedReady={!!shown || !!error} />
        </div>
      </Page>
    </>
  )
}

function applyFeedActivity(issueId: string, activity: Activity | null) {
  updateAll<FeedList>(keys.feed, (list) =>
    list.issues.some((i) => i.id === issueId) ? { ...list, issues: list.issues.map((i) => (i.id === issueId ? { ...i, activity } : i)) } : undefined,
  )
}

/**
 * Your workspaces (signed in) above the public ones. It appears in one piece once everything it shows has loaded,
 * and after the feed, so on narrow screens (where it follows the feed) it never pushes anything around.
 */
function Rail({ feedReady }: { feedReady: boolean }) {
  const { data: me } = useMe()
  const signedIn = !!me?.user
  const { data: mine, error: mineError } = useResource<App[]>(signedIn ? keys.apps : null, api.apps, 10_000)
  const { data: open, error: openError } = useResource<FeedApp[]>(keys.feedApps, api.feedApps, 30_000)
  const ready = feedReady && !!me && (!signedIn || !!mine || !!mineError) && (!!open || !!openError)
  if (!ready) return <aside className="feed-rail" aria-hidden="true" />

  const yours = mine ?? []
  const publicApps = open ?? []
  return (
    <aside className="feed-rail" aria-label="Workspaces">
      <RailReports />
      {signedIn && (
        <section className="rail-section">
          <div className="rail-head">
            <h2 className="rail-title">Your workspaces</h2>
            {yours.length > 0 && (
              <SiteLink href="/new" className="btn" data-variant="default" data-size="small">
                <PlusIcon size={12} />
                New workspace
              </SiteLink>
            )}
          </div>
          {yours.length === 0 ? (
            <div className="rail-prompt">
              <p className="rail-prompt-text">Create your workspace: a support site for your product, answered by your agent.</p>
              <SiteLink href="/new" className="btn" data-variant="default" data-size="small">
                Create your workspace
              </SiteLink>
            </div>
          ) : (
            <ul className="rail-list">
              {yours.slice(0, 6).map((app) => (
                <li key={app.id}>
                  <AppLink slug={app.slug} href={appPath(app.slug)} className="rail-row">
                    <AppIcon src={app.icon_url} size={20} />
                    <span className="rail-name">{app.name}</span>
                  </AppLink>
                </li>
              ))}
              {yours.length > 6 && (
                <li>
                  <SiteLink href="/workspaces" className="rail-row rail-more">
                    All {yours.length} workspaces
                  </SiteLink>
                </li>
              )}
            </ul>
          )}
        </section>
      )}
      {/* With none public the feed's own empty state says so */}
      {publicApps.length > 0 && (
        <section className="rail-section">
          <div className="rail-head">
            <h2 className="rail-title">Public workspaces</h2>
          </div>
          <ul className="rail-list">
            {publicApps.map((app) => (
              <li key={app.slug}>
                <AppLink slug={app.slug} href={appPath(app.slug)} className="rail-row" title={app.description || undefined}>
                  <AppIcon src={app.icon_url} size={20} />
                  <span className="rail-name">{app.name}</span>
                  <span className="rail-count" aria-label={`${app.open_count} open`}>
                    {app.open_count}
                  </span>
                </AppLink>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  )
}
