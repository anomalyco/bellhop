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
import { useT } from "../i18n/core"
import { formatNumber } from "../i18n"

type State = "open" | "closed"

/**
 * /reports on the home domain: every issue this browser (any guest id it used) or the signed-in account opened,
 * across workspaces, newest activity first. Private ones are included and marked; nothing hidden or deleted.
 */
export function ReportsPage() {
  const t = useT()
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
            <h1 className="page-title">{t("reports.title")}</h1>
            <p className="reports-lede">
              {signedIn === false
                ? t("reports.ledeGuest")
                : t("reports.lede")}
            </p>
          </div>
          <div className="reports-toolbar" data-loading={!counts || undefined}>
            <nav className="segmented list-states" aria-label={t("list.states")}>
              <SiteLink href="/reports" aria-current={state === "open" ? "page" : undefined}>
                <StateIcon state="open" size={14} />
                {t("state.open")}
                <span className="segmented-count">{formatNumber(counts?.open ?? 0)}</span>
              </SiteLink>
              <SiteLink href="/reports?state=closed" aria-current={state === "closed" ? "page" : undefined}>
                <StateIcon state="closed" size={14} />
                {t("state.closed")}
                <span className="segmented-count">{formatNumber(counts?.closed ?? 0)}</span>
              </SiteLink>
            </nav>
          </div>
          <section className="issue-list" aria-label={t("reports.title")} aria-busy={!data || undefined}>
            {!!error && !data && <div className="list-empty">{errorMessage(error)}</div>}
            {!data && !error && <SkeletonRows />}
            {data?.issues.length === 0 && (
              <div className="blank">
                <h2 className="blank-title">{state === "open" ? t("reports.noOpen") : t("reports.noClosed")}</h2>
                <p>
                  {state === "open"
                    ? t("reports.noOpenText")
                    : t("reports.noClosedText")}
                </p>
              </div>
            )}
            {data?.issues.map((issue) => <IssueRow key={issue.id} slug={issue.app.slug} issue={issue} workspace={issue.app} />)}
            {data?.next_cursor && (
              <div className="list-footer">
                <Button onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? t("common.loading") : t("common.loadMore")}
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
