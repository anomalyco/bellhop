import { memo } from "react"
import type { InboxItem } from "../../../shared/api"
import { useT } from "../../i18n/inbox"
import { t as tc } from "../../i18n/core"
import { visibleState } from "../../lib/issues"
import { Time } from "../../lib/time"
import { ActorAvatar, actorName } from "../Actor"
import { ImageIcon, MailIcon } from "../icons"
import { AppIcon, Label, StateIcon } from "../primitives"
import { SiteLink } from "../SiteLink"
import "../../styles/inbox.css"

const statusText = (i: InboxItem) => (i.status === "closed" ? null : i.status === "open" ? null : tc(`state.${i.status}`))

/**
 * One feedback in the inbox: the app's icon, the title (and a preview when the server sends one), then a mono line
 * with the number, platform and version, screenshots, the reply address or anonymity, labels, status and age.
 */
export const InboxRow = memo(function InboxRow({ item, href, open, cursor, onOpen }: { item: InboxItem; href: string; open: boolean; cursor: boolean; onOpen: (i: InboxItem) => void }) {
  const t = useT()
  const fb = item.feedback_summary
  const preview = (item as InboxItem & { preview?: string | null }).preview
  const status = statusText(item)
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
      <span className="inbox-row-icon" title={item.app.name}>
        <AppIcon src={item.app.icon_url} size={18} name={item.app.name} />
      </span>
      <span className="inbox-row-main">
        <span className="inbox-row-top">
          <span className="inbox-row-title">{item.title}</span>
          {preview && <span className="inbox-row-preview">{preview}</span>}
          <span className="inbox-row-age">
            <Time iso={item.updated_at} />
          </span>
        </span>
        <span className="inbox-row-meta">
          <span className="mono inbox-row-number">#{item.number}</span>
          <span className="inbox-row-app">{item.app.name}</span>
          {fb?.platform && <span className="mono">{fb.platform}</span>}
          {fb?.app_version && <span className="mono">{fb.app_version}</span>}
          {!!fb?.screenshots && (
            <span className="inbox-row-flag" title={t("row.screenshots", { count: fb.screenshots })}>
              <ImageIcon size={12} />
              <span className="mono">{fb.screenshots}</span>
            </span>
          )}
          {fb?.anonymous ? (
            <span className="inbox-row-flag" title={t("row.anonymous")}>
              {t("row.anon")}
            </span>
          ) : (
            fb?.email && (
              <span className="inbox-row-flag" title={t("row.email")} aria-label={t("row.email")}>
                <MailIcon size={12} />
              </span>
            )
          )}
          {item.labels.map((l) => (
            <Label key={l.id} name={l.name} color={l.color} />
          ))}
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
      </span>
    </SiteLink>
  )
})
