import { useState } from "react"
import { t, tr, useT } from "../../i18n/settings"
import "../../styles/data.css"

export const reminderText = () => t("reminders.text")

/** Settings → General: remind reporters who haven't replied after N days (1–30), or off (null). */
export function Reminders({ value, onChange }: { value: number | null; onChange: (next: number | null) => void }) {
  useT()
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
          {t("reminders.remind")}
        </label>
        <span className="reminder-days" data-off={!on || undefined}>
          {tr("reminders.afterDays", {
            count: valid ? parsed : 2,
            input: (
          <span className="input" data-size="small" data-invalid={(on && !valid) || undefined}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={30}
              value={days}
              disabled={!on}
              aria-label={t("reminders.daysLabel")}
              aria-invalid={on && !valid}
              onChange={(e) => {
                setDays(e.target.value)
                const n = Number(e.target.value)
                if (Number.isInteger(n) && n >= 1 && n <= 30) onChange(n)
              }}
            />
          </span>
            ),
          })}
        </span>
      </div>
      <p className="visibility-hint">{on && !valid ? t("reminders.pick") : reminderText()}</p>
    </div>
  )
}
