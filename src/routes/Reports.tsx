import { useState } from "react"
import { useSearch } from "wouter"
import type { FeedList } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { setData, useResource } from "../lib/cache"
import { Button, StateIcon } from "../ui/primitives"
import { Header, Page, useMe } from "../ui/Shell"
import { SiteLink } from "../ui/SiteLink"
import { IssueRow, SkeletonRows } from "./Issues"
import "../styles/feed.css"
import "../styles/features.css"

type State = "open" | "closed"

/**
 * /reports on the home domain: every issue this browser (any guest id it used) or the signed-in account opened,
 * across workspaces, newest activity first. Private ones are included and marked; nothing hidden or deleted.
 */
export function ReportsPage() {
  const { data: me } = useMe()
  const state: State = new URLSearchParams(useSearch()).get("state") === "closed" ? "closed" : "open"
  const key = `${keys.reports}${state}`
  const { data, error } = useResource<FeedList>(key, () => api.myReports({ state }), 10_000)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const signedIn = me ? !!me.user : null

  const loadMore = async () => {
    if (!data?.next_cursor) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await api.myReports({ state, cursor: data.next_cursor })
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

  const counts = data?.counts
  return (
    <>
      <Header />
      <Page>
        <div className="reports">
          <div className="reports-head">
            <h1 className="page-title">Your reports</h1>
            <p className="reports-lede">
              {signedIn === false
                ? "Issues you opened from this browser, in every workspace. Sign in to keep them with your account."
                : "Issues you opened, in every workspace, including from this browser before you signed in."}
            </p>
          </div>
          <div className="reports-toolbar" data-loading={!counts || undefined}>
            <nav className="segmented list-states" aria-label="Issue state">
              <SiteLink href="/reports" aria-current={state === "open" ? "page" : undefined}>
                <StateIcon state="open" size={14} />
                Open
                <span className="segmented-count">{counts?.open ?? 0}</span>
              </SiteLink>
              <SiteLink href="/reports?state=closed" aria-current={state === "closed" ? "page" : undefined}>
                <StateIcon state="closed" size={14} />
                Closed
                <span className="segmented-count">{counts?.closed ?? 0}</span>
              </SiteLink>
            </nav>
          </div>
          <section className="issue-list" aria-label="Your reports" aria-busy={!data || undefined}>
            {!!error && !data && <div className="list-empty">{errorMessage(error)}</div>}
            {!data && !error && <SkeletonRows />}
            {data?.issues.length === 0 && (
              <div className="blank">
                <h2 className="blank-title">{state === "open" ? "No open reports" : "No closed reports"}</h2>
                <p>
                  {state === "open"
                    ? "When you open an issue in any workspace, it shows up here so you can find your way back."
                    : "Issues you opened that were closed show up here."}
                </p>
              </div>
            )}
            {data?.issues.map((issue) => <IssueRow key={issue.id} slug={issue.app.slug} issue={issue} workspace={issue.app} />)}
            {data?.next_cursor && (
              <div className="list-footer">
                <Button onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "Loading…" : "Load more"}
                </Button>
                {moreError && <span className="field-error">{moreError}</span>}
              </div>
            )}
          </section>
        </div>
      </Page>
    </>
  )
}
