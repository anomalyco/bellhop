import type { ReactNode } from "react"
import { IssueOpenIcon, PlusIcon, SearchIcon } from "../icons"
import { Button, StateIcon } from "../primitives"
import { SiteLink } from "../SiteLink"
import "../../styles/onboarding.css"

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
  return (
    <Empty
      icon={<IssueOpenIcon size={20} />}
      title="No issues yet"
      action={
        <SiteLink href={newIssueHref} className="btn" data-variant="primary">
          <PlusIcon size={14} />
          New issue
        </SiteLink>
      }
    >
      Found a bug or have a question? Open the first issue; you don't need an account.
    </Empty>
  )
}

/** A search or label filter that matches nothing. */
export function NoResults({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <Empty
      icon={<SearchIcon size={20} />}
      title={
        <>
          No issues match <span className="empty-query">{query}</span>
        </>
      }
      action={<Button onClick={onClear}>Clear search</Button>}
    >
      Try fewer words, or check the closed issues.
    </Empty>
  )
}

/** The Closed tab before anything has been closed. */
export function NoClosed({ openHref }: { openHref?: string }) {
  return (
    <Empty
      icon={<StateIcon state="closed" size={20} />}
      title="No closed issues"
      action={
        openHref ? (
          <SiteLink href={openHref} className="btn" data-variant="invisible">
            View open issues
          </SiteLink>
        ) : undefined
      }
    >
      Issues land here once they're resolved or closed.
    </Empty>
  )
}
