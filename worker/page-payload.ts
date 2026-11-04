import type { PagePayload } from "../shared/api"
import { detail, viewerApp } from "./apps"
import { config, firstContact, guestName, me, reportCookies, sessionHash, shareSession, userBySession } from "./auth"
import { ApiFailure, now, sha256, type Ctx } from "./core"
import { feed, feedApps, getIssue, issueNumber, listIssues, myAuthorFilter } from "./issues"
import { getReport } from "./report-data"
import { reportViewer } from "./reports"
import { pageReads } from "./read-scope"

export async function pageContext(c: Ctx) {
  if (!c.var.guestId) firstContact(c)
  const cookie = c.var.guestId,
    [hash, guestHash] = await Promise.all([sessionHash(c), sha256(cookie)])
  c.set("guestHash", guestHash)
  return { cookie, hash, read: pageReads(c.env) }
}

type PageResult = { payload: PagePayload; status: 200 | 404 | 410 }
export async function pagePayload(
  c: Ctx,
  { slug, path, homePage }: { slug: string | null; path: string; homePage: boolean },
  query: URLSearchParams,
  ctx: Awaited<ReturnType<typeof pageContext>>
): Promise<PageResult> {
  const { hash, cookie, read } = ctx,
    time = now(),
    q = query.get("q") ?? undefined,
    state = query.get("state") ?? undefined
  const session = Promise.resolve(userBySession(c, hash, read, slug)).then((user) => {
    c.set("user", user)
    shareSession(c)
    return user
  })
  const name = c.var.existingGuest ? guestName(c, read) : Promise.resolve(null)
  const identity = Promise.all([session, name]).then(([, n]) => me(c, n, undefined, slug))
  const location = path.replace(/\/$/, "") || "/"
  let app: PagePayload["app"] = null,
    status: PageResult["status"] = 200
  async function route(): Promise<PagePayload["route"]> {
    if (slug === null) {
      if (location !== "/") return { kind: homePage ? "other" : "not_found" }
      const guest = "g:" + c.var.guestHash
      const [list, apps] = await Promise.all([
        feed(c.env, { state, q }, hash ? { sessionHash: hash, guest, user: session } : guest, undefined, cookie, read),
        feedApps(c.env, read)
      ])
      return { kind: "feed", list, apps }
    }
    const own = location === "/" && myAuthorFilter(q) ? reportCookies(c) : undefined
    const scope = await viewerApp(c, slug, own, ctx)
    // Only the author:@me list unions legacy browser identities. The workspace
    // counts still use exactly the viewer of GET /api/apps/:slug.
    async function content(): Promise<PagePayload["route"]> {
      if (location === "/")
        return {
          kind: "list",
          list: await listIssues(
            c.env,
            scope.app.id,
            { state, query: q, label: query.get("label") ?? undefined, sort: query.get("sort") ?? undefined },
            scope.viewer,
            read
          )
        }
      if (location.startsWith("/issues/"))
        return {
          kind: "issue",
          issue: await getIssue(
            c.env,
            scope.app.id,
            issueNumber(location.slice(8)),
            scope.viewer,
            {
              origin: c.env.PUBLIC_ORIGIN || c.req.url,
              viewer: async (target) => (await viewerApp(c, target, undefined, ctx)).viewer
            },
            read
          )
        }
      if (location === "/new") {
        const id = query.get("metadata"),
          viewer =
            id && c.req.header("Authorization") ? await reportViewer(c, scope.app.id, scope.viewer) : scope.viewer
        return { kind: "new", metadata: id === null ? null : await getReport(c.env, scope.app.id, id, viewer, read) }
      }
      if (location === "/_design" || location === "/signin" || /^\/(?:settings|contacts)(?:\/|$)/.test(location))
        return { kind: "other" }
      return { kind: "not_found" }
    }
    const [workspace, result] = await Promise.all([
      detail(c, scope.app, scope.baseViewer, read),
      content().catch(unavailable)
    ])
    app = workspace
    return result
  }
  function unavailable(error: unknown): PagePayload["route"] {
    if (!(error instanceof ApiFailure) || (error.status !== 404 && error.status !== 410)) throw error
    status = error.status
    return { kind: "not_found" }
  }
  const [viewer, result] = await Promise.all([identity, route().catch(unavailable)])
  // The discriminant tells the SPA what to render; HTTP still distinguishes a
  // proven public deletion (410) from a missing or inaccessible issue (404).
  return {
    payload: { now: time, me: viewer, config: config(c), app, route: result },
    status: result.kind === "not_found" && status === 200 ? 404 : status
  }
}
