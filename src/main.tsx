import { StrictMode, Suspense, lazy } from "react"
import { createRoot } from "react-dom/client"
import { Route, Switch } from "wouter"
import { loadConfig, loadMe } from "./lib/api"
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

function start() {
  loadMe().catch(() => {})
  loadConfig().catch(() => {})
  // The parser chunk is small; fetch it once the first paint is done so issue pages render markdown at once.
  const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 300))
  idle(() => void loadMarkdown())
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
