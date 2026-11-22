import { useLocation } from "wouter"
import type { AppDetail, Issue } from "../../../shared/api"
import { useT } from "../../i18n/inbox"
import { withMeta } from "../../lib/inbox"
import { appPath, isAbsolute, orgPath } from "../../lib/site"
import { AppLink } from "../SiteLink"
import { EmailState, Facts, FbSection, Gallery, Metadata, repliedInPublic, SameInstall, screenshotsOf } from "./Feedback"
import "../../styles/inbox.css"

/**
 * On an app's own issue page (team only), for feedback from its in-app form: the screenshots, whether replies reach
 * the sender, app and device facts, metadata (a value opens the org inbox filtered to it) and other reports from the
 * same install.
 */
export function FeedbackPanel({ app, issue }: { app: AppDetail; issue: Issue }) {
  const t = useT()
  const [, navigate] = useLocation()
  const fb = issue.feedback
  if (!fb || !app.role) return null
  const shots = screenshotsOf(fb, issue.attachments)
  const org = app.org
  const filter = org
    ? (k: string, v: string) => {
        const href = orgPath(org.slug, `/${app.slug}?q=${encodeURIComponent(withMeta("", k, v))}`)
        if (isAbsolute(href)) window.location.assign(href)
        else navigate(href)
      }
    : undefined
  return (
    <section className="fb-panel" aria-label={t("panel.title")}>
      {shots.length > 0 && (
        <FbSection title={t("detail.screenshots")}>
          <Gallery shots={shots} />
        </FbSection>
      )}
      <FbSection title={t("email.label")}>
        <EmailState feedback={fb} replied={repliedInPublic(issue)} />
      </FbSection>
      <div className="fb-columns">
        <FbSection title={t("detail.facts")}>
          <Facts feedback={fb} />
        </FbSection>
        {Object.keys(fb.metadata ?? {}).length > 0 && (
          <FbSection title={t("detail.metadata")}>
            <Metadata metadata={fb.metadata} onFilter={filter} />
          </FbSection>
        )}
      </div>
      {fb.same_install.length > 0 && (
        <FbSection title={t("detail.sameInstall")}>
          <SameInstall
            refs={fb.same_install}
            link={(r) => (
              <AppLink slug={app.slug} href={appPath(app.slug, `/issues/${r.number}`)} className="fb-same-link">
                <span className="mono">#{r.number}</span> {r.title}
              </AppLink>
            )}
          />
        </FbSection>
      )}
    </section>
  )
}
