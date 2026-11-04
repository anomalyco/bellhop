import { useState } from "react"
import type { AppDetail, AppMode } from "../../../shared/api"
import { t as tc } from "../../i18n/core"
import { useT } from "../../i18n/helpdesk"
import { api, errorMessage, keys } from "../../lib/api"
import { setData } from "../../lib/cache"
import { isDesk } from "../../lib/helpdesk"
import { CheckIcon } from "../../ui/icons"
import { Button } from "../../ui/primitives"
import "../../styles/helpdesk.css"
import { AutonomyChoice } from "../../ui/helpdesk/Autonomy"
import { useGroups } from "../../ui/helpdesk/Handoff"

/**
 * Settings → Help desk (admins): the workspace's mode, switched only after an inline confirm that spells out what
 * changes (every issue private, the workspace unlisted; switching back keeps them private), and whether requesters
 * must confirm their email before sending a request.
 */
export function HelpdeskSettings({ app }: { app: AppDetail }) {
  const t = useT()
  const admin = app.role === "owner" || app.role === "admin"
  const desk = isDesk(app)
  const [confirming, setConfirming] = useState<AppMode | null>(null)
  const [busy, setBusy] = useState(false)
  const { data: groups } = useGroups(app)
  const [error, setError] = useState<string | null>(null)

  const patch = async (input: Parameters<typeof api.patchApp>[1]) => {
    setBusy(true)
    setError(null)
    // Help desk options show their new value at once; the server's answer replaces it, or the old one comes back
    const before = app
    if (input.helpdesk) setData<AppDetail>(keys.app(app.slug), (a) => a && { ...a, helpdesk: { ...a.helpdesk, ...input.helpdesk } })
    try {
      setData<AppDetail>(keys.app(app.slug), await api.patchApp(app.slug, input))
      setConfirming(null)
    } catch (e) {
      if (input.helpdesk) setData<AppDetail>(keys.app(app.slug), before)
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const modes: { mode: AppMode; title: string; text: string }[] = [
    { mode: "tracker", title: t("settings.tracker"), text: t("settings.trackerText") },
    { mode: "helpdesk", title: t("settings.helpdesk"), text: t("settings.helpdeskText") },
  ]
  const target: AppMode = desk ? "tracker" : "helpdesk"

  return (
    <div className="desk-settings">
      <div className="settings-heading">
        <h1>{t("settings.title")}</h1>
      </div>
      <p className="settings-lede">{t("settings.lede")}</p>

      <section className="settings-section">
        <h2 className="section-title">{t("settings.mode")}</h2>
        <div className="desk-modes" role="radiogroup" aria-label={t("settings.mode")}>
          {modes.map((m) => {
            const current = (m.mode === "helpdesk") === desk
            return (
              <div key={m.mode} className="desk-mode" data-current={current || undefined} role="radio" aria-checked={current}>
                <p className="desk-mode-title">
                  {m.title}
                  {current && <CheckIcon size={14} />}
                </p>
                <p className="desk-mode-text">{m.text}</p>
              </div>
            )
          })}
        </div>
        {admin && !confirming && (
          <div className="row desk-switch">
            <Button onClick={() => setConfirming(target)}>{desk ? t("settings.switchOff") : t("settings.switchOn")}</Button>
          </div>
        )}
        {confirming && (
          <div className="desk-confirm" role="group" aria-labelledby="desk-confirm-title">
            <p className="desk-confirm-title" id="desk-confirm-title">
              {confirming === "helpdesk" ? t("settings.confirmOn") : t("settings.confirmOff")}
            </p>
            <ul>
              {confirming === "helpdesk" ? (
                <>
                  <li>{t("settings.confirmOnPrivate")}</li>
                  <li>{t("settings.confirmOnUnlisted")}</li>
                  <li>{t("settings.confirmOnSignIn")}</li>
                </>
              ) : (
                <>
                  <li>{t("settings.confirmOffPrivate")}</li>
                  <li>{t("settings.confirmOffSignIn")}</li>
                </>
              )}
            </ul>
            <div className="desk-confirm-actions">
              <Button variant="invisible" onClick={() => setConfirming(null)} disabled={busy}>
                {tc("common.cancel")}
              </Button>
              <Button variant="primary" onClick={() => void patch({ mode: confirming })} disabled={busy}>
                {busy ? t("settings.switching") : t("settings.confirm")}
              </Button>
            </div>
          </div>
        )}
      </section>

      {desk && (
        <section className="settings-section">
          <label className="visibility" htmlFor="desk-require">
            <input
              id="desk-require"
              type="checkbox"
              checked={app.helpdesk.require_verified_email}
              disabled={!admin || busy}
              onChange={(e) => void patch({ helpdesk: { require_verified_email: e.target.checked } })}
            />
            <span className="visibility-text">
              <span className="visibility-title">{t("settings.require")}</span>
              <span className="visibility-hint">{app.helpdesk.require_verified_email ? t("settings.requireText") : t("settings.requireOff")}</span>
            </span>
          </label>
          <label className="visibility" htmlFor="desk-anonymous">
            <input
              id="desk-anonymous"
              type="checkbox"
              checked={!!app.helpdesk.allow_anonymous}
              disabled={!admin || busy}
              onChange={(e) => void patch({ helpdesk: { allow_anonymous: e.target.checked } })}
            />
            <span className="visibility-text">
              <span className="visibility-title">{t("settings.anonymous")}</span>
              <span className="visibility-hint">{t("settings.anonymousText")}</span>
            </span>
          </label>
          <div className="field desk-default-group">
            <label className="field-label" htmlFor="desk-default-group">
              {t("settings.escalationsTo")}
            </label>
            <p className="desk-trust-note">{t("settings.escalationsToText")}</p>
            <select
              id="desk-default-group"
              className="select"
              value={app.helpdesk.default_group_id ?? ""}
              disabled={!admin || busy}
              onChange={(e) => void patch({ helpdesk: { default_group_id: e.target.value || null } })}
            >
              <option value="">{t("settings.escalationsNobody")}</option>
              {(groups ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
              {/* A group the list doesn't have (yet) stays selectable rather than showing as nobody */}
              {app.helpdesk.default_group_id && groups && !groups.some((g) => g.id === app.helpdesk.default_group_id) && (
                <option value={app.helpdesk.default_group_id}>{t("types.group")}</option>
              )}
            </select>
          </div>
          <div className="field desk-default-autonomy">
            <span className="field-label">{t("settings.defaultAutonomy")}</span>
            <p className="desk-trust-note">{t("settings.defaultAutonomyText")}</p>
            <AutonomyChoice
              name="desk-default-autonomy"
              label={t("settings.defaultAutonomy")}
              value={app.helpdesk.default_autonomy ?? "suggest"}
              disabled={!admin || busy}
              onChange={(next) => void patch({ helpdesk: { default_autonomy: next } })}
            />
          </div>
          {admin && app.trusted === false && <p className="desk-trust-note">{t("settings.trustedNote", { workspace: app.name })}</p>}
        </section>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}
