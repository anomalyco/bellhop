import { useEffect, useState, type ReactNode } from "react"
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
import { InvitationDot } from "./features/Invitations"
import { LanguageButton, LanguageItems } from "./LanguageMenu"
import { useLocale } from "../i18n"
import { t, useT } from "../i18n/core"
import { LANGUAGE_NAMES } from "../i18n/locale"
import { ChevronDownIcon } from "./icons"
import "../lib/motion"
import "../styles/motion.css"
import "../styles/i18n.css"

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
  const t = useT()
  const locale = useLocale()
  // The account menu shows its links, or (after "Language") the language list in the same panel
  const [view, setView] = useState<"main" | "language">("main")
  if (!me) {
    return (
      <span className="header-user header-user-placeholder" aria-hidden="true">
        <span className="btn header-language" data-variant="ghost-muted" data-icon-only="" />
        <span className="btn" data-variant="default">
          {t("common.signIn")}
        </span>
      </span>
    )
  }
  if (!me.user) {
    return (
      <span className="header-user">
        <LanguageButton />
        <SiteLink href={signInHref()} className="btn" data-variant="default">
          {t("common.signIn")}
        </SiteLink>
      </span>
    )
  }
  const user = me.user
  return (
    <Menu
      align="end"
      width={256}
      onOpenChange={(open) => open && setView("main")}
      trigger={(props) => (
        <button type="button" className="header-avatar" aria-label={t("header.account")} {...props}>
          <UserAvatar user={user} size={24} />
          <InvitationDot />
        </button>
      )}
    >
      {(close) =>
        view === "language" ? (
          <>
            <MenuItem onSelect={() => setView("main")}>
              <span className="menu-back">
                <ChevronDownIcon size={12} />
                {t("menu.language")}
              </span>
            </MenuItem>
            <LanguageItems onDone={close} />
          </>
        ) : (
          <>
            <MenuHeader>
              <strong>{user.name}</strong>
              <span className="menu-item-description">{user.email}</span>
            </MenuHeader>
            {(
              [
                [t("menu.workspaces"), homeUrl("/workspaces")],
                [t("menu.agents"), homeUrl("/agents")],
                [t("menu.reports"), homeUrl("/reports")],
                [t("menu.notifications"), homeUrl("/settings/notifications")],
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
            <MenuItem onSelect={() => setView("language")} description={LANGUAGE_NAMES[locale]}>
              {t("menu.language")}
            </MenuItem>
            <MenuItem
              onSelect={async () => {
                close()
                await api.logout()
                window.location.assign("/")
              }}
            >
              {t("menu.signOut")}
            </MenuItem>
          </>
        )
      }
    </Menu>
  )
}

/** A page inside a workspace, shown after its name in the header: "/ #12", "/ New issue". */
export interface Crumb {
  label: string
  href: string
  mono?: boolean
}

export function Header({
  app,
  slug,
  tab,
  pendingApp,
  crumb,
}: {
  app?: AppDetail | CachedAppMeta | { slug: string; name: string }
  /** The workspace being loaded, when `app` isn't known yet (nothing cached). */
  slug?: string
  tab?: "issues" | "settings"
  pendingApp?: boolean
  crumb?: Crumb
}) {
  useT()
  const detail = app && "counts" in app ? app : null
  const iconUrl = detail ? detail.icon_url : app && "icon_url" in app ? app.icon_url : null
  const openCount = detail ? detail.counts.open : app && "open" in app ? app.open : null
  const workspace = app?.slug ?? slug
  return (
    <header className="header" data-app={workspace || pendingApp ? "" : undefined}>
      <div className="header-inner">
        {workspace ? (
          // Inside a workspace it is the product: its icon and name lead to its issues. Until the name is known
          // (nothing cached) only the icon shows; the name, crumb and nav arrive together, so nothing moves.
          <div className="header-crumbs">
            <AppLink slug={workspace} href={appPath(workspace)} className="header-home" aria-label={app ? undefined : t("header.issues")}>
              <AppIcon src={iconUrl} size={22} />
              {app && <span className="header-app">{app.name}</span>}
            </AppLink>
            {app && crumb && (
              <span className="header-trail" data-mono={crumb.mono || undefined}>
                <span className="header-sep" aria-hidden="true">
                  /
                </span>
                <AppLink slug={workspace} href={crumb.href} className="header-crumb">
                  {crumb.label}
                </AppLink>
              </span>
            )}
          </div>
        ) : (
          <SiteLink href={homeUrl()} className="header-logo" aria-label={t("header.home")}>
            <Logo size={22} />
          </SiteLink>
        )}
        {app && (
          <nav className="app-nav" aria-label={app.name}>
            {/* The Issues tab renders before the app loads (its count held invisibly) so the header doesn't shift */}
            <AppLink slug={app.slug} href={appPath(app.slug)} aria-current={tab === "issues" ? "page" : undefined}>
              <IssueOpenIcon size={14} />
              {t("header.issues")} <Counter>{openCount !== null ? openCount : <span className="counter-pending">0</span>}</Counter>
            </AppLink>
            {detail?.role && (
              <AppLink
                slug={app.slug}
                href={appPath(app.slug, "/settings")}
                aria-current={tab === "settings" ? "page" : undefined}
                aria-label={t("header.settings")}
              >
                <SettingsIcon size={14} />
                <span className="nav-label">{t("header.settings")}</span>
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
  crumb,
  loading,
  children,
}: {
  slug: string
  tab: "issues" | "settings"
  crumb?: Crumb
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
        <Header app={cached ?? undefined} slug={slug} pendingApp={!cached} tab={tab} crumb={crumb} />
        {error ? <ErrorPage error={error} /> : (loading ?? null)}
      </>
    )
  }
  return (
    <>
      <Header app={app} tab={tab} crumb={crumb} />
      {children(app)}
    </>
  )
}

export function ErrorPage({ error }: { error: unknown }) {
  useT()
  const notFound = error instanceof ApiFailure && error.status === 404
  return (
    <Page>
      <div className="blank">
        <h1 className="blank-title">{notFound ? t("error.notFound") : t("error.generic")}</h1>
        <p className="muted-text">{notFound ? t("error.notFoundText") : errorMessage(error)}</p>
        <SiteLink href={homeUrl()} className="btn">
          {t("error.goHome")}
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
