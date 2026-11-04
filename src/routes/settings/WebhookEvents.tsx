import type { WebhookEventType } from "../../../shared/api"
import { t, tKey, useT, type PlainKey } from "../../i18n/settings"
import { sentenceGap } from "../../i18n"
import "../../styles/features.css"

const groups: { name: PlainKey; events: WebhookEventType[] }[] = [
  { name: "events.issues", events: ["issue.opened", "issue.updated", "issue.closed", "issue.reopened", "issue.deleted", "issue.moved"] },
  { name: "events.triage", events: ["issue.labeled", "issue.unlabeled", "issue.assigned"] },
  { name: "events.comments", events: ["comment.created", "comment.edited", "comment.deleted", "mention.created"] },
]
const eventText = (type: WebhookEventType) => tKey(`events.${type}` as PlainKey)

/** shared/api.ts DEFAULT_WEBHOOK_EVENTS, restated: the dev server can't load runtime values from shared/. */
const DEFAULT_WEBHOOK_EVENTS: WebhookEventType[] = ["issue.opened", "issue.updated", "comment.created", "mention.created"]
const defaults = new Set<WebhookEventType>(DEFAULT_WEBHOOK_EVENTS)

export const sameEvents = (a: WebhookEventType[], b: WebhookEventType[]) => a.length === b.length && a.every((e) => b.includes(e))

/** Which events the webhook gets, grouped, with the defaults marked. `ping` (Send test) always goes through. */
export function WebhookEvents({ value, onChange }: { value: WebhookEventType[]; onChange: (next: WebhookEventType[]) => void }) {
  useT()
  const on = new Set(value)
  const toggle = (type: WebhookEventType, checked: boolean) =>
    onChange(checked ? [...value.filter((e) => e !== type), type] : value.filter((e) => e !== type))
  const chosen = value.filter((e) => e !== "ping").length
  return (
    <div className="events">
      <div className="events-groups">
        {groups.map((g) => (
          <fieldset key={g.name} className="events-group">
            <legend>{tKey(g.name)}</legend>
            {g.events.map((e) => (
              <label key={e} className="events-option" title={e}>
                <input type="checkbox" checked={on.has(e)} onChange={(ev) => toggle(e, ev.target.checked)} />
                <span>{eventText(e)}</span>
                {defaults.has(e) && <span className="events-default">{t("events.default")}</span>}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <div className="events-foot">
        <span>
          {chosen === 0 ? t("events.none") : t("events.count", { count: chosen })}
          {sentenceGap()}
          {t("events.anyChange")}
        </span>
        {!sameEvents(value.filter((e) => e !== "ping"), DEFAULT_WEBHOOK_EVENTS) && (
          <button type="button" className="link-button" onClick={() => onChange([...DEFAULT_WEBHOOK_EVENTS])}>
            {t("events.reset")}
          </button>
        )}
      </div>
    </div>
  )
}
