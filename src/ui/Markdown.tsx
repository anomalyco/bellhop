import { memo, useEffect, useState, type MouseEvent } from "react"
import { useLocation } from "wouter"

type Renderer = typeof import("../lib/markdown")
let renderer: Renderer | null = null
let loading: Promise<Renderer> | null = null

export function loadMarkdown() {
  loading ??= import("../lib/markdown").then((m) => (renderer = m))
  return loading
}

/** Rendered markdown. Until the parser chunk arrives (usually already prefetched), shows the plain text. */
export const Markdown = memo(function Markdown({ source, slug }: { source: string; slug: string }) {
  const [ready, setReady] = useState(!!renderer)
  const [, navigate] = useLocation()

  useEffect(() => {
    if (!ready) loadMarkdown().then(() => setReady(true))
  }, [ready])

  // Same-app links navigate without a full page load.
  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a")
    const href = a?.getAttribute("href")
    if (!a || !href?.startsWith("/") || href.startsWith("/media/") || a.target) return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
    e.preventDefault()
    navigate(href)
  }

  if (!source.trim()) return <p className="muted-text">No description provided.</p>
  if (!renderer) return <div className="markdown markdown-plain">{source}</div>
  return <div className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: renderer.render(source, slug) }} />
})
