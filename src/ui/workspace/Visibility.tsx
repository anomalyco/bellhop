import { homeLabel } from "../../lib/site"
import "../../styles/onboarding.css"

const publicText = () => `List it on ${homeLabel()} and let search engines find it.`
const privateText = "Off, it's private: only people with the link find it, and it's never listed or indexed."

/** Whether a workspace is public: listed in the home feed and indexed by search engines. Off (private) by default. */
export function PublicToggle({ value, onChange, id = "ws-public" }: { value: boolean; onChange: (next: boolean) => void; id?: string }) {
  return (
    <label className="visibility" htmlFor={id}>
      <input id={id} type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} />
      <span className="visibility-text">
        <span className="visibility-title">Public</span>
        <span className="visibility-hint">{publicText()}</span>
        <span className="visibility-hint">{privateText}</span>
      </span>
    </label>
  )
}

/** The same, read-only: for people below admin in Settings. */
export function VisibilityValue({ value }: { value: boolean }) {
  return (
    <p className="settings-value visibility-value">
      {value ? "Public" : "Private"}
      <span className="visibility-hint">
        {value ? `Listed on ${homeLabel()} and indexed by search engines.` : "Only people with the link find it; never listed or indexed."}
      </span>
    </p>
  )
}
