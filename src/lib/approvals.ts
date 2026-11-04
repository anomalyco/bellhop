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
