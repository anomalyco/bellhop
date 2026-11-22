import { defineNamespace, type MessageVars } from "../index"
import en from "./en"

// The org feedback inbox: the operator's home across an org's apps, an app's view, org settings and creating orgs.
// English ships with the main bundle (the inbox is a signed-in operator's first paint); other languages load on demand.
export const { t, tr, useT, ready } = defineNamespace("inbox", en, {
  es: () => import("./es"),
  "pt-BR": () => import("./pt-BR"),
  fr: () => import("./fr"),
  de: () => import("./de"),
  ja: () => import("./ja"),
  "zh-CN": () => import("./zh-CN"),
  ko: () => import("./ko"),
})
export type InboxKey = keyof typeof en
export type InboxPlainKey = { [K in InboxKey]: [MessageVars<(typeof en)[K]>] extends [never] ? K : never }[InboxKey]
