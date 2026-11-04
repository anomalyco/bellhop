import { StrictMode, Suspense, lazy } from "react"
import { createRoot } from "react-dom/client"
import { Route, Switch } from "wouter"
import { api, keys, loadConfig, loadMe } from "./lib/api"
import { load } from "./lib/cache"
import { fetchList, listKey, parseQuery } from "./lib/issues"
import { readBoot, seedBoot } from "./lib/page"
import { appPath, homeSegments, hostSlug, onHome } from "./lib/site"
import { Feed, feedKey, fetchFeed } from "./routes/Feed"
import { NewWorkspacePage, WorkspacesPage } from "./routes/Home"
import { SignInPage } from "./routes/home/SignIn"
import { IssuePage } from "./routes/IssuePage"
import { Issues } from "./routes/Issues"
import { NewIssue } from "./routes/NewIssue"
import { loadMarkdown } from "./ui/Markdown"
import { setLocale } from "./i18n"
import { resolveLocale } from "./i18n/locale"
import { LocaleSync } from "./ui/LanguageMenu"
import { AppLayout, NotFound } from "./ui/Shell"
import "./styles/theme.css"
import "./styles/components.css"
import "./styles/app.css"
import { DeskSignIn } from "./routes/helpdesk/SignIn"

const DesignSystem = lazy(() => import("./routes/DesignSystem").then((m) => ({ default: m.DesignSystem })))
const Settings = lazy(() => import("./routes/Settings"))
const Consent = lazy(() => import("./routes/OAuth").then((m) => ({ default: m.Consent })))
const Device = lazy(() => import("./routes/OAuth").then((m) => ({ default: m.Device })))
const Agents = lazy(() => import("./routes/Agents").then((m) => ({ default: m.AgentsPage })))
const Reports = lazy(() => import("./routes/Reports").then((m) => ({ default: m.ReportsPage })))
const ContactsPage = lazy(() => import("./routes/helpdesk/Contacts").then((m) => ({ default: m.ContactsPage })))
const ContactPageView = lazy(() => import("./routes/helpdesk/Contacts").then((m) => ({ default: m.ContactPageView })))
const NotificationSettings = lazy(() => import("./routes/NotificationSettings").then((m) => ({ default: m.NotificationSettingsPage })))

// A deploy swaps hashed /assets/* chunks across edge colos over a few seconds, and open tabs can outlive their
// lazy chunks: reload once per location on a chunk/preload failure so mid-deploy visitors recover without looping.
const chunkReloadKey = "bh:chunk-reload"
let chunkFailed = false
let chunkReloading = false
function reloadOnChunkError(prevent?: () => void) {
  chunkFailed = true
  if (chunkReloading) {
    prevent?.()
    return
  }
  try {
    const here = window.location.pathname + window.location.search
    if (sessionStorage.getItem(chunkReloadKey) === here) return
    sessionStorage.setItem(chunkReloadKey, here)
  } catch {
    return
  }
  chunkReloading = true
  prevent?.()
  window.location.reload()
}
window.addEventListener("vite:preloadError", (e) => reloadOnChunkError(() => e.preventDefault()))
window.addEventListener("unhandledrejection", (e) => {
  const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? "")
  if (/Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed/i.test(msg))
    reloadOnChunkError(() => e.preventDefault())
})
window.setTimeout(() => {
  if (!chunkFailed) {
    try {
      sessionStorage.removeItem(chunkReloadKey)
    } catch {}
  }
}, 10_000)

const homePages = homeSegments

// Old /<slug>/… links on the home domain move to the app's subdomain.
const [, first, ...rest] = window.location.pathname.split("/")
const moved = onHome && first && !homePages.has(first) ? appPath(first, `/${rest.join("/")}`) : null
if (moved) window.location.replace(moved + window.location.search + window.location.hash)
else start()

/** No boot data (an old cached page, or a dev setup without the Worker): fetch what the first screen reads. */
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

/** With boot data the API is already answered; only the code the first screen needs is still worth warming. */
function warmInitialCode() {
  const subpath = hostSlug ? window.location.pathname : `/${rest.join("/")}`
  const inApp = !!hostSlug || (!onHome && !!first && !homePages.has(first))
  if (inApp && (/^\/issues\/[1-9]\d*$/.test(subpath) || subpath === "/new")) void loadMarkdown()
}

function start() {
  // The HTML carries the first screen's data (me, config, the workspace, the list or issue): seed it before the
  // first render, so the first paint is the real page with no API calls ahead of it.
  const boot = readBoot()
  const render = () =>
    !chunkReloading &&
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <LocaleSync />
        <Suspense fallback={null}>{hostSlug ? <AppRoutes slug={hostSlug} /> : <PathRoutes />}</Suspense>
      </StrictMode>,
    )
  // The language's catalog comes before the first render, so the first paint is already in that language.
  const language = setLocale(resolveLocale(boot?.me))
  const cap = <T,>(p: Promise<T>) => Promise.race([p, new Promise((r) => setTimeout(r, 1500))])
  if (boot) {
    seedBoot(boot)
    warmInitialCode()
    // An issue's first paint is its rendered thread: wait (briefly) for the markdown renderer rather than paint
    // raw text that reflows when it arrives.
    void cap(Promise.all([language, boot.route.kind === "issue" ? loadMarkdown() : null])).finally(render)
    return
  }
  // Fires first so a brand-new browser mints one bh_guest cookie before the remaining boot fetches go out.
  loadMe().catch(() => {})
  warmInitialRoute()
  void cap(language).finally(render)
}

/** Production: the subdomain names the app, so routes start at "/". */
function AppRoutes({ slug }: { slug: string }) {
  return (
    <Switch>
      <Route path="/_design" component={DesignSystem} />
      <Route path="/new">{() => <NewIssue slug={slug} />}</Route>
      <Route path="/signin">{() => <DeskSignIn slug={slug} />}</Route>
      <Route path="/contacts">{() => <ContactsPage slug={slug} />}</Route>
      <Route path="/contacts/:id">{(p) => <ContactPageView slug={slug} id={p.id} />}</Route>
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
      <Route path="/:slug/signin">{(p) => <DeskSignIn slug={p.slug} />}</Route>
      <Route path="/:slug/contacts">{(p) => <ContactsPage slug={p.slug} />}</Route>
      <Route path="/:slug/contacts/:id">{(p) => <ContactPageView slug={p.slug} id={p.id} />}</Route>
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
      <Route path="/:slug/*">{(p) => <NotFound slug={p.slug} />}</Route>
      <Route>{() => <NotFound />}</Route>
    </Switch>
  )
}
