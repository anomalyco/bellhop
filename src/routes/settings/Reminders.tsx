import { useState } from "react"
import "../../styles/data.css"

export const reminderText =
  "When an issue waits on its reporter that long, Bellhop emails them once for that wait. It never closes anything, and a reply from them resets it."

/** Settings → General: remind reporters who haven't replied after N days (1–30), or off (null). */
export function Reminders({ value, onChange }: { value: number | null; onChange: (next: number | null) => void }) {
  // The days stay in the field while reminders are off, so turning them back on restores the number.
  const [days, setDays] = useState(String(value ?? 7))
  const on = value !== null
  const parsed = Number(days)
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 30
  return (
    <div className="reminder">
      <div className="reminder-row">
        <label className="checkbox" htmlFor="set-reminders">
          <input id="set-reminders" type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? (valid ? parsed : 7) : null)} />
          Remind reporters who haven't replied
        </label>
        <span className="reminder-days" data-off={!on || undefined}>
          after
          <span className="input" data-size="small" data-invalid={(on && !valid) || undefined}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              value={days}
              disabled={!on}
              aria-label="Days before the reminder"
              aria-invalid={on && !valid}
              onChange={(e) => {
                setDays(e.target.value)
                const n = Number(e.target.value)
                if (Number.isInteger(n) && n >= 1 && n <= 30) onChange(n)
              }}
            />
          </span>
          {parsed === 1 ? "day" : "days"}
        </span>
      </div>
      <p className="visibility-hint">{on && !valid ? "Pick 1 to 30 days." : reminderText}</p>
    </div>
  )
}
