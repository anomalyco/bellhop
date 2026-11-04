import { useState } from "react"
import type { NotificationSettings } from "../../shared/api"
import { api, errorMessage, keys } from "../lib/api"
import { setData, useResource } from "../lib/cache"
import { Header, Page, useMe } from "../ui/Shell"
import { SignIn } from "./home/SignIn"
import { t, tr, useT, type PlainKey, tKey } from "../i18n/settings"
import "../styles/agents.css"
import "../styles/features.css"

type Switch = Exclude<keyof NotificationSettings, "email">

const rows: Switch[] = ["opened", "replied", "mentions", "assigned"]

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
  useT()
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
      setNote(t("saved"))
    } catch (e) {
      setData(keys.notifications, before)
      setFailure(errorMessage(e))
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="notify-page">
      <h1 className="page-title">{t("notify.title")}</h1>
      {/* Everything below the title waits for the settings, so nothing above it moves when they arrive. */}
      {!data && !!error && <p className="notify-page-note">{errorMessage(error)}</p>}
      {data && (
        <>
          <p className="notify-page-lede">{tr("notify.lede", { email: <strong>{data.email}</strong> })}</p>
          <section className="box">
            {rows.map((key) => (
              <label key={key} className="box-row switch-row" htmlFor={`notify-${key}`}>
                <div className="settings-row-main">
                  <div className="switch-title">{tKey(`notify.${key}` as PlainKey)}</div>
                  <div className="issue-meta">{tKey(`notify.${key}Text` as PlainKey)}</div>
                </div>
                <input
                  id={`notify-${key}`}
                  type="checkbox"
                  role="switch"
                  className="switch"
                  checked={data[key]}
                  disabled={saving === key}
                  aria-checked={data[key]}
                  onChange={(e) => void flip(key, e.target.checked)}
                />
              </label>
            ))}
          </section>
          {failure ? (
            <p className="field-error notify-page-note">{failure}</p>
          ) : (
            <p className="notify-page-note" aria-live="polite">
              {note ?? t("notify.hint")}
            </p>
          )}
        </>
      )}
    </div>
  )
}
