import { useEffect, useState } from "react"
import { useLocation, useSearch } from "wouter"
import type { AppDetail, Contact, ContactDetail, ContactPage } from "../../../shared/api"
import { t as tc, useT as useCoreT } from "../../i18n/core"
import { tr, useT } from "../../i18n/helpdesk"
import { ApiFailure, api, errorMessage, keys } from "../../lib/api"
import { setData, useResource } from "../../lib/cache"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { SearchIcon } from "../../ui/icons"
import { Button } from "../../ui/primitives"
import { AppLayout, ErrorPage, Page } from "../../ui/Shell"
import { AppLink } from "../../ui/SiteLink"
import { IssueRow } from "../Issues"
import { ContactBadge, contactName } from "../../ui/helpdesk/Requester"

const denied = () => <ErrorPage error={new ApiFailure(404, "not_found", "Not found")} />

/** /contacts: the help desk's requesters, for the team (search by name, email or external id). */
export function ContactsPage({ slug }: { slug: string }) {
  const t = useT()
  return (
    <AppLayout slug={slug} tab="contacts" crumb={{ label: t("contacts.title"), href: appPath(slug, "/contacts") }}>
      {(app) => (app.role ? <ContactList app={app} /> : denied())}
    </AppLayout>
  )
}

function ContactList({ app }: { app: AppDetail }) {
  const t = useT()
  useCoreT()
  const slug = app.slug
  const [, navigate] = useLocation()
  const q = new URLSearchParams(useSearch()).get("q") ?? ""
  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  const key = keys.contacts(slug, q)
  const { data, error } = useResource<ContactPage>(key, () => api.contacts(slug, { q: q || undefined }), 10_000)
  const [more, setMore] = useState(false)
  const loadMore = async () => {
    if (!data?.next_cursor) return
    setMore(true)
    try {
      const page = await api.contacts(slug, { q: q || undefined, cursor: data.next_cursor })
      setData<ContactPage>(key, (prev) => ({ contacts: [...(prev?.contacts ?? []), ...page.contacts], next_cursor: page.next_cursor }))
    } finally {
      setMore(false)
    }
  }
  return (
    <Page narrow>
      <h1 className="page-title">{t("contacts.title")}</h1>
      <form
        className="contacts-toolbar"
        role="search"
        onSubmit={(e) => {
          e.preventDefault()
          const next = draft.trim()
          navigate(appPath(slug, next ? `/contacts?q=${encodeURIComponent(next)}` : "/contacts"))
        }}
      >
        <div className="input">
          <SearchIcon size={14} />
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t("contacts.search")} aria-label={t("contacts.search")} spellCheck={false} />
        </div>
      </form>
      <section className="box" aria-busy={!data || undefined}>
        {!data && !error && <div className="box-row skeleton-row" />}
        {!!error && !data && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {data?.contacts.length === 0 && (
          <div className="box-empty">{q ? tr("contacts.noMatch", { query: <strong>{q}</strong> }) : t("contacts.none")}</div>
        )}
        {data?.contacts.map((c) => <ContactRow key={c.id} slug={slug} contact={c} />)}
      </section>
      {data?.next_cursor && (
        <div className="list-footer">
          <Button onClick={loadMore} disabled={more}>
            {more ? tc("common.loading") : tc("common.loadMore")}
          </Button>
        </div>
      )}
    </Page>
  )
}

function ContactRow({ slug, contact }: { slug: string; contact: Contact }) {
  const t = useT()
  const detail = [contact.email ?? (contact.unverified_email && t("side.unverifiedEmail", { email: contact.unverified_email })), contact.external_id]
    .filter(Boolean)
    .join(" · ")
  return (
    <AppLink slug={slug} href={appPath(slug, `/contacts/${encodeURIComponent(contact.id)}`)} className="box-row contact-row">
      <span className="contact-row-main">
        <span className="contact-row-name">
          <span>{contactName(contact)}</span>
          <ContactBadge contact={contact} compact />
        </span>
        {detail && <span className="contact-row-meta">{detail}</span>}
      </span>
      <span className="contact-row-side">
        {contact.last_seen_at ? tr("contacts.lastSeen", { time: <Time iso={contact.last_seen_at} /> }) : tr("contacts.firstSeen", { time: <Time iso={contact.created_at} /> })}
      </span>
    </AppLink>
  )
}

/** /contacts/:id: one requester, how they're verified, and their requests. */
export function ContactPageView({ slug, id }: { slug: string; id: string }) {
  const t = useT()
  return (
    <AppLayout slug={slug} tab="contacts" crumb={{ label: t("contacts.back"), href: appPath(slug, "/contacts") }}>
      {(app) => (app.role ? <ContactView app={app} id={id} /> : denied())}
    </AppLayout>
  )
}

function ContactView({ app, id }: { app: AppDetail; id: string }) {
  const t = useT()
  const { data, error } = useResource<ContactDetail>(keys.contact(app.slug, id), () => api.contact(app.slug, id), 10_000)
  if (error && !data) return <ErrorPage error={error} slug={app.slug} />
  return (
    <Page narrow>
      {!data ? (
        <div className="skeleton" style={{ width: "100%", height: 160 }} />
      ) : (
        <div className="contact-detail">
          <div className="contact-detail-head">
            <h1 className="page-title">{contactName(data)}</h1>
            <ContactBadge contact={data} workspace={app.name} />
          </div>
          <dl className="contact-facts">
            <dt>{t("contacts.email")}</dt>
            <dd>{data.email ?? (data.unverified_email ? t("side.unverifiedEmail", { email: data.unverified_email }) : "—")}</dd>
            {data.external_id && (
              <>
                <dt>{t("side.externalId")}</dt>
                <dd className="mono">{data.external_id}</dd>
              </>
            )}
            <dt>{t("contacts.since")}</dt>
            <dd>
              <Time iso={data.created_at} />
            </dd>
          </dl>
          <section>
            <h2 className="section-title">{t("contacts.requests")}</h2>
            {data.requests.length === 0 ? (
              <p className="muted-text">{t("contacts.noRequests")}</p>
            ) : (
              <div className="issue-list">
                {data.requests.map((issue) => (
                  <IssueRow key={issue.id} slug={app.slug} issue={issue} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Page>
  )
}
