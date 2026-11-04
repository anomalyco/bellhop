import type { ButtonHTMLAttributes, CSSProperties, ReactNode, Ref } from "react"
import { jacketPath, jacketTransform } from "./mark"
import { StatusIcon } from "./icons"
import { t, useT } from "../i18n/core"

/** primary: OpenCode's "submit" button, flat. default: "neutral". invisible: ghost. ghost-muted: a quieter ghost for
 *  toolbars and row actions. */
export type ButtonVariant = "default" | "primary" | "danger" | "invisible" | "ghost-muted" | "outline"
export type ButtonSize = "small" | "medium" | "large"

export function Button({
  variant = "default",
  size = "medium",
  icon,
  trailing,
  iconOnly,
  demo,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>
  variant?: ButtonVariant
  size?: ButtonSize
  icon?: ReactNode
  trailing?: ReactNode
  iconOnly?: boolean
  /** Forces a visual state on the design page. */
  demo?: "hover" | "active" | "focus"
}) {
  return (
    <button
      type="button"
      className="btn"
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly || undefined}
      data-demo={demo}
      {...props}
    >
      {icon}
      {children}
      {trailing}
    </button>
  )
}

export function Counter({ children }: { children: ReactNode }) {
  return <span className="counter">{children}</span>
}

export type VisibleState = "open" | "in_progress" | "waiting" | "closed" | "not_planned"

/** Each state's name in the active language (read at render). */
export const stateText: Record<VisibleState, string> = {
  get open() {
    return t("state.open")
  },
  get in_progress() {
    return t("state.in_progress")
  },
  get waiting() {
    return t("state.waiting")
  },
  get closed() {
    return t("state.closed")
  },
  get not_planned() {
    return t("state.not_planned")
  },
}

export function StateLabel({ state, size, text }: { state: VisibleState; size?: "small"; text?: string }) {
  useT()
  const Glyph = StatusIcon[state]
  return (
    <span className="state" data-state={state} data-size={size}>
      <Glyph size={14} />
      {text ?? stateText[state]}
    </span>
  )
}

export function StateIcon({ state, size = 16 }: { state: VisibleState; size?: number }) {
  const Glyph = StatusIcon[state]
  return (
    <span className="state-icon" data-state={state}>
      <Glyph size={size} />
    </span>
  )
}

/** Relative luminance of a 6-digit hex colour, 0 (black) to 1 (white). */
function luminance(hex: string) {
  const n = Number.parseInt(hex.replace("#", "").slice(0, 6), 16)
  if (Number.isNaN(n)) return 0.5
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255)
}

/** A label: a neutral chip with its colour as a dot. Very dark colours get a ring so the dot stays visible. */
export function Label({ name, color }: { name: string; color: string }) {
  return (
    <span className="label" data-dark={luminance(color) < 0.04 || undefined} style={{ "--label": `#${color}` } as CSSProperties}>
      <span className="label-chip-dot" aria-hidden="true" />
      {name}
    </span>
  )
}

export function AiBadge() {
  return <span className="ai-badge">{t("actor.ai")}</span>
}

/** FNV-1a, enough to spread ids over the avatar palette. */
function hash(seed: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** OpenCode's dark project-avatar palette; each colour is a background and border pair in components.css. */
const avatarColors = ["orange", "yellow", "cyan", "green", "red", "pink", "blue", "purple", "gray"] as const

/** What an avatar shows: two hex characters for a guest handle ("guest-4b6a" → "4b"), otherwise the first letter. */
export function avatarGlyph(name: string) {
  const guest = /^guest-([0-9a-f]{2})/i.exec(name)
  if (guest) return guest[1]!.toLowerCase()
  const first = [...name.trim()][0]
  return first ? first.toUpperCase() : "?"
}

/** A round avatar in one of OpenCode's project colours, picked by hashing the actor id. */
export function Avatar({ seed, name, size = 20 }: { seed: string; name: string; size?: number }) {
  const color = avatarColors[hash(seed) % avatarColors.length]
  const glyph = avatarGlyph(name)
  return (
    <span
      className="avatar"
      data-color={color}
      style={{ width: size, height: size, fontSize: Math.max(8, Math.round(size * (glyph.length > 1 ? 0.38 : 0.44))) }}
      aria-hidden="true"
    >
      {glyph}
    </span>
  )
}

/** The jacket mark, edge to edge on a 1024 grid; the tile around it comes from the avatar's own background. */
function JacketMark() {
  return <path transform={jacketTransform} fill="currentColor" d={jacketPath} />
}

/** Agents get a square avatar with the jacket mark, white on a dark tile. */
export function AgentAvatar({ size = 20 }: { size?: number }) {
  return (
    <span className="avatar" data-agent style={{ width: size, height: size, borderRadius: Math.round(size * 0.26) }} aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 1024 1024">
        <JacketMark />
      </svg>
    </span>
  )
}

/** An application's icon, rounded like the mark; the Bellhop mark when it has none. */
export function AppIcon({ src, size = 20 }: { src: string | null; size?: number }) {
  if (!src) return <span className="logo-mark"><AgentAvatar size={size} /></span>
  return <img className="app-icon" src={src} width={size} height={size} alt="" style={{ borderRadius: Math.round(size * 0.26) }} />
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <span className="logo">
      <AgentAvatar size={size} />
      <span className="logo-word">Bellhop</span>
    </span>
  )
}

export function Dots() {
  return (
    <span className="dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  )
}
