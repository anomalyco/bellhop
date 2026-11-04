import { useEffect, useState } from "react"
import type { Locale, Me } from "../../shared/api"
import { getLocale, setLocale, useLocale } from "../i18n"
import { useT } from "../i18n/core"
import { LANGUAGE_NAMES, LOCALES, chooseLocale, localeIsChosen, resolveLocale } from "../i18n/locale"
import { useResource } from "../lib/cache"
import { api, keys } from "../lib/api"
import { GlobeIcon } from "./icons"
import { Menu, MenuItem } from "./Menu"
import { Button } from "./primitives"

/** "Automatic (browser)" and each language in its own name; picking one applies it at once (no reload). */
export function LanguageItems({ onDone }: { onDone: () => void }) {
  const t = useT()
  const locale = useLocale()
  const { data: me } = useResource<Me>(keys.me, api.me, 30_000)
  const chosen = localeIsChosen(me)
  const [busy, setBusy] = useState(false)
  const pick = (next: Locale | null) => {
    onDone()
    if (busy) return
    setBusy(true)
    chooseLocale(next)
      .catch(() => {})
      .finally(() => setBusy(false))
  }
  return (
    <>
      <MenuItem checked={!chosen} onSelect={() => pick(null)}>
        {t("language.automatic")}
      </MenuItem>
      {LOCALES.map((l) => (
        <MenuItem key={l} checked={chosen && l === locale} onSelect={() => pick(l)}>
          <span lang={l}>{LANGUAGE_NAMES[l]}</span>
        </MenuItem>
      ))}
    </>
  )
}

/** For guests (no account menu): a globe button in the header that opens the same list. */
export function LanguageButton() {
  const t = useT()
  const locale = useLocale()
  return (
    <Menu
      align="end"
      width={240}
      trigger={(p) => (
        <Button
          iconOnly
          variant="ghost-muted"
          className="btn header-language"
          aria-label={t("language.label", { language: LANGUAGE_NAMES[locale] })}
          title={t("language.choose")}
          icon={<GlobeIcon />}
          {...p}
        />
      )}
    >
      {(close) => <LanguageItems onDone={close} />}
    </Menu>
  )
}

/** Follows the language the server reports (a choice made in another tab, or /api/me arriving without boot data). */
export function LocaleSync() {
  const { data: me } = useResource<Me>(keys.me, api.me, 30_000)
  useEffect(() => {
    if (!me) return
    const wanted = resolveLocale(me)
    if (wanted !== getLocale()) void setLocale(wanted)
  }, [me])
  return null
}
