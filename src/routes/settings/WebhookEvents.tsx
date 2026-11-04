import type { WebhookEventType } from "../../../shared/api"
import "../../styles/features.css"

const groups: { name: string; events: { type: WebhookEventType; text: string }[] }[] = [
  {
    name: "Issues",
    events: [
      { type: "issue.opened", text: "Opened" },
      { type: "issue.updated", text: "Any change" },
      { type: "issue.closed", text: "Closed" },
      { type: "issue.reopened", text: "Reopened" },
      { type: "issue.deleted", text: "Deleted" },
      { type: "issue.moved", text: "Moved to another workspace" },
    ],
  },
  {
    name: "Triage",
    events: [
      { type: "issue.labeled", text: "Label added" },
      { type: "issue.unlabeled", text: "Label removed" },
      { type: "issue.assigned", text: "Assignee changed" },
    ],
  },
  {
    name: "Comments",
    events: [
      { type: "comment.created", text: "Posted" },
      { type: "comment.edited", text: "Edited" },
      { type: "comment.deleted", text: "Deleted" },
      { type: "mention.created", text: "Someone @mentioned" },
    ],
  },
]

/** shared/api.ts DEFAULT_WEBHOOK_EVENTS, restated: the dev server can't load runtime values from shared/. */
const DEFAULT_WEBHOOK_EVENTS: WebhookEventType[] = ["issue.opened", "issue.updated", "comment.created", "mention.created"]
const defaults = new Set<WebhookEventType>(DEFAULT_WEBHOOK_EVENTS)

export const sameEvents = (a: WebhookEventType[], b: WebhookEventType[]) => a.length === b.length && a.every((e) => b.includes(e))

/** Which events the webhook gets, grouped, with the defaults marked. `ping` (Send test) always goes through. */
export function WebhookEvents({ value, onChange }: { value: WebhookEventType[]; onChange: (next: WebhookEventType[]) => void }) {
  const on = new Set(value)
  const toggle = (type: WebhookEventType, checked: boolean) =>
    onChange(checked ? [...value.filter((e) => e !== type), type] : value.filter((e) => e !== type))
  const chosen = value.filter((e) => e !== "ping").length
  return (
    <div className="events">
      <div className="events-groups">
        {groups.map((g) => (
          <fieldset key={g.name} className="events-group">
            <legend>{g.name}</legend>
            {g.events.map((e) => (
              <label key={e.type} className="events-option" title={e.type}>
                <input type="checkbox" checked={on.has(e.type)} onChange={(ev) => toggle(e.type, ev.target.checked)} />
                <span>{e.text}</span>
                {defaults.has(e.type) && <span className="events-default">Default</span>}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <div className="events-foot">
        <span>
          {chosen === 0 ? "No events: only test pings are sent." : `${chosen} ${chosen === 1 ? "event" : "events"}.`} “Any change” fires for every edit,
          with the changed fields.
        </span>
        {!sameEvents(value.filter((e) => e !== "ping"), DEFAULT_WEBHOOK_EVENTS) && (
          <button type="button" className="link-button" onClick={() => onChange([...DEFAULT_WEBHOOK_EVENTS])}>
            Reset to defaults
          </button>
        )}
      </div>
    </div>
  )
}
