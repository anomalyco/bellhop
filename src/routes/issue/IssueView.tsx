import { useState, type RefObject } from "react"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { ActorAvatar, ActorName } from "../../ui/Actor"
import { KebabIcon, PersonIcon } from "../../ui/icons"
import { Menu, MenuItem } from "../../ui/Menu"
import { Markdown } from "../../ui/Markdown"
import { Button } from "../../ui/primitives"
import { Page } from "../../ui/Shell"
import { AppLink } from "../../ui/SiteLink"
import { Composer } from "./Composer"
import { BodyForm, TitleForm } from "./Editing"
import { blocks, entries, type IssueModel } from "./model"
import { IssueSidebar, MobileDetails, MobileProps } from "./Sidebar"
import { AttachmentList, EventBurst, EventLine, MessageGroup, TypingLine } from "./Timeline"
import { EditedMarker, HiddenLine, IssueFlags, reasons, type CommentContext } from "./Moderation"

/** The issue page: the report and thread on the left with the pinned composer under them, the sidebar on the right.
 *  Phones get one column with property pills under the title and the sidebar's information folded into "Details". */
export function IssueView({ model, nameField }: { model: IssueModel; nameField: RefObject<HTMLInputElement | null> }) {
  const { app, issue, actionError } = model
  const ctx: CommentContext = { app, issue, member: model.member, viewerId: model.viewer?.id ?? null }
  return (
    <Page>
      <div className="issue">
        <div className="issue-main">
          <Report model={model} />
          <MobileDetails model={model} />
          <div className="thread">
            {blocks(entries(model)).map((b) =>
              b.kind === "hidden" ? (
                <HiddenLine key={b.key} reason={b.reason} />
              ) : b.kind === "events" ? (
                b.events.length > 2 ? (
                  <EventBurst key={b.key} slug={app.slug} events={b.events} />
                ) : (
                  b.events.map((e) => <EventLine key={e.id} slug={app.slug} event={e} />)
                )
              ) : (
                <MessageGroup key={b.key} slug={app.slug} author={b.author} byAuthor={b.byAuthor} messages={b.messages} ctx={ctx} />
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
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
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
            <IssueMenu model={model} onDelete={() => setConfirmDelete(true)} />
          </div>
        </div>
      )}
      {confirmDelete && (
        <div className="report-confirm" role="alert">
          <p className="report-confirm-text">
            <strong>Delete #{issue.number} permanently?</strong> Its comments, files, events and history go too, and this can't be undone.
          </p>
          <div className="report-confirm-actions">
            <Button size="small" variant="invisible" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="danger"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true)
                try {
                  await model.onDelete()
                } catch {
                  setDeleting(false)
                }
              }}
            >
              {deleting ? "Deleting…" : "Delete issue"}
            </Button>
          </div>
        </div>
      )}
      <p className="report-by">
        <ActorAvatar actor={issue.author} size={18} />
        <span>
          <ActorName actor={issue.author} /> opened this <Time iso={issue.created_at} />
          {issue.edited_at && (
            <>
              {" · "}
              <EditedMarker slug={app.slug} number={issue.number} />
            </>
          )}
          {viewers !== null && viewers > 0 && (
            <span className="report-viewers" title="People on this page now">
              {" · "}
              <PersonIcon size={12} /> {viewers} viewing
            </span>
          )}
        </span>
      </p>
      <IssueFlags issue={issue} />
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

/**
 * The issue's "…": for the team, make it private or public, hide or unhide it, and (admins) delete it; for the
 * reporter, privacy when the workspace lets reporters choose. Absent when there's nothing to offer.
 */
function IssueMenu({ model, onDelete }: { model: IssueModel; onDelete: () => void }) {
  const { app, issue, member } = model
  const admin = app.role === "owner" || app.role === "admin"
  const privacy = member || (issue.viewer_is_author && !!app.visibility?.reporter_can_choose)
  if (!member && !privacy) return null
  return (
    <Menu
      align="end"
      width={260}
      trigger={(p) => <Button iconOnly size="small" variant="invisible" aria-label="Issue actions" icon={<KebabIcon />} {...p} />}
    >
      {(close) => {
        const pick = (fn: () => unknown) => () => {
          close()
          void Promise.resolve(fn()).catch(() => {})
        }
        return (
          <>
            {privacy &&
              (issue.private ? (
                <MenuItem description="Anyone with the link can see it" onSelect={pick(() => model.onPrivacy(false))}>
                  Make public
                </MenuItem>
              ) : (
                <MenuItem description="Only the team and the reporter can see it" onSelect={pick(() => model.onPrivacy(true))}>
                  Make private
                </MenuItem>
              ))}
            {member &&
              (issue.hidden ? (
                <MenuItem description="Back where everyone who could see it can" onSelect={pick(() => model.onHide(null))}>
                  Unhide issue
                </MenuItem>
              ) : (
                reasons.map((r) => (
                  <MenuItem key={r.value} description={r.value === "spam" ? "Only the team will see it" : undefined} onSelect={pick(() => model.onHide(r.value))}>
                    Hide as {r.label.toLowerCase()}
                  </MenuItem>
                ))
              ))}
            {admin && (
              <MenuItem danger description="Permanent, with its comments and files" onSelect={pick(onDelete)}>
                Delete issue
              </MenuItem>
            )}
          </>
        )
      }}
    </Menu>
  )
}
