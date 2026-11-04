import type { Filter } from "../../lib/issues"
import { PersonIcon } from "../icons"
import { SiteLink } from "../SiteLink"
import "../../styles/features.css"

/** For the home feed's rail, for everyone (guests too): the way back to the issues you opened. */
export function RailReports() {
  return (
    <section className="rail-section rail-reports">
      <ul className="rail-list">
        <li>
          <SiteLink href="/reports" className="rail-row">
            <PersonIcon size={16} />
            <span className="rail-name">Your reports</span>
          </SiteLink>
        </li>
      </ul>
    </section>
  )
}

const mine = /(?:^|\s)author:@me(?=\s|$)/i

export const isMine = (f: Filter) => mine.test(f.text)

/** The filter with `author:@me` added or taken out of its free text. */
export function toggleMine(f: Filter): Filter {
  const text = isMine(f) ? f.text.replace(new RegExp(mine.source, "gi"), " ").replace(/\s+/g, " ").trim() : `author:@me ${f.text}`.trim()
  return { ...f, text }
}

/**
 * "Mine" on a workspace's issue list toolbar: issues this browser or account opened (`author:@me`). Pressed while
 * the query has it. Pass `disabled` for the loading skeleton so the toolbar keeps its width.
 */
export function MineFilter({ filter, onChange, disabled }: { filter: Filter; onChange?: (next: Filter) => void; disabled?: boolean }) {
  const on = isMine(filter)
  return (
    <button
      type="button"
      className="btn list-mine"
      data-variant="default"
      data-active={on ? "" : undefined}
      aria-pressed={on}
      aria-label="Mine: issues you opened"
      title="Issues you opened"
      disabled={disabled}
      onClick={() => onChange?.(toggleMine(filter))}
    >
      <PersonIcon size={14} />
      <span className="filter-text">Mine</span>
    </button>
  )
}
