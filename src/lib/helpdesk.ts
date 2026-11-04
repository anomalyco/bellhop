import type { AppDetail, Me } from "../../shared/api"
import { appPath } from "./site"

// Help desk mode: the workspace is the product. Requesters (everyone not on the team) get the branded help desk;
// the team keeps the tracker's list and tools.

type ModeOf = Pick<AppDetail, "mode"> & { role?: AppDetail["role"] }

export const isDesk = (app: Partial<ModeOf> | null | undefined) => app?.mode === "helpdesk"

/** A requester's view: the workspace is a help desk and the viewer isn't on its team. */
export const deskOutsider = (app: Partial<ModeOf> | null | undefined) => isDesk(app) && !app?.role

/** The contact sign-in page on the workspace, coming back to `next` (a path on the same workspace). */
export function contactSignInHref(slug: string, next?: string) {
  const back = next && next !== appPath(slug) ? `?next=${encodeURIComponent(next)}` : ""
  return appPath(slug, `/signin${back}`)
}

/** Where to go after signing in: a same-workspace path from ?next=, else the workspace's home. */
export function safeDeskNext(slug: string, raw: string | null) {
  const home = appPath(slug)
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return home
  if (home === "/") return raw
  return raw === home || raw.startsWith(home + "/") || raw.startsWith(home + "?") ? raw : home
}

/** "a•••@example.com": enough for the requester to recognise the address, in a thread anyone on it may see. */
export function maskEmail(email: string) {
  const at = email.lastIndexOf("@")
  if (at < 1) return email
  return `${email[0]}•••${email.slice(at)}`
}

/** How a contact reads in the header and menus: their name, else their email. */
export const contactLabel = (c: NonNullable<Me["contact"]>) => c.name || c.email || ""

/** The first letter of a name, for the workspace mark when it has no icon. */
export const initialOf = (name: string) => (name.trim().match(/\p{L}|\p{N}/u)?.[0] ?? "?").toLocaleUpperCase()

/** A square SVG tile with the initial, for the favicon of a help desk without an icon. */
export function initialIcon(name: string) {
  const letter = initialOf(name).replace(/[<&>"']/g, "")
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#2a2a2a"/><text x="32" y="43" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="32" font-weight="600" fill="#ededed">${letter}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
