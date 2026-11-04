import { Fragment, createElement, useSyncExternalStore, type ReactNode } from "react"
import type { Locale } from "../../shared/api"

// Translations without a library. Messages live in catalogs per area ("namespaces": core, settings, …) and per
// locale; English is bundled and is the source of truth for keys and placeholders, the other locales load on
// demand. A message is a string with {placeholders}, or a plural object chosen by Intl.PluralRules.
//
//   const { t, tr, useT } = defineNamespace("core", en, { de: () => import("./de"), … })
//   t("feed.newer", { count: 3 })           -> "3 newer issues"   (strings and numbers)
//   tr("event.labeled", { actor: <ActorName/>, label: <Label/> })   (React nodes inside a sentence)
//
// Components that render translated text call useT() so a language switch re-renders them in place.

export type Plural = { zero?: string; one?: string; two?: string; few?: string; many?: string; other: string }
export type Message = string | Plural
export type Catalog = Record<string, Message>

/** Another locale's catalog for the same keys: every key present (a missing one is a type error). */
export type Translation<C extends Catalog> = { [K in keyof C]: C[K] extends string ? string : Plural }

export type Vars<S> = S extends `${string}{${infer P}}${infer R}` ? P | Vars<R> : never
export type MessageVars<M> = M extends string ? Vars<M> : M extends Plural ? Vars<M[keyof M] & string> | "count" : never
export type Args<M, V> = [MessageVars<M>] extends [never] ? [] : [params: Record<MessageVars<M>, V>]

/** What a namespace gives its screens: plain-text t, rich tr (React nodes in placeholders), the useT hook. */
export interface Translator<C extends Catalog> {
  t: <K extends keyof C & string>(key: K, ...args: Args<C[K], string | number>) => string
  tr: <K extends keyof C & string>(key: K, ...args: Args<C[K], ReactNode>) => ReactNode
  useT: () => Translator<C>["t"]
  ready: () => Promise<void>
}

// The active locale, shared by every namespace
let current: Locale = "en"
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
export const getLocale = () => current

/** Re-renders the calling component when the language changes; returns the active locale. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale)
}

interface Namespace {
  en: Catalog
  loaders: Partial<Record<Locale, () => Promise<{ default: Catalog }>>>
  loaded: Map<Locale, Catalog>
  pending: Map<Locale, Promise<void>>
}
const namespaces = new Map<string, Namespace>()

function loadInto(ns: Namespace, locale: Locale): Promise<void> {
  if (locale === "en" || ns.loaded.has(locale) || !ns.loaders[locale]) return Promise.resolve()
  let p = ns.pending.get(locale)
  if (!p) {
    p = ns.loaders[locale]!()
      .then((m) => {
        ns.loaded.set(locale, m.default)
        if (locale === current) emit()
      })
      .catch((e) => {
        ns.pending.delete(locale)
        throw e
      })
    ns.pending.set(locale, p)
  }
  return p
}

const emit = () => listeners.forEach((l) => l())

/** Loads every registered namespace's catalog for `locale` (a no-op for English or what's loaded). */
export function preloadLocale(locale: Locale) {
  return Promise.all([...namespaces.values()].map((ns) => loadInto(ns, locale))).then(() => {})
}

/** Switches the language: catalogs first (so nothing flashes in English), then every useT() re-renders. */
export async function setLocale(locale: Locale) {
  await preloadLocale(locale).catch(() => {})
  if (locale === current) return
  current = locale
  if (typeof document !== "undefined") document.documentElement.lang = locale
  rules.clear()
  numbers.clear()
  emit()
}

const rules = new Map<string, Intl.PluralRules>()
const numbers = new Map<string, Intl.NumberFormat>()
const pluralRule = (locale: Locale) => {
  let r = rules.get(locale)
  if (!r) rules.set(locale, (r = new Intl.PluralRules(locale)))
  return r
}
/** A count in the active locale's digits and grouping (counts stay tabular in CSS). */
export function formatNumber(n: number) {
  let f = numbers.get(current)
  if (!f) numbers.set(current, (f = new Intl.NumberFormat(current)))
  return f.format(n)
}

/** What goes between two sentences shown side by side: a space, or nothing in Japanese and Chinese. */
export const sentenceGap = () => (current === "ja" || current === "zh-CN" ? "" : " ")

/** "A, B and C" in the active language. */
export function formatList(items: string[]) {
  return new Intl.ListFormat(current, { style: "long", type: "conjunction" }).format(items)
}

function pick(locale: Locale, message: Message, params: Record<string, unknown> | undefined): string {
  if (typeof message === "string") return message
  const n = Number(params?.count ?? 0)
  return message[pluralRule(locale).select(n) as keyof Plural] ?? message.other
}

const placeholder = /\{(\w+)\}/g
const show = (v: unknown) => (typeof v === "number" ? formatNumber(v) : String(v ?? ""))

export function defineNamespace<C extends Catalog>(name: string, en: C, loaders: Namespace["loaders"]): Translator<C> {
  const ns: Namespace = { en, loaders, loaded: new Map(), pending: new Map() }
  namespaces.set(name, ns)
  // A namespace that arrives with lazy code (Settings) starts on the active language right away
  if (current !== "en") loadInto(ns, current).catch(() => {})

  const message = (key: keyof C & string): Message => {
    const local = current === "en" ? undefined : ns.loaded.get(current)?.[key]
    if (local === undefined && current !== "en" && import.meta.env.DEV && ns.loaded.has(current))
      console.warn(`[i18n] ${name}.${key} is missing in ${current}`)
    return local ?? en[key]!
  }

  /** A message as plain text, with {placeholders} filled from strings and numbers. */
  function t<K extends keyof C & string>(key: K, ...[params]: Args<C[K], string | number>): string {
    const p = params as Record<string, unknown> | undefined
    return pick(current, message(key), p).replace(placeholder, (m, k: string) => (p && k in p ? show(p[k]) : m))
  }

  /** A message with React nodes in its placeholders (a name, a label chip, a link), in the language's word order. */
  function tr<K extends keyof C & string>(key: K, ...[params]: Args<C[K], ReactNode>): ReactNode {
    const p = params as Record<string, unknown> | undefined
    const text = pick(current, message(key), p)
    const out: ReactNode[] = []
    let at = 0
    for (const m of text.matchAll(placeholder)) {
      if (m.index! > at) out.push(text.slice(at, m.index))
      const v = p?.[m[1]!]
      out.push(createElement(Fragment, { key: out.length }, (typeof v === "number" ? formatNumber(v) : v) as ReactNode))
      at = m.index! + m[0].length
    }
    if (at < text.length) out.push(text.slice(at))
    return out
  }

  /** In a component: subscribes it to language changes and returns t. */
  function useT() {
    useLocale()
    return t
  }

  /** Resolves when this namespace has the active language's catalog (await it before showing lazy screens). */
  const ready = () => loadInto(ns, current).catch(() => {})

  return { t, tr, useT, ready }
}
