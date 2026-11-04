import { StrictMode, Suspense, lazy } from "react"
import { createRoot } from "react-dom/client"
import { Route, Switch } from "wouter"
import { api, keys, loadConfig, loadMe } from "./lib/api"
import { load } from "./lib/cache"
import { fetchList, listKey, parseQuery } from "./lib/issues"
import { appPath, hostSlug, onHome } from "./lib/site"
import { Feed, feedKey, fetchFeed } from "./routes/Feed"
import { NewWorkspacePage, WorkspacesPage } from "./routes/Home"
import { SignInPage } from "./routes/home/SignIn"
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
const Agents = lazy(() => import("./routes/Agents").then((m) => ({ default: m.AgentsPage })))
const Reports = lazy(() => import("./routes/Reports").then((m) => ({ default: m.ReportsPage })))
const NotificationSettings = lazy(() => import("./routes/NotificationSettings").then((m) => ({ default: m.NotificationSettingsPage })))

/** First path segments that are the home domain's own pages, not old /<slug> links. */
const homePages = new Set(["_design", "oauth", "device", "agents", "signin", "workspaces", "new", "reports", "settings"])

// Old /<slug>/… links on the home domain move to the app's subdomain.
const [, first, ...rest] = window.location.pathname.split("/")
const moved = onHome && first && !homePages.has(first) ? appPath(first, `/${rest.join("/")}`) : null
if (moved) window.location.replace(moved + window.location.search + window.location.hash)
else start()

function warmInitialRoute() {
  if (!hostSlug && (window.location.pathname === "/signin" || window.location.pathname.startsWith("/oauth/") || window.location.pathname === "/device")) {
    loadConfig().catch(() => {})
    return
  }
  if (!hostSlug && window.location.pathname === "/") {
    // The home feed and its rail.
    const filter = parseQuery(new URLSearchParams(window.location.search).get("q") ?? "is:open")
    load(feedKey(filter), () => fetchFeed(filter)).catch(() => {})
    load(keys.feedApps, api.feedApps).catch(() => {})
    return
  }
  const slug = hostSlug ?? (!onHome && first && !homePages.has(first) ? decodeURIComponent(first) : null)
  if (!slug) return
  const subpath = hostSlug ? window.location.pathname : `/${rest.join("/")}`
  if (subpath === "/_design") return
  load(keys.app(slug), () => api.app(slug)).catch(() => {})
  if (subpath === "/" || subpath === "") {
    const q = new URLSearchParams(window.location.search).get("q") ?? "is:open"
    const filter = parseQuery(q)
    load(listKey(slug, filter), () => fetchList(slug, filter)).catch(() => {})
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
      <Route path="/" component={Feed} />
      <Route path="/signin" component={SignInPage} />
      <Route path="/workspaces" component={WorkspacesPage} />
      <Route path="/new" component={NewWorkspacePage} />
      <Route path="/oauth/consent" component={Consent} />
      <Route path="/device" component={Device} />
      <Route path="/agents" component={Agents} />
      <Route path="/reports" component={Reports} />
      <Route path="/settings/notifications" component={NotificationSettings} />
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
