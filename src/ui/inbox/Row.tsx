import { memo, type CSSProperties } from "react"
import type { InboxItem } from "../../../shared/api"
import { useT } from "../../i18n/inbox"
import { t as tc } from "../../i18n/core"
import { visibleState } from "../../lib/issues"
import { Time } from "../../lib/time"
import { ActorAvatar, actorName } from "../Actor"
import { ImageIcon } from "../icons"
import { StateIcon } from "../primitives"
import { SiteLink } from "../SiteLink"
import "../../styles/inbox.css"

const statusText = (i: InboxItem) => (i.status === "closed" ? null : i.status === "open" ? null : tc(`state.${i.status}`))

const platformNames: Record<string, string> = { ios: "iOS", ipados: "iPadOS", android: "Android", macos: "macOS", web: "Web", windows: "Windows", linux: "Linux" }
/** "ios" as iOS, and so on; anything else as sent. */
export const platformName = (p: string) => platformNames[p.toLowerCase()] ?? p

/**
 * One feedback in the inbox, always two lines of the same height: the title, a preview and the age; then the
 * details in a fixed order (number, the app when the list mixes apps, who sent it, platform and version,
 * screenshots, labels, status, assignee), cut short rather than wrapped.
 */
export const InboxRow = memo(function InboxRow({
  item,
  href,
  open,
  cursor,
  showApp,
  onOpen,
}: {
  item: InboxItem
  href: string
  open: boolean
  cursor: boolean
  showApp: boolean
  onOpen: (i: InboxItem) => void
}) {
  const t = useT()
  const fb = item.feedback_summary
  const status = statusText(item)
  // The feedback API names the reporter after the app's user, or "Anonymous" when it gave none
  const name = item.author.type === "guest" && item.author.name && item.author.name !== "Anonymous" ? item.author.name : null
  const reporter = !fb
    ? { text: actorName(item.author), title: undefined }
    : fb.anonymous
      ? { text: t("row.anon"), title: t("row.anonymous") }
      : name
        ? { text: name, title: fb.email ? t("row.email") : undefined }
        : fb.email
          ? { text: t("row.byEmail"), title: t("row.email") }
          : { text: t("row.anon"), title: t("row.noContact") }
  return (
    <SiteLink
      href={href}
      className="inbox-row"
      data-key={item.id}
      data-open={open || undefined}
      data-cursor={cursor || undefined}
      data-closed={item.status === "closed" || undefined}
      aria-current={open ? "true" : undefined}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        onOpen(item)
      }}
    >
      <span className="inbox-row-top">
        <span className="inbox-row-title">{item.title}</span>
        {item.preview && <span className="inbox-row-preview">{item.preview}</span>}
        <span className="inbox-row-age">
          <Time iso={item.updated_at} />
        </span>
      </span>
      <span className="inbox-row-meta">
        <span className="inbox-row-number">#{item.number}</span>
        {showApp && <span className="inbox-row-app">{item.app.name}</span>}
        <span className="inbox-row-reporter" title={reporter.title}>
          {reporter.text}
        </span>
        {(fb?.platform || fb?.app_version) && (
          <span className="inbox-row-device">
            {fb.platform && platformName(fb.platform)}
            {fb.app_version && <span className="mono inbox-row-version">{fb.app_version}</span>}
          </span>
        )}
        {!!fb?.screenshots && (
          <span className="inbox-row-shots" title={t("row.screenshots", { count: fb.screenshots })}>
            <ImageIcon size={12} />
            {fb.screenshots}
          </span>
        )}
        {item.labels.length > 0 && (
          <span className="inbox-row-labels">
            {item.labels.map((l) => (
              <span key={l.id} className="inbox-row-label" style={{ "--label": `#${l.color}` } as CSSProperties}>
                {l.name}
              </span>
            ))}
          </span>
        )}
        {(status || item.status === "closed") && (
          <span className="inbox-row-status">
            <StateIcon state={visibleState(item)} size={12} />
            {status}
          </span>
        )}
        {item.assignee && (
          <span className="inbox-row-assignee" title={t("row.assigned", { name: actorName(item.assignee) })}>
            <ActorAvatar actor={item.assignee} size={16} />
          </span>
        )}
      </span>
    </SiteLink>
  )
})
