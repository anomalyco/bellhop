import type { Approval } from "../../shared/api"

/**
 * The text an approval's details are signed as: keys sorted by UTF-16 code unit, each `"key":value` with
 * JSON.stringify, no whitespace. Built from pairs, never by stringifying an object (that reorders integer-like keys).
 */
export function canonicalDetails(details: Approval["details"]) {
  return "{" + Object.keys(details).sort().map((k) => JSON.stringify(k) + ":" + JSON.stringify(details[k])).join(",") + "}"
}

/** The unpadded base64url SHA-256 of canonicalDetails: what a decision echoes back for the details it showed. */
export async function detailsHash(details: Approval["details"]) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalDetails(details))))
  let binary = ""
  for (const b of digest) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
}

// Characters a reader can't see or that reorder text: controls, format and bidi marks, unusual spaces
const invisible = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u180E\uFEFF]/gu
const escape = (s: string) => s.replace(invisible, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`)

/** Free text (the agent's summary) with bidi controls and invisible characters spelled out, so none can reorder it. */
export const visibleText = (s: string) => escape(s)

/** A details value exactly as sent: strings quoted (so spaces and type show), numbers and booleans as written, invisibles spelled out. */
export const detailValue = (v: string | number | boolean) => escape(JSON.stringify(v))

/** A details key as sent, with invisibles spelled out (quoted when it's empty or has spaces at either end). */
export const detailKey = (k: string) => (k === "" || k.trim() !== k ? escape(JSON.stringify(k)) : escape(k))

/** The details in signing order. */
export const detailEntries = (details: Approval["details"]) => Object.keys(details).sort().map((k) => [k, details[k]!] as const)

/** What a decided approval shows as. A decision's later states (token used or past its 30 minutes) keep "approved". */
export function decision(a: Approval): "approved" | "rejected" | null {
  if (a.state === "rejected") return "rejected"
  return a.decided_by ? "approved" : null
}

/** The letters in a key outside ASCII, each spelled as \u{…} (a key like "аmount" may not be what it looks like). */
export function foreignLetters(key: string) {
  return [...new Set([...key].filter((c) => c.codePointAt(0)! > 0x7f && /\p{L}|\p{M}/u.test(c)))].map((c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`)
}

// Common Cyrillic and Greek letters that look like Latin ones
const confusables: Record<string, string> = {
  а: "a", в: "b", е: "e", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", ԁ: "d", ӏ: "l", ԛ: "q", ԝ: "w", ь: "b",
  А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X", І: "I", Ј: "J", Ѕ: "S", Ԁ: "D", Ԛ: "Q", Ԝ: "W",
  α: "a", ο: "o", ρ: "p", ν: "v", ι: "i", κ: "k", τ: "t", υ: "u", χ: "x", ϲ: "c", ε: "e",
  Α: "A", Β: "B", Ε: "E", Ζ: "Z", Η: "H", Ι: "I", Κ: "K", Μ: "M", Ν: "N", Ο: "O", Ρ: "P", Τ: "T", Υ: "Y", Χ: "X",
}
/** What a key looks like: NFKC, combining marks dropped, look-alike letters mapped to Latin. */
const skeleton = (key: string) =>
  [...key.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "")].map((c) => confusables[c] ?? c).join("")

/** Keys that are different but read the same (after NFKC, or by look-alike letters), in groups. */
export function lookalikeKeys(details: Approval["details"]) {
  const groups = new Map<string, string[]>()
  for (const k of Object.keys(details).sort()) groups.set(skeleton(k), [...(groups.get(skeleton(k)) ?? []), k])
  return [...groups.values()].filter((g) => g.length > 1)
}
