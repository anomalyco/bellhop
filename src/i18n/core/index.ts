import { defineNamespace, type MessageVars } from "../index"
import en from "./en"

// The core screens: header, feed, lists, issues, new issue, sign-in, agents, consent. English ships in the main
// bundle; each other language is its own small chunk, loaded before the first render when boot data names it.
export const { t, tr, useT, ready } = defineNamespace("core", en, {
  es: () => import("./es"),
  "pt-BR": () => import("./pt-BR"),
  fr: () => import("./fr"),
  de: () => import("./de"),
  ja: () => import("./ja"),
  "zh-CN": () => import("./zh-CN"),
  ko: () => import("./ko"),
})
export type CoreKey = keyof typeof en
/** Keys whose message takes no placeholders: safe to pick at runtime from a table (states, sorts, labels). */
export type PlainKey = { [K in CoreKey]: [MessageVars<(typeof en)[K]>] extends [never] ? K : never }[CoreKey]
export const tKey = (key: PlainKey): string => (t as (k: PlainKey) => string)(key)
