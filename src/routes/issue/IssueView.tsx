import { useState, type RefObject } from "react"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { ActorAvatar, ActorName } from "../../ui/Actor"
import { PersonIcon } from "../../ui/icons"
import { Markdown } from "../../ui/Markdown"
import { Button } from "../../ui/primitives"
import { Page } from "../../ui/Shell"
import { AppLink } from "../../ui/SiteLink"
import { Composer } from "./Composer"
import { BodyForm, TitleForm } from "./Editing"
import { blocks, entries, type IssueModel } from "./model"
import { IssueSidebar, MobileDetails, MobileProps } from "./Sidebar"
import { AttachmentList, EventBurst, EventLine, MessageGroup, TypingLine } from "./Timeline"

/** The issue page: the report and thread on the left with the pinned composer under them, the sidebar on the right.
 *  Phones get one column with property pills under the title and the sidebar's information folded into "Details". */
export function IssueView({ model, nameField }: { model: IssueModel; nameField: RefObject<HTMLInputElement | null> }) {
  const { app, issue, actionError } = model
  return (
    <Page>
      <div className="issue">
        <div className="issue-main">
          <Report model={model} />
          <MobileDetails model={model} />
          <div className="thread">
            {blocks(entries(model)).map((b) =>
              b.kind === "events" ? (
                b.events.length > 2 ? (
                  <EventBurst key={b.key} slug={app.slug} events={b.events} />
                ) : (
                  b.events.map((e) => <EventLine key={e.id} slug={app.slug} event={e} />)
                )
              ) : (
                <MessageGroup key={b.key} slug={app.slug} author={b.author} byAuthor={b.byAuthor} messages={b.messages} />
              ),
            )}
            <TypingLine activity={issue.activity} />
          </div>
          {actionError && (
            <p className="flash" data-tone="danger">
              {actionError}
            </p>
          )}
          <Composer model={model} nameField={nameField} />
        </div>
        <IssueSidebar model={model} />
      </div>
    </Page>
  )
}

function Report({ model }: { model: IssueModel }) {
  const { app, issue, canEdit, viewers } = model
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingBody, setEditingBody] = useState(false)
  const loose = issue.attachments.filter((a) => !issue.body.includes(a.url))

  return (
    <header className="report">
      {editingTitle ? (
        <TitleForm app={app} issue={issue} onDone={() => setEditingTitle(false)} />
      ) : (
        <div className="report-head">
          <h1 className="report-title">
            {issue.title} <span className="mono report-number">#{issue.number}</span>
          </h1>
          <div className="report-actions">
            {canEdit && (
              <Button size="small" variant="invisible" onClick={() => setEditingTitle(true)}>
                Edit
              </Button>
            )}
            <AppLink slug={app.slug} href={appPath(app.slug, "/new")} className="btn report-new" data-variant="default" data-size="small">
              New issue
            </AppLink>
          </div>
        </div>
      )}
      <p className="report-by">
        <ActorAvatar actor={issue.author} size={18} />
        <span>
          <ActorName actor={issue.author} /> opened this <Time iso={issue.created_at} />
          {viewers !== null && viewers > 0 && (
            <span className="report-viewers" title="People on this page now">
              {" · "}
              <PersonIcon size={12} /> {viewers} viewing
            </span>
          )}
        </span>
      </p>
      <MobileProps model={model} />

      <div className="report-body">
        {editingBody ? (
          <BodyForm app={app} issue={issue} onDone={() => setEditingBody(false)} />
        ) : (
          <>
            <Markdown source={issue.body} slug={app.slug} />
            {loose.length > 0 && <AttachmentList attachments={loose} />}
            {canEdit && (
              <button type="button" className="report-edit-body" onClick={() => setEditingBody(true)}>
                Edit description
              </button>
            )}
          </>
        )}
      </div>
    </header>
  )
}
