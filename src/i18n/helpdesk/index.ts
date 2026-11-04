import { defineNamespace, type MessageVars } from "../index"
import en from "./en"

// The help desk: requester screens on a workspace in help desk mode, the team's view of requesters and the help desk
// settings. English ships with the main bundle (the help desk home is a first paint); other languages load like core.
export const { t, tr, useT, ready } = defineNamespace("helpdesk", en, {
  es: () => import("./es"),
  "pt-BR": () => import("./pt-BR"),
  fr: () => import("./fr"),
  de: () => import("./de"),
  ja: () => import("./ja"),
  "zh-CN": () => import("./zh-CN"),
  ko: () => import("./ko"),
})
export type DeskKey = keyof typeof en
export type DeskPlainKey = { [K in DeskKey]: [MessageVars<(typeof en)[K]>] extends [never] ? K : never }[DeskKey]
