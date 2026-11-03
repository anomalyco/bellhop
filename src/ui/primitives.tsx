import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react"
import { StatusIcon } from "./icons"

export type ButtonVariant = "default" | "primary" | "danger" | "invisible" | "outline"
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

const stateText: Record<VisibleState, string> = {
  open: "Open",
  in_progress: "In progress",
  waiting: "Waiting on reporter",
  closed: "Closed",
  not_planned: "Not planned",
}

export function StateLabel({ state, size, text }: { state: VisibleState; size?: "small"; text?: string }) {
  const Glyph = StatusIcon[state]
  return (
    <span className="state" data-state={state} data-size={size}>
      <Glyph size={size ? 14 : 16} />
      {text ?? stateText[state]}
    </span>
  )
}

export function StateIcon({ state, size = 16 }: { state: VisibleState; size?: number }) {
  const Glyph = StatusIcon[state]
  return (
    <span className="state-icon" data-state={state} style={{ display: "inline-flex" }}>
      <Glyph size={size} />
    </span>
  )
}

export function Label({ name, color }: { name: string; color: string }) {
  return (
    <span className="label" style={{ "--label": `#${color}` } as CSSProperties}>
      {name}
    </span>
  )
}

export function AiBadge() {
  return <span className="ai-badge">AI</span>
}

/** FNV-1a, enough to spread seeds over identicon patterns and hues. */
function hash(seed: string) {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Carbon's 40–50 grades: bright enough on the dark tile, all from the same family as the theme. */
const identiconColors = ["#4589ff", "#33b1ff", "#08bdba", "#42be65", "#a56eff", "#ee5396", "#ff832b", "#f1c21b", "#78a9ff"]

/** GitHub-style identicon: a mirrored 5×5 grid in one colour, seeded by the actor id. */
export function Identicon({ seed, size = 20, square }: { seed: string; size?: number; square?: boolean }) {
  const h = hash(seed)
  const color = identiconColors[h % identiconColors.length]
  const cells: ReactNode[] = []
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 3; col++) {
      if ((h >>> (row * 3 + col + 8)) & 1) {
        cells.push(<rect key={`${row}-${col}`} x={1 + col} y={1 + row} width="1.02" height="1.02" fill={color} />)
        if (col < 2) cells.push(<rect key={`${row}-${col}m`} x={5 - col} y={1 + row} width="1.02" height="1.02" fill={color} />)
      }
    }
  }
  return (
    <svg className="avatar" data-square={square || undefined} width={size} height={size} viewBox="0 0 7 7" aria-hidden="true">
      <rect width="7" height="7" fill="#1d2226" />
      {cells}
    </svg>
  )
}

/** The service bell: a filled dome on a base plate with the striker on top. Drawn on a 24-unit grid. */
function BellMark() {
  return (
    <>
      <circle cx="12" cy="7.1" r="1.6" fill="#fff" />
      <rect x="11.3" y="8" width="1.4" height="2" fill="#fff" />
      <path d="M5.6 15.6a6.4 6.4 0 0 1 12.8 0z" fill="#fff" />
      <rect x="4.2" y="16.4" width="15.6" height="2.2" rx="1.1" fill="#fff" />
    </>
  )
}

/** Agents get a square avatar with the bell mark, like GitHub's app avatars. */
export function AgentAvatar({ size = 20 }: { size?: number }) {
  return (
    <svg className="avatar" data-square width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect width="24" height="24" fill="var(--accent)" />
      <BellMark />
    </svg>
  )
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <rect width="24" height="24" rx="6" fill="var(--accent)" />
        <BellMark />
      </svg>
      <span style={{ fontWeight: 700, fontSize: size * 0.72, letterSpacing: "-0.01em" }}>Bellhop</span>
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
