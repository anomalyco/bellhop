import { StrictMode, Suspense, lazy } from "react"
import { createRoot } from "react-dom/client"
import { Route, Switch } from "wouter"
import { loadConfig, loadMe } from "./lib/api"
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

loadMe().catch(() => {})
loadConfig().catch(() => {})
// The parser chunk is small; fetch it once the first paint is done so issue pages render markdown at once.
const idle = window.requestIdleCallback ?? ((fn: () => void) => setTimeout(fn, 300))
idle(() => void loadMarkdown())

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Switch>
        <Route path="/_design" component={DesignSystem} />
        <Route path="/">{() => <Home />}</Route>
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
    </Suspense>
  </StrictMode>,
)
