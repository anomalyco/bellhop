import type { Plural } from "../i18n"
import type { Locale } from "../../shared/api"
import en from "../i18n/widget/en"
import es from "../i18n/widget/es"
import ptBR from "../i18n/widget/pt-BR"
import fr from "../i18n/widget/fr"
import de from "../i18n/widget/de"
import ja from "../i18n/widget/ja"
import zhCN from "../i18n/widget/zh-CN"
import ko from "../i18n/widget/ko"

// The widget's own small translator (the app's i18n runtime is tied to React). All eight catalogs ship in the widget
// bundle: together they're a few kilobytes compressed, and a chat must never wait on a second request to speak.

type Catalog = typeof en
type Key = keyof Catalog
type Vars<S> = S extends `${string}{${infer P}}${infer R}` ? P | Vars<R> : never
type MessageVars<M> = M extends string ? Vars<M> : M extends Plural ? Vars<M[keyof M] & string> | "count" : never
type Args<M> = [MessageVars<M>] extends [never] ? [] : [params: Record<MessageVars<M>, string | number>]

const catalogs: Record<Locale, Record<string, string | Plural>> = { en, es, "pt-BR": ptBR, fr, de, ja, "zh-CN": zhCN, ko }
const supported = Object.keys(catalogs) as Locale[]

/** A requested language or the browser's, matched to ours (pt → pt-BR, zh-Hans → zh-CN), else English. */
export function pickLocale(wanted?: string | null): Locale {
  const tags = [wanted, ...(typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]))].filter(Boolean) as string[]
  for (const tag of tags) {
    const lower = tag.toLowerCase()
    const exact = supported.find((l) => l.toLowerCase() === lower)
    if (exact) return exact
    const [lang, ...rest] = lower.split("-")
    if (lang === "zh") {
      if (rest.some((s) => ["tw", "hk", "mo", "hant"].includes(s))) continue
      return "zh-CN"
    }
    if (lang === "pt") return "pt-BR"
    const base = supported.find((l) => l.split("-")[0] === lang)
    if (base) return base
  }
  return "en"
}

export function translator(locale: Locale) {
  const catalog = catalogs[locale]
  const rules = new Intl.PluralRules(locale)
  const numbers = new Intl.NumberFormat(locale)
  return function t<K extends Key>(key: K, ...[params]: Args<Catalog[K]>): string {
    const m = (catalog[key] ?? en[key]) as string | Plural
    const p = params as Record<string, string | number> | undefined
    const text = typeof m === "string" ? m : (m[rules.select(Number(p?.count ?? 0)) as keyof Plural] ?? m.other)
    return text.replace(/\{(\w+)\}/g, (s, k: string) => {
      const v = p?.[k]
      return v === undefined ? s : typeof v === "number" ? numbers.format(v) : v
    })
  }
}
export type T = ReturnType<typeof translator>
