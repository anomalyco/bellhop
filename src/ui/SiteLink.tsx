import type { AnchorHTMLAttributes, FocusEvent, MouseEvent, PointerEvent, TouchEvent } from "react"
import { Link, useLocation } from "wouter"
import type { Issue } from "../../shared/api"
import { api, keys } from "../lib/api"
import { load, peek } from "../lib/cache"
import { parseQuery, prefetchIssue, prefetchList, type Filter } from "../lib/issues"
import { hostSlug, isAbsolute } from "../lib/site"
import { isMarkdownLoaded, loadMarkdown } from "./Markdown"

type AppTarget =
  | { kind: "list"; filter: Filter }
  | { kind: "issue"; number: number }
  | { kind: "new" }
  | { kind: "settings" }

function parseAppHref(slug: string, href: string): AppTarget | null {
  if (isAbsolute(href) || !href.startsWith("/") || href.startsWith("/media/")) return null
  const qAt = href.indexOf("?")
  const rawPath = qAt >= 0 ? href.slice(0, qAt) : href
  const search = qAt >= 0 ? href.slice(qAt + 1) : ""
  let subpath: string | null = null
  if (hostSlug === slug) subpath = rawPath || "/"
  else {
    const prefix = `/${encodeURIComponent(slug)}`
    if (rawPath === prefix || rawPath === `${prefix}/`) subpath = "/"
    else if (rawPath.startsWith(`${prefix}/`)) subpath = rawPath.slice(prefix.length)
  }
  if (!subpath) return null
  if (subpath === "/") {
    const q = new URLSearchParams(search).get("q") ?? "is:open"
    return { kind: "list", filter: parseQuery(q) }
  }
  const issueMatch = /^\/issues\/([1-9]\d*)$/.exec(subpath)
  if (issueMatch) return { kind: "issue", number: Number(issueMatch[1]) }
  if (subpath === "/new") return { kind: "new" }
  if (subpath === "/settings" || subpath.startsWith("/settings/")) return { kind: "settings" }
  return null
}

export function prefetchAppHref(slug: string, href: string) {
  const target = parseAppHref(slug, href)
  if (!target) return
  switch (target.kind) {
    case "issue":
      prefetchIssue(slug, target.number)
      void loadMarkdown()
      break
    case "list":
      prefetchList(slug, target.filter)
      break
    case "new":
      void loadMarkdown()
      break
    case "settings":
      void import("../routes/Settings")
      break
  }
}

let navSeq = 0
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    navSeq++
  })
}

const ISSUE_HOLD_MS = 150

/** Navigates inside an app; holds the current page up to ~150 ms when opening an uncached issue so fast fetches skip the skeleton. */
export function navigateAppHref(slug: string, href: string, navigate: (to: string) => void) {
  const seq = ++navSeq
  const target = parseAppHref(slug, href)
  if (target?.kind === "issue") {
    const key = keys.issue(slug, target.number)
    const hasIssue = !!peek<Issue>(key)
    const hasMd = isMarkdownLoaded()
    if (!hasIssue || !hasMd) {
      const ready = Promise.all([
        hasIssue ? Promise.resolve() : load(key, () => api.issue(slug, target.number)).catch(() => {}),
        hasMd ? Promise.resolve() : loadMarkdown().catch(() => {}),
      ])
      const timeout = new Promise<void>((r) => setTimeout(r, ISSUE_HOLD_MS))
      void Promise.race([ready, timeout]).then(() => {
        if (seq === navSeq) navigate(href)
      })
      return
    }
  }
  navigate(href)
}

/** A client-side link within this host, or a plain anchor when the target is another app's subdomain. */
export function SiteLink({ href, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return isAbsolute(href) ? <a href={href} {...props} /> : <Link href={href} {...props} />
}

/** Intra-app link that warms data on hover, focus, pointerdown and touchstart, and holds uncached issue navigations briefly. */
export function AppLink({
  slug,
  href,
  onPointerEnter,
  onFocus,
  onPointerDown,
  onTouchStart,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { slug: string; href: string }) {
  const [, navigate] = useLocation()
  if (isAbsolute(href)) return <a href={href} onPointerEnter={onPointerEnter} onFocus={onFocus} onPointerDown={onPointerDown} onTouchStart={onTouchStart} onClick={onClick} {...props} />

  const warm = () => prefetchAppHref(slug, href)

  return (
    <a
      href={href}
      {...props}
      onPointerEnter={(e: PointerEvent<HTMLAnchorElement>) => {
        warm()
        onPointerEnter?.(e)
      }}
      onFocus={(e: FocusEvent<HTMLAnchorElement>) => {
        warm()
        onFocus?.(e)
      }}
      onPointerDown={(e: PointerEvent<HTMLAnchorElement>) => {
        if (e.button === 0) warm()
        onPointerDown?.(e)
      }}
      onTouchStart={(e: TouchEvent<HTMLAnchorElement>) => {
        warm()
        onTouchStart?.(e)
      }}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e)
        if (e.defaultPrevented || props.target) return
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
        e.preventDefault()
        navigateAppHref(slug, href, navigate)
      }}
    />
  )
}
