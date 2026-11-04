import { useState } from "react"
import type { NotificationSettings } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { setData, useResource } from "../lib/cache"
import { Header, Page, useMe } from "../ui/Shell"
import { SignIn } from "./home/SignIn"
import "../styles/agents.css"
import "../styles/features.css"

type Switch = Exclude<keyof NotificationSettings, "email">

const rows: { key: Switch; title: string; text: string }[] = [
  { key: "opened", title: "Issues I open", text: "Follow every issue you open: replies and status changes by email." },
  { key: "replied", title: "Issues I reply to", text: "Follow an issue once you've replied to it." },
  { key: "mentions", title: "When I'm @mentioned", text: "For team members: an email when someone mentions you." },
  { key: "assigned", title: "When an issue is assigned to me", text: "For team members: an email when an issue lands on you." },
]

/** /settings/notifications on the home domain: the account's four email switches, saved as they're flipped. */
export function NotificationSettingsPage() {
  const { data: me } = useMe()
  if (!me) return <Header />
  if (!me.user) return <SignIn back="/settings/notifications" />
  return (
    <>
      <Header />
      <Page narrow>
        <Settings />
      </Page>
    </>
  )
}

function Settings() {
  const { data, error } = useResource<NotificationSettings>(keys.notifications, api.notifications, 5_000)
  const [saving, setSaving] = useState<Switch | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const flip = async (key: Switch, on: boolean) => {
    if (!data) return
    const before = data
    setSaving(key)
    setFailure(null)
    setNote(null)
    setData<NotificationSettings>(keys.notifications, { ...data, [key]: on })
    try {
      setData(keys.notifications, await api.patchNotifications({ [key]: on }))
      setNote("Saved")
    } catch (e) {
      setData(keys.notifications, before)
      setFailure(errorMessage(e))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="notify-page">
      <h1 className="page-title">Notifications</h1>
      <p className="notify-page-lede">
        {data ? (
          <>
            Email goes to <strong>{data.email}</strong>. Replying to one posts your reply on the issue, and every email has a link to stop it.
          </>
        ) : (
          <span className="skeleton" style={{ width: "70%", height: 12 }} />
        )}
      </p>
      <section className="box">
        {rows.map((r) => (
          <label key={r.key} className="box-row switch-row" htmlFor={`notify-${r.key}`}>
            <div className="settings-row-main">
              <div className="switch-title">{r.title}</div>
              <div className="issue-meta">{r.text}</div>
            </div>
            <input
              id={`notify-${r.key}`}
              type="checkbox"
              role="switch"
              className="switch"
              checked={data ? data[r.key] : false}
              disabled={!data || saving === r.key}
              aria-checked={data ? data[r.key] : false}
              onChange={(e) => void flip(r.key, e.target.checked)}
            />
          </label>
        ))}
      </section>
      {failure ? (
        <p className="field-error notify-page-note">{failure}</p>
      ) : (
        <p className="notify-page-note" aria-live="polite">
          {!data && error ? errorMessage(error) : note ?? "To follow or unfollow one issue, use Notifications on its page."}
        </p>
      )}
    </div>
  )
}
