import type { CSSProperties } from "react"

export const palette = ["fa4d56", "ff832b", "f1c21b", "42be65", "08bdba", "33b1ff", "4589ff", "a56eff", "ee5396", "878d96"]
export const randomColor = () => palette[Math.floor(Math.random() * palette.length)]!
export const validColor = (c: string) => /^[0-9a-f]{6}$/i.test(c)

/** A colour as hex: a swatch that picks a random palette colour, the hex field, and the system picker. */
export function ColorField({ id, value, onChange }: { id: string; value: string; onChange: (hex: string) => void }) {
  const valid = validColor(value)
  return (
    <div className="row" style={{ gap: 6 }}>
      <button
        type="button"
        className="color-swatch"
        style={{ "--swatch": valid ? `#${value}` : "#878d96" } as CSSProperties}
        onClick={() => onChange(randomColor())}
        aria-label="Pick a random colour"
        title="Random colour"
      />
      <div className="input" style={{ width: 110 }}>
        <span className="input-prefix mono">#</span>
        <input id={id} className="mono" value={value} onChange={(e) => onChange(e.target.value.replace(/[^0-9a-f]/gi, "").slice(0, 6))} aria-invalid={!valid} />
      </div>
      <input type="color" className="color-native" value={valid ? `#${value}` : "#878d96"} onChange={(e) => onChange(e.target.value.slice(1))} aria-label="Colour picker" />
    </div>
  )
}
