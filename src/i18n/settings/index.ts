import { defineNamespace, type MessageVars } from "../index"
import en from "./en"

// Settings (workspace settings, account notifications). It ships with the lazy Settings and Notifications chunks;
// each other language is its own chunk. The top-level await holds those chunks until the active language's catalog
// is in, so a settings screen never renders in English first (React.lazy shows the same fallback meanwhile).
export const { t, tr, useT, ready } = defineNamespace("settings", en, {
  es: () => import("./es"),
  "pt-BR": () => import("./pt-BR"),
  fr: () => import("./fr"),
  de: () => import("./de"),
  ja: () => import("./ja"),
  "zh-CN": () => import("./zh-CN"),
  ko: () => import("./ko"),
})
await ready()

export type SettingsKey = keyof typeof en
/** Keys whose message takes no placeholders: safe to pick at runtime from a table. */
export type PlainKey = { [K in SettingsKey]: [MessageVars<(typeof en)[K]>] extends [never] ? K : never }[SettingsKey]
export const tKey = (key: PlainKey): string => (t as (k: PlainKey) => string)(key)
