import type { Autonomy } from "../../../shared/api"
import { useT } from "../../i18n/helpdesk"
import "../../styles/helpdesk.css"

export const autonomies: Autonomy[] = ["suggest", "approve_actions", "autonomous"]

/** How much an agent may do alone: three options, each with its one-line meaning, as a radio list. */
export function AutonomyChoice({
  name,
  value,
  onChange,
  disabled,
  label,
}: {
  /** The radio group's name (unique on the page). */
  name: string
  value: Autonomy
  onChange: (next: Autonomy) => void
  disabled?: boolean
  label: string
}) {
  const t = useT()
  return (
    <div className="autonomy" role="radiogroup" aria-label={label}>
      {autonomies.map((a) => (
        <label key={a} className="autonomy-option" data-current={value === a || undefined}>
          <input type="radio" name={name} value={a} checked={value === a} disabled={disabled} onChange={() => onChange(a)} />
          <span className="autonomy-text">
            <span className="autonomy-title">{t(`autonomy.${a}`)}</span>
            <span className="autonomy-hint">{t(`autonomy.${a}Text`)}</span>
          </span>
        </label>
      ))}
      <p className="autonomy-soon">{t("autonomy.soon")}</p>
    </div>
  )
}
