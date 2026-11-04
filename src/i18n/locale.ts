import type { Locale, Me } from "../../shared/api"
import { ApiFailure, keys } from "../lib/api"
import { setData } from "../lib/cache"
import { setLocale } from "./index"

/** Each language in its own name, for the switcher. */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  "pt-BR": "Português (Brasil)",
  fr: "Français",
  de: "Deutsch",
  ja: "日本語",
  "zh-CN": "简体中文",
  ko: "한국어",
}

/** Every supported language, in the switcher's order (shared/api's LOCALES is type-only on the client). */
export const LOCALES = Object.keys(LANGUAGE_NAMES) as Locale[]

const isLocale = (v: unknown): v is Locale => typeof v === "string" && (LOCALES as string[]).includes(v)

/** The browser's preferred languages matched to ours: exact, then by language (pt → pt-BR, zh-Hans → zh-CN). */
export function browserLocale(): Locale {
  const wanted = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const tag of wanted) {
    const lower = tag.toLowerCase()
    const exact = LOCALES.find((l) => l.toLowerCase() === lower)
    if (exact) return exact
    const [lang, ...rest] = lower.split("-")
    if (lang === "zh") {
      if (rest.some((s) => s === "tw" || s === "hk" || s === "mo" || s === "hant")) continue
      return "zh-CN"
    }
    if (lang === "pt") return "pt-BR"
    const base = LOCALES.find((l) => l.split("-")[0]!.toLowerCase() === lang)
    if (base) return base
  }
  return "en"
}

/** The language to show: the server's answer (a saved choice, else the request's Accept-Language), else, before
 *  /api/me has answered, this browser's languages. */
export function resolveLocale(me: Pick<Me, "locale"> | null | undefined): Locale {
  if (me && isLocale(me.locale)) return me.locale
  return browserLocale()
}

/** Whether the shown language is a saved choice rather than detected ("Automatic" otherwise). */
export function localeIsChosen(me: Pick<Me, "locale_saved"> | null | undefined) {
  return !!me?.locale_saved
}

/**
 * Picks a language (null: back to the browser's). Saved on the account, or for guests in the bh_locale cookie, by
 * PUT /api/me/locale; applied at once, without a reload.
 */
export async function chooseLocale(locale: Locale | null) {
  const res = await fetch("/api/me/locale", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ locale }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null
    throw new ApiFailure(res.status, body?.error?.code ?? `http_${res.status}`, body?.error?.message ?? res.statusText)
  }
  const me = (await res.json()) as Me
  setData<Me>(keys.me, me)
  await setLocale(resolveLocale(me))
}
