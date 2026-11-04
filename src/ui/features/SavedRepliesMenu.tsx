import { useState, type KeyboardEvent } from "react"
import type { SavedReply } from "../../../shared/api"
import { api, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { appPath } from "../../lib/site"
import { Menu, MenuItem } from "../Menu"
import { Button } from "../primitives"
import { AppLink } from "../SiteLink"
import "../../styles/insights.css"
import { useT } from "../../i18n/core"

/** A speech bubble with lines: the saved-replies button in the composer. */
function RepliesIcon({ size = 16 }: { size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.75 3.25h10.5v7.5H8.5l-3 2.5v-2.5H2.75z" />
      <path d="M5.25 6h5.5M5.25 8.25h3.5" />
    </svg>
  )
}

/** The reply's body with `{reporter}` as the reporter's display name. */
export const fillReply = (body: string, reporter: string) => body.replaceAll("{reporter}", reporter)

/** A one-line plain-text preview of markdown for the menu. */
const plain = (md: string) =>
  md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`~#>]+/g, "")
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()

/**
 * The team's saved replies in the composer: a menu with a filter (focused on open; Enter takes the first match,
 * arrows move, Escape closes) that inserts the chosen reply with {reporter} filled in.
 */
export function SavedRepliesMenu({ slug, reporter, onInsert }: { slug: string; reporter: string; onInsert: (text: string) => void }) {
  const t = useT()
  const { data } = useResource<SavedReply[]>(keys.savedReplies(slug), () => api.savedReplies(slug), 30_000)
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const replies = [...(data ?? [])].sort((a, b) => a.name.localeCompare(b.name)).filter((r) => !q || r.name.toLowerCase().includes(q) || r.body.toLowerCase().includes(q))
  return (
    <Menu
      align="end"
      width={320}
      onOpenChange={(open) => !open && setQuery("")}
      trigger={(p) => <Button iconOnly aria-label={t("replies.title")} title={t("replies.title")} icon={<RepliesIcon />} {...p} />}
    >
      {(close) => {
        const pick = (r: SavedReply) => {
          close()
          onInsert(fillReply(r.body, reporter))
        }
        const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === "Enter" && replies[0]) {
            e.preventDefault()
            pick(replies[0])
          }
        }
        return (
          <div className="replies-menu">
            <div className="menu-filter">
              <div className="input" data-size="small">
                <input placeholder={t("replies.title")} aria-label={t("replies.filter")} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
              </div>
            </div>
            <div className="menu-scroll">
              {!data && <div className="menu-empty">{t("common.loading")}</div>}
              {data && replies.length === 0 && <div className="menu-empty">{data.length ? t("replies.noMatches") : t("replies.none")}</div>}
              {replies.map((r) => (
                <MenuItem key={r.id} description={plain(fillReply(r.body, reporter)).slice(0, 140)} onSelect={() => pick(r)}>
                  {r.name}
                </MenuItem>
              ))}
            </div>
            <AppLink slug={slug} href={appPath(slug, "/settings/saved-replies")} className="replies-manage" onClick={() => close()}>
              {t("replies.manage")}
            </AppLink>
          </div>
        )
      }}
    </Menu>
  )
}
