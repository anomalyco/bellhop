import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { Attachment } from "../../../shared/api"
import { formatSize } from "../../lib/upload"
import { SearchIcon, XIcon } from "../icons"
import { Button } from "../primitives"
import "../../styles/features.css"

/** Past this the viewer shows the start of the file and offers the rest as a download. */
const shownLimit = 2 * 1024 * 1024

/**
 * A log file in a sheet: monospace text with line numbers, and a search that narrows it to matching lines. A
 * centred panel on wide screens, a bottom sheet on phones. Escape or the scrim closes it.
 */
export function LogSheet({ log, onClose }: { log: Attachment; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const opener = useRef<Element | null>(document.activeElement)

  useEffect(() => {
    let live = true
    fetch(log.url, { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 404 ? "This log is no longer available." : `Couldn't load the log (${res.status}).`)
        return res.text()
      })
      .then((t) => live && setText(t))
      .catch((e: unknown) => live && setError(e instanceof Error && e.name !== "TypeError" ? e.message : "Couldn't load the log."))
    return () => {
      live = false
    }
  }, [log.url])

  useEffect(() => {
    const root = document.documentElement
    const before = root.style.overflow
    root.style.overflow = "hidden"
    search.current?.focus({ preventScroll: true })
    const back = opener.current
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => {
      root.style.overflow = before
      window.removeEventListener("keydown", onKey)
      if (back instanceof HTMLElement) back.focus({ preventScroll: true })
    }
  }, [onClose])

  const shown = text && text.length > shownLimit ? text.slice(0, shownLimit) : text
  const lines = useMemo(() => (shown ? shown.replace(/\n$/, "").split("\n") : []), [shown])
  const needle = query.trim().toLowerCase()
  const matches = useMemo(() => {
    if (!needle) return null
    const out: number[] = []
    for (let i = 0; i < lines.length; i++) if (lines[i]!.toLowerCase().includes(needle)) out.push(i)
    return out
  }, [lines, needle])
  const digits = String(lines.length).length

  return createPortal(
    <>
      <div className="menu-scrim log-scrim" aria-hidden="true" onClick={onClose} />
      <div className="log-sheet" role="dialog" aria-modal="true" aria-labelledby="log-sheet-title">
        <header className="log-head">
          <div className="log-title-row">
            <h2 id="log-sheet-title" className="log-title">
              {log.name}
            </h2>
            <span className="mono log-size">{formatSize(log.size)}</span>
            <span className="spacer" />
            <a className="btn log-download" data-variant="invisible" data-size="small" href={log.url} download={log.name}>
              Download
            </a>
            <Button iconOnly size="small" variant="ghost-muted" aria-label="Close" icon={<XIcon size={14} />} onClick={onClose} />
          </div>
          <div className="log-search-row">
            <div className="input log-search">
              <SearchIcon size={14} />
              <input
                ref={search}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search this log"
                aria-label="Search this log"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <span className="log-count" aria-live="polite">
              {matches ? `${matches.length} ${matches.length === 1 ? "line" : "lines"}` : text !== null ? `${lines.length} ${lines.length === 1 ? "line" : "lines"}` : ""}
            </span>
          </div>
        </header>
        <div className="log-body" tabIndex={0} aria-label={`${log.name} contents`}>
          {error && <p className="log-note">{error}</p>}
          {!error && text === null && <p className="log-note">Loading…</p>}
          {text !== null && text.length === 0 && <p className="log-note">This log is empty.</p>}
          {text !== null && text.length > 0 && (
            <pre className="log-text" style={{ ["--gutter" as string]: `${digits + 1}ch` }}>
              {matches
                ? matches.map((i) => <Line key={i} n={i + 1} text={highlight(lines[i]!, needle)} />)
                : lines.map((l, i) => <Line key={i} n={i + 1} text={l} />)}
            </pre>
          )}
          {matches?.length === 0 && <p className="log-note">No lines match “{query.trim()}”.</p>}
          {text !== null && text.length > shownLimit && (
            <p className="log-note">
              Showing the first {formatSize(shownLimit)} of {formatSize(text.length)}. Download it for the rest.
            </p>
          )}
        </div>
      </div>
    </>,
    document.body,
  )
}

function Line({ n, text }: { n: number; text: ReactNode }) {
  return (
    <span className="log-line">
      <span className="log-n" aria-hidden="true">
        {n}
      </span>
      <span className="log-l">{text}</span>
      {"\n"}
    </span>
  )
}

function highlight(line: string, needle: string): ReactNode {
  const lower = line.toLowerCase()
  const parts: ReactNode[] = []
  let at = 0
  for (let i = lower.indexOf(needle); i !== -1; i = lower.indexOf(needle, i + needle.length)) {
    if (i > at) parts.push(line.slice(at, i))
    parts.push(<mark key={i}>{line.slice(i, i + needle.length)}</mark>)
    at = i + needle.length
  }
  if (at < line.length) parts.push(line.slice(at))
  return parts
}
