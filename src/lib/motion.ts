// Motion helpers: plain WAAPI on top of the CSS tokens in theme.css. Springs are critically damped (bounce 0) and
// named by duration (.25 / .3 / .4); CSS linear() samples the same curve. Only transforms, opacity and filter move,
// so nothing here ever shifts layout. Under prefers-reduced-motion every helper keeps a short fade and drops travel,
// scale and blur.
//
// Rules this follows (Anomaly's): nothing animates on the first paint; the viewer's own actions land instantly;
// other people's changes and live arrivals animate; removed items fade while their neighbours slide into the gap;
// a second animation on the same element starts from where the first one is, never from the start.

export const SPRING =
  "linear(0, 0.0544, 0.172, 0.308, 0.44, 0.557, 0.656, 0.737, 0.801, 0.851, 0.89, 0.919, 0.942, 0.958, 0.971, 0.98, 0.987, 0.992, 0.995, 0.998, 1)"
/** Settle times of the .25, .3 and .4 springs (1.183 × the spring duration, to 99.5 %). */
export const SPRING_25 = 296
export const SPRING_30 = 355
export const SPRING_40 = 473
export const FADE = 150

const supportsLinear = typeof CSS !== "undefined" && CSS.supports?.("transition-timing-function", "linear(0, 1)")
const easing = supportsLinear ? SPRING : "cubic-bezier(0.22, 1, 0.36, 1)"

export function reduced() {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches
}

/** Whether the app has painted once; before that, everything is already at rest. */
export function ready() {
  return typeof document !== "undefined" && document.documentElement.hasAttribute("data-ready")
}

// html[data-ready] two frames after the page has loaded: CSS gates every transition and animation on it.
if (typeof window !== "undefined") {
  const mark = () => requestAnimationFrame(() => requestAnimationFrame(() => document.documentElement.setAttribute("data-ready", "")))
  if (document.readyState === "complete") mark()
  else window.addEventListener("load", mark, { once: true })
}

/** Something genuinely appears (a live arrival): rise a few pixels and fade in. */
export function enter(el: Element | null, { y = 4, scale = 1, ms = SPRING_25, delay = 0 } = {}) {
  if (!el || !ready()) return
  const r = reduced()
  el.animate(
    r
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [
          { opacity: 0, transform: `translateY(${y}px) scale(${scale})` },
          { opacity: 1, transform: "none" },
        ],
    { duration: r ? FADE : ms, delay, easing: r ? "ease-out" : easing, fill: "backwards" },
  )
}

/**
 * A copy of `el` left exactly where it was, fading out above the page while the real node goes away; the caller
 * removes or replaces the real one at once (never waiting for the exit). Removal: scale .96, blur 3 px, .25 s.
 * Whole-state replacement: blur 4 px.
 */
