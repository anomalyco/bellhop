import { useLocation, useSearch } from "wouter"
import type { AppDetail, IssueList, IssueSummary } from "../../../shared/api"
import { formatNumber } from "../../i18n"
import { t as tc, useT as useCoreT } from "../../i18n/core"
import { tr, useT } from "../../i18n/helpdesk"
import { errorMessage } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { contactSignInHref } from "../../lib/helpdesk"
import { fetchList, formatQuery, listKey, parseQuery, visibleState } from "../../lib/issues"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { PlusIcon } from "../../ui/icons"
import { AppIcon, StateLabel } from "../../ui/primitives"
import { Page, useMe } from "../../ui/Shell"
import { AppLink } from "../../ui/SiteLink"

/**
 * A help desk's home for requesters: "How can we help?" with the workspace's own mark, New request, and the
 * requester's own requests (only theirs: the server never lists anyone else's). Signed out, a quiet prompt to sign
 * in by email. There is no public list.
 */
export function DeskHome({ app }: { app: AppDetail }) {
  const t = useT()
  useCoreT()
  const slug = app.slug
  const [, navigate] = useLocation()
  const q = new URLSearchParams(useSearch()).get("q") ?? "is:open"
  const filter = parseQuery(q)
  const state = filter.state === "closed" ? "closed" : "open"
  const { data: me } = useMe()
  const { data: list, error } = useResource<IssueList>(listKey(slug, filter), () => fetchList(slug, filter))
  const contact = me?.contact ?? null
  const counts = list?.counts
  const hasAny = !!counts && counts.open + counts.closed > 0
  const go = (s: "open" | "closed") => {
    const next = formatQuery({ ...filter, state: s })
    navigate(appPath(slug, next === "is:open" ? "" : `?q=${encodeURIComponent(next)}`))
  }

  return (
    <Page>
      <div className="desk-home">
        <section className="desk-hero">
          <AppIcon src={app.icon_url} size={44} name={app.name} />
          <h1 className="desk-hero-title">{t("home.title")}</h1>
          <p className="desk-hero-lede">{app.description || t("home.lede")}</p>
          <AppLink slug={slug} href={appPath(slug, "/new")} className="btn" data-variant="primary" data-size="large">
            <PlusIcon size={14} />
            {t("home.newRequest")}
          </AppLink>
        </section>

        {/* Held until the list arrives (it comes with the page), so nothing below the hero moves */}
        {(list || !!error) && (
          <section aria-labelledby="desk-requests">
            {(contact || hasAny) && (
              <div className="desk-section-head">
                <h2 id="desk-requests" className="desk-section-title">
                  {t("home.yourRequests")}
                </h2>
                {hasAny && (
                  <nav className="segmented" aria-label={t("home.states")}>
                    {(["open", "closed"] as const).map((s) => (
                      <button key={s} type="button" aria-current={state === s ? "page" : undefined} aria-pressed={state === s} onClick={() => go(s)}>
                        {tc(s === "open" ? "state.open" : "state.closed")}
                        <span className="segmented-count">{formatNumber(counts![s])}</span>
                      </button>
                    ))}
                  </nav>
                )}
              </div>
            )}
            {!!error && !list && <p className="desk-empty">{errorMessage(error)}</p>}
            {list && list.issues.length > 0 && (
              <div className="desk-list">
                {list.issues.map((issue) => (
                  <DeskRow key={issue.id} slug={slug} issue={issue} />
                ))}
              </div>
            )}
            {list && list.issues.length === 0 && (contact || hasAny) && (
              <p className="desk-empty">{state === "closed" ? t("home.noneClosed") : t("home.none")}</p>
            )}
            {me && !contact && (
              <div className="desk-prompt">
                <div className="desk-prompt-text">
                  <p className="desk-prompt-title">{t("home.signInTitle")}</p>
                  <p className="desk-prompt-sub">{t("home.signInText")}</p>
                </div>
                <AppLink slug={slug} href={contactSignInHref(slug)} className="btn" data-variant="default">
                  {t("home.signIn")}
                </AppLink>
              </div>
            )}
          </section>
        )}
      </div>
    </Page>
  )
}

/** One of the requester's requests: its state, title, number and last update. */
function DeskRow({ slug, issue }: { slug: string; issue: IssueSummary }) {
  const t = useT()
  const state = visibleState(issue)
  return (
    <AppLink slug={slug} href={appPath(slug, `/issues/${issue.number}`)} className="desk-row">
      <span className="desk-row-main">
        <span className="desk-row-title">{issue.title}</span>
        <span className="desk-row-meta">
          {tr("row.meta", { number: String(issue.number), time: <Time iso={issue.updated_at} /> })}
        </span>
      </span>
      <StateLabel state={state} size="small" text={state === "waiting" ? t("status.waiting") : undefined} />
    </AppLink>
  )
}
