import { useEffect, type ReactNode } from "react"
import { useLocation } from "wouter"
import type { AppDetail, Me } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { useResource } from "../lib/cache"
import { setFavicon } from "../lib/favicon"
import { appPath, homeUrl, isAbsolute, signInHref } from "../lib/site"
import { UserAvatar } from "./Actor"
import { IssueOpenIcon, SettingsIcon } from "./icons"
import { Menu, MenuHeader, MenuItem } from "./Menu"
import { AppIcon, Counter, Logo } from "./primitives"
import { AppLink, SiteLink } from "./SiteLink"

export function useMe() {
  return useResource<Me>(keys.me, api.me, 30_000)
}

export function useApp(slug: string) {
  return useResource<AppDetail>(keys.app(slug), () => api.app(slug), 10_000)
}

interface CachedAppMeta {
  slug: string
  name: string
  icon_url: string | null
  open: number
}

const appMetaKey = (slug: string) => `bh_app:${slug}`

function readCachedApp(slug: string): CachedAppMeta | null {
  try {
    const raw = localStorage.getItem(appMetaKey(slug))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CachedAppMeta>
    if (typeof parsed.name !== "string" || typeof parsed.open !== "number") return null
    return { slug, name: parsed.name, icon_url: parsed.icon_url ?? null, open: parsed.open }
  } catch {
    return null
  }
}

function writeCachedApp(app: AppDetail) {
  try {
    localStorage.setItem(appMetaKey(app.slug), JSON.stringify({ name: app.name, icon_url: app.icon_url, open: app.counts.open }))
  } catch {
    // Ignore storage quota or privacy mode errors.
  }
}

function UserMenu() {
  const { data: me } = useMe()
  const [, navigate] = useLocation()
  if (!me) {
    return (
      <span className="btn header-user-placeholder" data-variant="default" aria-hidden="true">
        Sign in
      </span>
    )
  }
  if (!me.user) {
    return (
      <SiteLink href={signInHref()} className="btn" data-variant="default">
        Sign in
      </SiteLink>
    )
  }
  const user = me.user
  return (
    <Menu
      align="end"
      width={256}
      trigger={(props) => (
        <button type="button" className="header-avatar" aria-label="Account" {...props}>
          <UserAvatar user={user} size={24} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeader>
            <strong>{user.name}</strong>
            <span className="menu-item-description">{user.email}</span>
          </MenuHeader>
          {(
            [
              ["Your workspaces", homeUrl()],
              ["Agents", homeUrl("/agents")],
            ] as const
          ).map(([label, href]) => (
            <MenuItem
              key={href}
              onSelect={() => {
                close()
                if (isAbsolute(href)) window.location.assign(href)
                else navigate(href)
              }}
            >
              {label}
            </MenuItem>
          ))}
          <MenuItem
            onSelect={async () => {
              close()
              await api.logout()
              window.location.assign("/")
            }}
          >
            Sign out
          </MenuItem>
        </>
      )}
    </Menu>
  )
}

export function Header({
  app,
  tab,
  pendingApp,
}: {
  app?: AppDetail | CachedAppMeta | { slug: string; name: string }
  tab?: "issues" | "settings"
  pendingApp?: boolean
}) {
  const detail = app && "counts" in app ? app : null
  const iconUrl = detail ? detail.icon_url : app && "icon_url" in app ? app.icon_url : null
  const openCount = detail ? detail.counts.open : app && "open" in app ? app.open : null
  const inApp = !!app || !!pendingApp
  return (
    <header className="header" data-app={inApp ? "" : undefined}>
      <div className="header-inner">
        <SiteLink href={homeUrl()} className="header-logo" aria-label="Bellhop home">
          {iconUrl ? (
            // An app with its own icon leads with it; Bellhop stays as a quiet word beside it.
            <span className="logo" data-app-icon>
              <AppIcon src={iconUrl} size={22} />
              <span className="logo-word">Bellhop</span>
            </span>
          ) : (
            <Logo size={22} />
          )}
        </SiteLink>
        {app && (
          <>
            <span className="header-sep" aria-hidden="true">
              /
            </span>
            <AppLink slug={app.slug} href={appPath(app.slug)} className="header-app">
              {app.name}
            </AppLink>
          </>
        )}
        {app && (
          <nav className="app-nav" aria-label={app.name}>
            {/* The Issues tab renders before the app loads (its count held invisibly) so the header doesn't shift */}
            <AppLink slug={app.slug} href={appPath(app.slug)} aria-current={tab === "issues" ? "page" : undefined}>
              <IssueOpenIcon size={14} />
              Issues <Counter>{openCount !== null ? openCount : <span className="counter-pending">0</span>}</Counter>
            </AppLink>
            {detail?.role && (
              <AppLink
                slug={app.slug}
                href={appPath(app.slug, "/settings")}
                aria-current={tab === "settings" ? "page" : undefined}
                aria-label="Settings"
              >
                <SettingsIcon size={14} />
                <span className="nav-label">Settings</span>
              </AppLink>
            )}
          </nav>
        )}
        <span className="spacer" />
        <UserMenu />
      </div>
    </header>
  )
}

export function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return (
    <main className="page" data-narrow={narrow || undefined}>
      {children}
    </main>
  )
}

/** Header with the Issues/Settings nav for every page inside an application. */
export function AppLayout({
  slug,
  tab,
  loading,
  children,
}: {
  slug: string
  tab: "issues" | "settings"
  loading?: ReactNode
  children: (app: AppDetail) => ReactNode
}) {
  const { data: app, error } = useApp(slug)
  const cached = app ? null : readCachedApp(slug)
  const icon = app?.icon_url ?? cached?.icon_url ?? null
  useEffect(() => {
    if (app) writeCachedApp(app)
  }, [app])
  useEffect(() => {
    setFavicon(icon)
    return () => setFavicon(null)
  }, [icon])
  if (!app) {
    return (
      <>
        <Header app={cached ?? undefined} pendingApp={!cached} tab={tab} />
        {error ? <ErrorPage error={error} /> : (loading ?? null)}
      </>
    )
  }
  return (
    <>
      <Header app={app} tab={tab} />
      {children(app)}
    </>
  )
}

export function ErrorPage({ error }: { error: unknown }) {
  const notFound = error instanceof ApiFailure && error.status === 404
  return (
    <Page>
      <div className="blank">
        <h1 className="blank-title">{notFound ? "Not found" : "Something went wrong"}</h1>
        <p className="muted-text">{notFound ? "This page doesn't exist or was removed." : errorMessage(error)}</p>
        <SiteLink href={homeUrl()} className="btn">
          Go home
        </SiteLink>
      </div>
    </Page>
  )
}

export function NotFound() {
  return (
    <>
      <Header />
      <ErrorPage error={new ApiFailure(404, "not_found", "Not found")} />
    </>
  )
}
