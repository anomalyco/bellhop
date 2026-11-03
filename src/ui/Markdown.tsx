import { memo, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "wouter"
import { VideoPlayer } from "./VideoPlayer"

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
  return <Rendered html={renderer.render(source, slug)} onClick={onClick} />
})

/** The rendered HTML, with each video slot taken over by a React player through a portal. */
function Rendered({ html, onClick }: { html: string; onClick: (e: MouseEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState<HTMLElement[]>([])
  useLayoutEffect(() => {
    setSlots(Array.from(ref.current?.querySelectorAll<HTMLElement>(".video-slot[data-src]") ?? []))
  }, [html])
  return (
    <>
      <div ref={ref} className="markdown" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {slots.map((slot, i) => createPortal(<VideoPlayer src={slot.dataset.src!} />, slot, `${i}:${slot.dataset.src}`))}
    </>
  )
}
