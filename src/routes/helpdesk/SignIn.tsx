import { useEffect } from "react"
import { useLocation, useSearch } from "wouter"
import type { AppDetail, Me } from "../../../shared/api"
import { tr, useT } from "../../i18n/helpdesk"
import { ApiFailure, api, keys } from "../../lib/api"
import { invalidate, setData } from "../../lib/cache"
import { isDesk, safeDeskNext } from "../../lib/helpdesk"
import { appPath } from "../../lib/site"
import { EmailCode } from "../../ui/helpdesk/EmailCode"
import { AppLayout, ErrorPage, Page, useMe } from "../../ui/Shell"
import { AppLink } from "../../ui/SiteLink"

/** /signin on a help desk: email, then a code; this browser becomes that contact and its guest requests follow. */
export function DeskSignIn({ slug }: { slug: string }) {
  return <AppLayout slug={slug} tab="issues">{(app) => (isDesk(app) ? <Body app={app} /> : <ErrorPage error={new ApiFailure(404, "not_found", "Not found")} slug={slug} />)}</AppLayout>
}

function Body({ app }: { app: AppDetail }) {
  const t = useT()
  const [, navigate] = useLocation()
  const next = safeDeskNext(app.slug, new URLSearchParams(useSearch()).get("next"))
  const { data: me } = useMe()
  const signedIn = !!me?.contact
  useEffect(() => {
    if (signedIn) navigate(next, { replace: true })
  }, [signedIn, next, navigate])

  return (
    <Page>
      <div className="desk-signin">
        <div className="desk-signin-head">
          <h1 className="desk-signin-title">{t("signin.title")}</h1>
          <p className="desk-signin-text">{t("signin.text")}</p>
        </div>
        <EmailCode<Me>
          id="desk-signin"
          autoFocus
          start={(email) => api.contactStart(app.slug, email)}
          verify={(email, code) => api.contactVerify(app.slug, email, code)}
          onVerified={(nextMe) => {
            // The contact's requests (and this browser's guest ones, now theirs) replace what the lists held
            invalidate(keys.lists(app.slug))
            setData<Me>(keys.me, nextMe)
          }}
        />
        <AppLink slug={app.slug} href={appPath(app.slug)} className="desk-signin-back">
          {tr("signin.back", { workspace: app.name })}
        </AppLink>
      </div>
    </Page>
  )
}
