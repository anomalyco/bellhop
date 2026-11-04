import { useEffect, useRef, useState, type ReactNode } from "react"
import type { IssueRef } from "../../../shared/api"
import { api, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { visibleState } from "../../lib/issues"
import { appPath } from "../../lib/site"
import { StateIcon } from "../primitives"
import "../../styles/features.css"
import { useT } from "../../i18n/core"

/** Titles shorter than this (or with fewer than three letters) don't ask; the server would answer nothing anyway. */
const enough = (t: string) => t.length >= 4 && (t.match(/\p{L}/gu)?.length ?? 0) >= 3

/**
 * Wraps the new-issue title field: while someone types a title, up to five likely duplicates float under it
 * ("Similar issues"), over the form rather than pushing it down. Each opens in a new tab so the draft stays.
 */
export function SimilarIssues({ slug, title, exclude, children }: { slug: string; title: string; exclude?: number[]; children: ReactNode }) {
  const t = useT()
  const trimmed = title.trim()
  const [query, setQuery] = useState("")
  const [focused, setFocused] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setQuery(enough(trimmed) ? trimmed : ""), 300)
    return () => clearTimeout(t)
  }, [trimmed])
  useEffect(() => setDismissed(false), [trimmed])

  const { data } = useResource<IssueRef[]>(query ? keys.similar(slug, query) : null, () => api.similar(slug, query), 60_000)
  // The last answer stays up while the next one loads, so the list doesn't blink between keystrokes.
  const last = useRef<IssueRef[]>([])
  if (data) last.current = data
  if (!query) last.current = []
  const skip = new Set(exclude ?? [])
  const shown = (data ?? last.current).filter((i) => !skip.has(i.number)).slice(0, 5)
  const open = focused && !dismissed && enough(trimmed) && shown.length > 0

  return (
    <div
      ref={root}
      className="similar"
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget as Node | null)) setFocused(false)
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.stopPropagation()
          setDismissed(true)
        }
      }}
    >
      {children}
      {open && (
        <div className="similar-pop" role="region" aria-label={t("similar.title")} onPointerDown={(e) => e.preventDefault()}>
          <p className="similar-head">{t("similar.title")}</p>
          <ul className="similar-list">
            {shown.map((i) => (
              <li key={i.id}>
                <a className="similar-row" href={appPath(slug, `/issues/${i.number}`)} target="_blank" rel="noopener">
                  <StateIcon state={visibleState(i)} size={14} />
                  <span className="similar-title">{i.title}</span>
                  <span className="mono similar-number">#{i.number}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
