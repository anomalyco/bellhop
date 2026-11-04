import { getCookie } from "hono/cookie"
import { LOCALES, type Locale } from "../shared/api"
import type { Ctx } from "./core"

export const isLocale = (v: unknown): v is Locale => LOCALES.includes(v as Locale)
export function guestLocale(c: Ctx) {
  const value = getCookie(c, "bh_locale")
  return isLocale(value) ? value : null
}

function language(tag: string): Locale | "traditional" | "*" | null {
  if (tag === "*") return "*"
  try {
    const { language, script, region } = new Intl.Locale(tag)
    if (language === "pt") return "pt-BR"
    if (language === "zh") {
      if (script === "Hant" || (!script && ["TW", "HK", "MO"].includes(region ?? ""))) return "traditional"
      if (script === "Hans" || (!script && (!region || region === "CN" || region === "SG"))) return "zh-CN"
      return null
    }
    return isLocale(language) ? language : null
  } catch {
    return null // Malformed browser header, not an invalid API request.
  }
}
export function browserLocale(header: string | undefined): Locale {
  const ranges = (header ?? "")
    .split(",")
    .flatMap((part) => {
      const match = /^\s*([\w*-]+)\s*(?:;\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?|\.\d{1,3}))?\s*$/i.exec(part)
      if (!match) return []
      const tag = match[1]!,
        locale = language(tag)
      return locale ? [{ tag: tag.toLowerCase(), locale, q: Number(match[2] ?? 1) }] : []
    })
    .sort((a, b) => b.q - a.q || Number(a.locale === "*") - Number(b.locale === "*"))
  const explicit = new Set(ranges.map((r) => r.locale)),
    wildcard = LOCALES.find((l) => !explicit.has(l))
  let traditional = false
  for (const { locale, tag, q } of ranges) {
    if (!q) break
    if (locale === "traditional") {
      traditional = true
      continue
    }
    // Some browsers append bare zh after zh-TW. That isn't a request for Hans.
    if (traditional && tag === "zh") continue
    if (locale === "*") {
      if (wildcard) return wildcard
    } else return locale
  }
  return "en"
}
export function requestLocale(c: Ctx, saved = c.var.user ? c.var.accountLocale : guestLocale(c)) {
  return { locale: saved ?? browserLocale(c.req.header("Accept-Language")), locale_saved: saved != null }
}