export function ghost(el: Element | null, { blur = 3, ms = SPRING_25, into }: { blur?: number; ms?: number; into?: HTMLElement } = {}) {
  if (!el || !ready() || !el.isConnected) return
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const copy = el.cloneNode(true) as HTMLElement
  const host = into ?? (el.parentElement as HTMLElement)
  if (!host) return
  const base = host.getBoundingClientRect()
  copy.removeAttribute("id")
  copy.setAttribute("aria-hidden", "true")
  copy.setAttribute("inert", "")
  copy.dataset.ghost = ""
  Object.assign(copy.style, {
    position: "absolute",
    top: `${rect.top - base.top + host.scrollTop}px`,
    left: `${rect.left - base.left + host.scrollLeft}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: "1",
  })
  host.appendChild(copy)
  const r = reduced()
  const anim = copy.animate(
    r
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { opacity: 1, transform: "none", filter: "blur(0)" },
          { opacity: 0, transform: "scale(0.96)", filter: `blur(${blur}px)` },
        ],
    { duration: r ? FADE : ms, easing: r ? "ease-out" : easing, fill: "forwards" },
  )
  anim.finished.catch(() => {}).finally(() => copy.remove())
}

type Rects = Map<string, { el: HTMLElement; rect: DOMRect }>

function measure(container: HTMLElement, selector: string): Rects {
  const out: Rects = new Map()
  for (const el of container.querySelectorAll<HTMLElement>(selector)) {
    if (el.dataset.ghost !== undefined) continue
    const key = el.dataset.key
    if (key) out.set(key, { el, rect: el.getBoundingClientRect() })
  }
  return out
}

/**
 * FLIP for a keyed list (children with data-key): measure, run `mutate` (which must update the DOM synchronously,
 * e.g. inside flushSync), then slide moved items from where they were, ghost the removed ones out, and let new ones
 * enter. Positions are read with any running transform included, so a second change mid-slide carries on from
 * where the items are.
 */
export function flip(
  container: HTMLElement | null,
  mutate: () => void,
  { selector = ":scope > [data-key]", slide = SPRING_40, enterY = 4, stagger = 0 }: { selector?: string; slide?: number; enterY?: number; stagger?: number } = {},
) {
  if (!container || !ready()) return mutate()
  const before = measure(container, selector)
  mutate()
  // Stop slides still running (their current offset is already in `before`), then read the new layout
  for (const el of container.querySelectorAll<HTMLElement>(selector))
    el.getAnimations().forEach((a) => a.id === "flip" && a.cancel())
  const after = measure(container, selector)
  const r = reduced()
  // React dropped these: put each old node back, absolutely, just long enough to fade out where it stood (only the
  // outermost one when a whole group went)
  const removed = [...before.values()].filter(({ el }) => !el.isConnected)
  for (const { el, rect } of removed) {
    if (removed.some((o) => o.el !== el && o.el.contains(el))) continue
    // Parts of it that live on elsewhere (a message whose group was re-keyed) aren't ghosted twice
    for (const part of el.querySelectorAll<HTMLElement>("[data-key]")) if (after.has(part.dataset.key!)) part.style.visibility = "hidden"
    el.getAnimations().forEach((a) => a.cancel())
    container.appendChild(el)
    ghostInPlace(el, rect, container)
  }
  // Each moved item slides by its own delta less its measured ancestor's, so nested items never double up
  const delta = new Map<HTMLElement, { dx: number; dy: number }>()
  for (const [key, { el, rect }] of after) {
    const was = before.get(key)
    if (was) delta.set(el, { dx: was.rect.left - rect.left, dy: was.rect.top - rect.top })
  }
  let entered = 0
  for (const [key, { el }] of after) {
    if (!before.has(key)) {
      if (![...after.values()].some((o) => o.el !== el && o.el.contains(el) && !before.has(o.el.dataset.key!)))
        enter(el, { y: enterY, delay: Math.min(entered++, 4) * stagger })
      continue
    }
    let { dx, dy } = delta.get(el)!
    for (let a = el.parentElement; a && a !== container; a = a.parentElement) {
      const d = delta.get(a)
      if (d) {
        dx -= d.dx
        dy -= d.dy
        break
      }
    }
    if (r || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5)) continue
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { id: "flip", duration: slide, easing })
  }
}

function ghostInPlace(el: HTMLElement, rect: DOMRect, container: HTMLElement) {
  const base = container.getBoundingClientRect()
  el.dataset.ghost = ""
  el.setAttribute("aria-hidden", "true")
  el.setAttribute("inert", "")
  Object.assign(el.style, {
    position: "absolute",
    top: `${rect.top - base.top}px`,
    left: `${rect.left - base.left}px`,
    width: `${rect.width}px`,
    margin: "0",
    pointerEvents: "none",
    zIndex: "0",
  })
  const r = reduced()
  const anim = el.animate(
    r
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [
          { opacity: 1, transform: "none", filter: "blur(0)" },
          { opacity: 0, transform: "scale(0.96)", filter: "blur(3px)" },
        ],
    { duration: r ? FADE : SPRING_25, easing: r ? "ease-out" : easing, fill: "forwards" },
  )
  anim.finished.catch(() => {}).finally(() => el.remove())
}

// Live arrivals: the live handler marks an id as someone else's new item; the timeline element that mounts with
// that id rises in. Marks expire, so a later remount (navigation, refetch) never replays the entrance.
const arriving = new Map<string, number>()
export function markArrival(id: string) {
  arriving.set(id, Date.now())
}
export function isArriving(id: string | undefined) {
  if (!id) return false
  const at = arriving.get(id)
  if (at === undefined) return false
  if (Date.now() - at > 3000) {
    arriving.delete(id)
    return false
  }
  return true
}
/** A ref callback that runs the entrance once, when the element mounts as a marked arrival. */
export function arrivalRef(id: string | undefined) {
  return (el: HTMLElement | null) => {
    if (el && isArriving(id)) {
      arriving.delete(id!)
      enter(el, { y: 4 })
    }
  }
}

// Segmented controls: the selected option's backdrop (its ::before) slides from the previous option to the new
// one. One delegated listener covers every .segmented in the app, links (aria-current) and buttons (aria-pressed).
const selectedOf = (seg: Element) => seg.querySelector<HTMLElement>(':scope > [aria-pressed="true"], :scope > [aria-current="page"]')

function slideSegment(seg: HTMLElement, from: DOMRect, to: HTMLElement) {
  const rect = to.getBoundingClientRect()
  if (!rect.width) return
  const dx = from.left - rect.left
  const sx = from.width / rect.width
  if (Math.abs(dx) < 0.5 && Math.abs(sx - 1) < 0.01) return
  if (reduced() || !ready()) return
  to.animate([{ transform: `translateX(${dx}px) scaleX(${sx})` }, { transform: "none" }], {
    duration: SPRING_25,
    easing,
    pseudoElement: "::before",
  })
}

if (typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (e) => {
      const option = (e.target as Element | null)?.closest?.(".segmented > button, .segmented > a")
      const seg = option?.parentElement
      if (!option || !seg) return
      const prev = selectedOf(seg)
      if (!prev || prev === option) return
      const from = prev.getBoundingClientRect()
      // React (or the router) applies the new selection a moment later: watch for it, briefly.
      const done = () => observer.disconnect()
      const observer = new MutationObserver(() => {
        const now = selectedOf(seg)
        if (now && now !== prev) {
          done()
          slideSegment(seg, from, now)
        }
      })
      observer.observe(seg, { subtree: true, attributes: true, attributeFilter: ["aria-pressed", "aria-current"], childList: true })
      setTimeout(done, 1500)
    },
    true,
  )
}
