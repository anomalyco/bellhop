import { homeLabel } from "../../lib/site"
import "../../styles/onboarding.css"
import { useT } from "../../i18n/core"


/** Whether a workspace is public: listed in the home feed and indexed by search engines. Off (private) by default. */
export function PublicToggle({ value, onChange, id = "ws-public" }: { value: boolean; onChange: (next: boolean) => void; id?: string }) {
  const t = useT()
  return (
    <label className="visibility" htmlFor={id}>
      <input id={id} type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="visibility-text">
        <span className="visibility-title">{t("visibility.public")}</span>
        <span className="visibility-hint">{t("visibility.publicText", { home: homeLabel() })}</span>
        <span className="visibility-hint">{t("visibility.privateText")}</span>
      </span>
    </label>
  )
}

/** The same, read-only: for people below admin in Settings. */
export function VisibilityValue({ value }: { value: boolean }) {
  const t = useT()
  return (
    <p className="settings-value visibility-value">
      {value ? t("visibility.public") : t("visibility.private")}
      <span className="visibility-hint">
        {value ? t("visibility.listed", { home: homeLabel() }) : t("visibility.unlisted")}
      </span>
    </p>
  )
}
