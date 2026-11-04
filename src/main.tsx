import { StrictMode, Suspense, lazy } from "react"
import { createRoot } from "react-dom/client"
import { Route, Switch } from "wouter"
import { api, keys, loadMe } from "./lib/api"
import { load } from "./lib/cache"
import { listKey, parseQuery } from "./lib/issues"
import { appPath, hostSlug, onHome } from "./lib/site"
import { Home } from "./routes/Home"
import { IssuePage } from "./routes/IssuePage"
import { Issues } from "./routes/Issues"
import { NewIssue } from "./routes/NewIssue"
import { loadMarkdown } from "./ui/Markdown"
import { AppLayout, NotFound } from "./ui/Shell"
import "./styles/theme.css"
import "./styles/components.css"
import "./styles/app.css"

const DesignSystem = lazy(() => import("./routes/DesignSystem").then((m) => ({ default: m.DesignSystem })))
const Settings = lazy(() => import("./routes/Settings"))
const Consent = lazy(() => import("./routes/OAuth").then((m) => ({ default: m.Consent })))
const Device = lazy(() => import("./routes/OAuth").then((m) => ({ default: m.Device })))

/** First path segments that are the home domain's own pages, not old /<slug> links. */
const homePages = new Set(["_design", "oauth", "device"])

// Old /<slug>/… links on the home domain move to the app's subdomain.
const [, first, ...rest] = window.location.pathname.split("/")
const moved = onHome && first && !homePages.has(first) ? appPath(first, `/${rest.join("/")}`) : null
if (moved) window.location.replace(moved + window.location.search + window.location.hash)
else start()

function warmInitialRoute() {
  const slug = hostSlug ?? (!onHome && first && !homePages.has(first) ? decodeURIComponent(first) : null)
  if (!slug) return
  const subpath = hostSlug ? window.location.pathname : `/${rest.join("/")}`
  if (subpath === "/_design") return
  load(keys.app(slug), () => api.app(slug)).catch(() => {})
  if (subpath === "/" || subpath === "") {
    const q = new URLSearchParams(window.location.search).get("q") ?? "is:open"
    const filter = parseQuery(q)
    load(listKey(slug, filter), () => api.issues(slug, { state: filter.state, label: filter.label, q: filter.text })).catch(() => {})
    return
  }
  const issueMatch = /^\/issues\/([1-9]\d*)$/.exec(subpath)
  if (issueMatch) {
    const n = Number(issueMatch[1])
    load(keys.issue(slug, n), () => api.issue(slug, n)).catch(() => {})
    void loadMarkdown()
    return
  }
  if (subpath === "/new") void loadMarkdown()
}

function start() {
  // Fires first so a brand-new browser mints one bh_guest cookie before the remaining boot fetches go out.
  loadMe().catch(() => {})
  warmInitialRoute()
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Suspense fallback={null}>{hostSlug ? <AppRoutes slug={hostSlug} /> : <PathRoutes />}</Suspense>
    </StrictMode>,
  )
}

/** Production: the subdomain names the app, so routes start at "/". */
function AppRoutes({ slug }: { slug: string }) {
  return (
    <Switch>
      <Route path="/_design" component={DesignSystem} />
      <Route path="/new">{() => <NewIssue slug={slug} />}</Route>
      <Route path="/issues/:number">
        {(p) => (/^[1-9]\d*$/.test(p.number) ? <IssuePage slug={slug} number={Number(p.number)} /> : <NotFound />)}
      </Route>
      <Route path="/settings/:section?">
        {(p) => (
          <Suspense fallback={<AppLayout slug={slug} tab="settings">{() => null}</AppLayout>}>
            <Settings slug={slug} section={p.section} />
          </Suspense>
        )}
      </Route>
      <Route path="/">{() => <Issues slug={slug} />}</Route>
      <Route>{() => <NotFound />}</Route>
    </Switch>
  )
}

/** The home domain, and every page in dev, where apps live under /<slug>. */
function PathRoutes() {
  return (
    <Switch>
      <Route path="/_design" component={DesignSystem} />
      <Route path="/">{() => <Home />}</Route>
      <Route path="/oauth/consent" component={Consent} />
      <Route path="/device" component={Device} />
      <Route path="/:slug/new">{(p) => <NewIssue slug={p.slug} />}</Route>
      <Route path="/:slug/issues/:number">
        {(p) => (/^[1-9]\d*$/.test(p.number) ? <IssuePage slug={p.slug} number={Number(p.number)} /> : <NotFound />)}
      </Route>
      <Route path="/:slug/settings/:section?">
        {(p) => (
          <Suspense fallback={<AppLayout slug={p.slug} tab="settings">{() => null}</AppLayout>}>
            <Settings slug={p.slug} section={p.section} />
          </Suspense>
        )}
      </Route>
      <Route path="/:slug">{(p) => <Issues slug={p.slug} />}</Route>
      <Route>{() => <NotFound />}</Route>
    </Switch>
  )
}
