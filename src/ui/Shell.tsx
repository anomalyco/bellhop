import type { ReactNode } from "react"
import { Link, useLocation, useSearch } from "wouter"
import type { AppDetail, Me } from "../../shared/api"
import { ApiFailure, api, errorMessage, keys } from "../lib/api"
import { useResource } from "../lib/cache"
import { UserAvatar } from "./Actor"
import { IssueOpenIcon, SettingsIcon } from "./icons"
import { Menu, MenuHeader, MenuItem } from "./Menu"
import { Counter, Logo } from "./primitives"

export function useMe() {
  return useResource<Me>(keys.me, api.me, 30_000)
}

export function useApp(slug: string) {
  return useResource<AppDetail>(keys.app(slug), () => api.app(slug), 10_000)
}

function UserMenu() {
  const { data: me } = useMe()
  const [location, navigate] = useLocation()
  const search = useSearch()
  if (!me) return <span className="header-user-placeholder" />
  if (!me.user) {
    const next = location === "/" ? "" : `?next=${encodeURIComponent(location + (search ? `?${search}` : ""))}`
    return (
      <Link href={`/${next}`} className="btn" data-variant="invisible" data-size="small">
        Sign in
      </Link>
    )
  }
  const user = me.user
  return (
    <Menu
      align="end"
      width={240}
      trigger={(props) => (
        <button type="button" className="header-avatar" aria-label="Account" {...props}>
          <UserAvatar user={user} size={28} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuHeader>
            <strong>{user.name}</strong>
            <span className="menu-item-description">{user.email}</span>
          </MenuHeader>
          <MenuItem
            onSelect={() => {
              close()
              navigate("/")
            }}
          >
            Your applications
          </MenuItem>
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

export function Header({ app }: { app?: { slug: string; name: string } }) {
  return (
    <header className="header" data-app={app ? "" : undefined}>
      <div className="header-inner">
        <Link href="/" className="header-logo" aria-label="Bellhop home">
          <Logo size={24} />
        </Link>
        {app && (
          <>
            <span className="header-sep">/</span>
            <Link href={`/${app.slug}`} className="header-app">
              {app.name}
            </Link>
          </>
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

/** Header plus the Issues/Settings nav for every page inside an application. */
export function AppLayout({ slug, tab, children }: { slug: string; tab: "issues" | "settings"; children: (app: AppDetail) => ReactNode }) {
  const { data: app, error } = useApp(slug)
  if (!app) {
    return (
      <>
        <Header app={{ slug, name: slug }} />
        {error ? <ErrorPage error={error} /> : <div className="app-nav app-nav-placeholder" />}
      </>
    )
  }
  return (
    <>
      <Header app={app} />
      <nav className="underline-nav app-nav">
        <div className="app-nav-inner">
          <Link href={`/${slug}`} aria-current={tab === "issues" ? "page" : undefined}>
            <IssueOpenIcon />
            Issues <Counter>{app.counts.open}</Counter>
          </Link>
          {app.role && (
            <Link
              href={`/${slug}/settings`}
              aria-current={tab === "settings" ? "page" : undefined}
              onPointerEnter={() => void import("../routes/Settings")}
            >
              <SettingsIcon />
              Settings
            </Link>
          )}
        </div>
      </nav>
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
        <Link href="/" className="btn">
          Go home
        </Link>
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
