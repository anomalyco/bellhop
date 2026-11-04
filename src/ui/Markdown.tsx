import { memo, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type MouseEvent, type SyntheticEvent } from "react"
import { createPortal } from "react-dom"
import { useLocation } from "wouter"
import type { Mention } from "../../shared/api"
import { actorName } from "./Actor"
import { navigateAppHref, prefetchAppHref } from "./SiteLink"

type Renderer = typeof import("../lib/markdown")
let renderer: Renderer | null = null
let loading: Promise<Renderer> | null = null

type Player = ComponentType<{ src: string }>
let cachedPlayer: Player | null = null
let loadingPlayer: Promise<Player> | null = null

export const isMarkdownLoaded = () => renderer !== null

export function loadMarkdown() {
  loading ??= import("../lib/markdown").then((m) => (renderer = m))
  return loading
}

function loadVideoPlayer() {
  loadingPlayer ??= import("./VideoPlayer").then((m) => (cachedPlayer = m.VideoPlayer))
  return loadingPlayer
}

function sameAppHref(target: EventTarget | null) {
  const a = target instanceof Element ? target.closest("a") : null
  const href = a?.getAttribute("href")
  if (!a || !href?.startsWith("/") || href.startsWith("/media/") || a.target) return null
  return href
}

/** Rendered markdown. Until the parser chunk arrives, shows the plain text. */
export const Markdown = memo(function Markdown({ source, slug, mentions }: { source: string; slug: string; mentions?: Mention[] }) {
  const [ready, setReady] = useState(!!renderer)
  const [, navigate] = useLocation()

  useEffect(() => {
    if (!ready) loadMarkdown().then(() => setReady(true))
  }, [ready])

  const warm = (e: SyntheticEvent) => {
    const href = sameAppHref(e.target)
    if (href) prefetchAppHref(slug, href)
  }

  // Same-app links navigate without a full page load.
  const onClick = (e: MouseEvent) => {
    const href = sameAppHref(e.target)
    if (!href) return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
    e.preventDefault()
    navigateAppHref(slug, href, navigate)
  }

  if (!source.trim()) return <p className="muted-text">No description provided.</p>
  if (!renderer) return <div className="markdown markdown-plain">{source}</div>
  const resolved = mentions?.map((m) => ({ handle: m.handle, name: actorName(m.actor), agent: m.actor.type === "agent" }))
  return <Rendered html={renderer.render(source, slug, resolved)} onClick={onClick} onWarm={warm} />
})

/** The rendered HTML, with each video slot taken over by a React player through a portal. */
function Rendered({ html, onClick, onWarm }: { html: string; onClick: (e: MouseEvent) => void; onWarm: (e: SyntheticEvent) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [slots, setSlots] = useState<HTMLElement[]>([])
  const [PlayerComponent, setPlayerComponent] = useState<Player | null>(() => cachedPlayer)

  useLayoutEffect(() => {
    setSlots(Array.from(ref.current?.querySelectorAll<HTMLElement>(".video-slot[data-src]") ?? []))
  }, [html])

  useEffect(() => {
    if (slots.length > 0 && !PlayerComponent) {
      loadVideoPlayer().then((P) => setPlayerComponent(() => P))
    }
  }, [slots.length, PlayerComponent])

  return (
    <>
      <div
        ref={ref}
        className="markdown"
        onClick={onClick}
        onPointerOver={onWarm}
        onFocus={onWarm}
        onPointerDown={onWarm}
        onTouchStart={onWarm}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {PlayerComponent && slots.map((slot, i) => createPortal(<PlayerComponent src={slot.dataset.src!} />, slot, `${i}:${slot.dataset.src}`))}
    </>
  )
}
