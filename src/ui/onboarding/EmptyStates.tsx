import type { ReactNode } from "react"
import { IssueOpenIcon, PlusIcon, SearchIcon } from "../icons"
import { Button, StateIcon } from "../primitives"
import { SiteLink } from "../SiteLink"
import "../../styles/onboarding.css"
import { tr, useT } from "../../i18n/core"

function Empty({ icon, title, children, action }: { icon: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty" role="status">
      <span className="empty-icon" aria-hidden="true">
        {icon}
      </span>
      <p className="empty-title">{title}</p>
      {children && <p className="empty-text">{children}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  )
}

/** A workspace with no issues at all, as a visitor sees it. */
export function NoIssues({ newIssueHref }: { newIssueHref: string }) {
  const t = useT()
  return (
    <Empty
      icon={<IssueOpenIcon size={20} />}
      title={t("empty.noIssues")}
      action={
        <SiteLink href={newIssueHref} className="btn" data-variant="primary">
          <PlusIcon size={14} />
          {t("list.newIssue")}
        </SiteLink>
      }
    >
      {t("empty.noIssuesText")}
    </Empty>
  )
}

/** The home feed when no workspace is public yet: start one, or sign in to. */
export function NoPublicWorkspaces({ signedIn }: { signedIn: boolean }) {
  const t = useT()
  return (
    <Empty
      icon={<IssueOpenIcon size={20} />}
      title={t("empty.noPublic")}
      action={
        <SiteLink href={signedIn ? "/new" : "/signin?next=%2Fnew"} className="btn" data-variant="primary">
          {signedIn ? t("empty.createWorkspace") : t("empty.signInToCreate")}
        </SiteLink>
      }
    >
      {t("empty.noPublicText")}
    </Empty>
  )
}

/** The home feed's Open tab when everything public is closed. */
export function NoOpen({ closedHref }: { closedHref: string }) {
  const t = useT()
  return (
    <Empty
      icon={<StateIcon state="open" size={20} />}
      title={t("empty.noOpen")}
      action={
        <SiteLink href={closedHref} className="btn" data-variant="invisible">
          {t("empty.viewClosed")}
        </SiteLink>
      }
    >
      {t("empty.noOpenText")}
    </Empty>
  )
}

/** A search or label filter that matches nothing. */
export function NoResults({ query, onClear }: { query: string; onClear: () => void }) {
  const t = useT()
  return (
    <Empty
      icon={<SearchIcon size={20} />}
      title={tr("empty.noMatch", { query: <span className="empty-query">{query}</span> })}
      action={<Button onClick={onClear}>{t("empty.clearSearch")}</Button>}
    >
      {t("empty.noMatchText")}
    </Empty>
  )
}

/** The Closed tab before anything has been closed. */
export function NoClosed({ openHref }: { openHref?: string }) {
  const t = useT()
  return (
    <Empty
      icon={<StateIcon state="closed" size={20} />}
      title={t("empty.noClosed")}
      action={
        openHref ? (
          <SiteLink href={openHref} className="btn" data-variant="invisible">
            {t("empty.viewOpen")}
          </SiteLink>
        ) : undefined
      }
    >
      {t("empty.noClosedText")}
    </Empty>
  )
}
