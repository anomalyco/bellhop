import type { AppDetail } from "../../shared/api"
import { keys } from "./api"
import { peek } from "./cache"
import { contactSignInHref, deskOutsider } from "./helpdesk"
import { routeOf } from "./page"
import { signInHref } from "./site"

/**
 * Where "Sign in" goes from this page: on a help desk (for its requesters) the workspace's own email sign-in, coming
 * back here; everywhere else the account sign-in on the home domain.
 */
export function signInHrefHere() {
  const route = routeOf(window.location.pathname + window.location.search)
  const slug = route.kind === "feed" ? null : route.slug
  if (slug && deskOutsider(peek<AppDetail>(keys.app(slug)))) return contactSignInHref(slug, window.location.pathname + window.location.search)
  return signInHref()
}
