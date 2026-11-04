import { useState } from "react"
import type { App } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { atLeast } from "../../lib/roles"
import { appLabel, appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { ActorAvatar, ActorName } from "../../ui/Actor"
import { ChevronDownIcon, KebabIcon, PersonIcon, ThumbIcon } from "../../ui/icons"
import { Menu, MenuItem } from "../../ui/Menu"
import { Markdown } from "../../ui/Markdown"
import { AppIcon, Button } from "../../ui/primitives"
import { Page } from "../../ui/Shell"
import { AppLink } from "../../ui/SiteLink"
import { Composer, LockedComposer } from "./Composer"
import { BodyForm, TitleForm } from "./Editing"
import { blocks, entries, type IssueModel } from "./model"
import { IssueSidebar, MobileDetails, MobileProps } from "./Sidebar"
import { AttachmentList, EventBurst, EventLine, MessageGroup, TypingLine } from "./Timeline"
import { EditedMarker, HiddenLine, IssueFlags, reasons, type CommentContext } from "./Moderation"
import { DiagnosticsBlock, logIds } from "../../ui/features/Diagnostics"
import { ImportedMarker } from "../../ui/features/Imported"
import { tr, useT } from "../../i18n/core"
import { formatNumber, sentenceGap } from "../../i18n"
import { VerificationThread, VerificationsProvider } from "../../ui/helpdesk/Requester"
import { useT as useDeskT } from "../../i18n/helpdesk"
import { deskOutsider } from "../../lib/helpdesk"
import { isDesk } from "../../lib/helpdesk"
import { ContactNamesProvider } from "../../ui/Actor"
import { contactLabel } from "../../lib/helpdesk"
import { RequestAnswers, RequestProvider, RequestTypeLabel } from "../../ui/helpdesk/RequestDetails"

/** The issue page: the report and thread on the left with the pinned composer under them, the sidebar on the right.
 *  Phones get one column with property pills under the title and the sidebar's information folded into "Details". */
export function IssueView({ model }: { model: IssueModel }) {
  useT()
  const { app, issue, actionError } = model
  const authorTier = issue.author.type !== "agent" ? (issue.author.tier ?? null) : null
  const ctx: CommentContext = { app, issue, member: model.member, viewerId: model.viewer?.id ?? null, signedIn: !!model.me?.user }
  // Contacts without a name read as their email: the requester's for the team, your own for you
  const contactNames: Record<string, string> = {}
  if (issue.contact?.email) contactNames[issue.contact.id] = issue.contact.email
  if (model.me?.contact) contactNames[model.me.contact.id] = contactLabel(model.me.contact)
  return (
    <ContactNamesProvider names={contactNames}>
    <Page>
      <div className="issue">
        <div className="issue-main">
          <Report model={model} />
          <MobileDetails model={model} />
          <VerificationsProvider issue={issue} member={model.member}>
          <RequestProvider app={app} issue={issue}>
          <div className="thread">
            {blocks(entries(model)).map((b) =>
              b.kind === "hidden" ? (
                <HiddenLine key={b.key} reason={b.reason} />
              ) : b.kind === "events" ? (
                b.events.length > 2 ? (
                  <EventBurst key={b.key} slug={app.slug} events={b.events} authorTier={authorTier} />
                ) : (
                  b.events.map((e) => <EventLine key={e.id} slug={app.slug} event={e} authorTier={authorTier} />)
                )
              ) : (
                <MessageGroup key={b.key} slug={app.slug} author={b.author} byAuthor={b.byAuthor} messages={b.messages} ctx={ctx} internal={b.internal} />
              ),
            )}
            <VerificationThread app={app} issue={issue} member={model.member} />
            <TypingLine activity={issue.activity} />
          </div>
          </RequestProvider>
          </VerificationsProvider>
          {actionError && (
            <p className="flash" data-tone="danger">
              {actionError}
            </p>
          )}
          {issue.locked && !model.member ? <LockedComposer /> : <Composer model={model} />}
        </div>
        <IssueSidebar model={model} />
      </div>
    </Page>
    </ContactNamesProvider>
  )
}

function Report({ model }: { model: IssueModel }) {
  const t = useT()
  const td = useDeskT()
  const { app, issue, canEdit, viewers } = model
  // A requester in a help desk: no "Me too" (requests are private), and New request rather than New issue
  const desk = deskOutsider(app)
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingBody, setEditingBody] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [moving, setMoving] = useState(false)
  const [menuError, setMenuError] = useState<string | null>(null)
  // Report metadata on the issue itself (not on a comment): shown as Diagnostics, its logs not as loose files.
  const diagnostics = (issue.metadata ?? []).filter((m) => m.attached_to?.comment_id == null)
  const logs = logIds(issue.metadata)
  const loose = issue.attachments.filter((a) => !issue.body.includes(a.url) && !logs.has(a.id))

  return (
    <header className="report">
      <RequestTypeLabel issue={issue} />
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
                {t("issue.edit")}
              </Button>
            )}
            {!isDesk(app) && <MeToo model={model} />}
            <AppLink slug={app.slug} href={appPath(app.slug, "/new")} className="btn report-new" data-variant="default" data-size="small">
              {desk ? td("home.newRequest") : t("issue.newIssue")}
            </AppLink>
            <IssueMenu model={model} onDelete={() => setConfirmDelete(true)} onMove={() => setMoving(true)} onError={setMenuError} />
          </div>
        </div>
      )}
      {menuError && (
        <p className="flash report-error" data-tone="danger" role="alert">
          {menuError}
        </p>
      )}
      {moving && <MovePanel model={model} onCancel={() => setMoving(false)} />}
      {confirmDelete && (
        <div className="report-confirm" role="alert">
          <p className="report-confirm-text">
            <strong>{t("issue.deleteConfirm", { number: String(issue.number) })}</strong>
            {sentenceGap()}
            {t("issue.deleteConfirmText")}
          </p>
          <div className="report-confirm-actions">
            <Button size="small" variant="invisible" onClick={() => setConfirmDelete(false)} disabled={deleting}>
              {t("common.cancel")}
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
              {deleting ? t("issue.deleting") : t("issue.delete")}
            </Button>
          </div>
        </div>
      )}
      <p className="report-by">
        <ActorAvatar actor={issue.author} size={18} />
        <span>
          {tr("issue.openedBy", { author: <ActorName actor={issue.author} />, time: <Time iso={issue.created_at} /> })}
          {issue.edited_at && (
            <>
              {" · "}
              <EditedMarker slug={app.slug} number={issue.number} />
            </>
          )}
          {viewers !== null && viewers > 0 && (
            <span className="report-viewers" title={t("issue.viewersTitle")}>
              {" · "}
              <PersonIcon size={12} /> {t("issue.viewing", { count: viewers })}
            </span>
          )}
        </span>
      </p>
      {issue.imported && <ImportedMarker imported={issue.imported} />}
      <IssueFlags issue={issue} desk={isDesk(app)} />
      <MobileProps model={model} />

      <div className="report-body">
        {editingBody ? (
          <BodyForm app={app} issue={issue} onDone={() => setEditingBody(false)} />
        ) : (
          <>
            <Markdown source={issue.body} slug={app.slug} mentions={issue.mentions} />
            {loose.length > 0 && <AttachmentList attachments={loose} />}
            {canEdit && (
              <button type="button" className="report-edit-body" onClick={() => setEditingBody(true)}>
                {t("issue.editDescription")}
              </button>
            )}
            <RequestAnswers app={app} issue={issue} />
            <DiagnosticsBlock metadata={diagnostics} />
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
function IssueMenu({
  model,
  onDelete,
  onMove,
  onError,
}: {
  model: IssueModel
  onDelete: () => void
  onMove: () => void
  onError: (message: string | null) => void
}) {
  const t = useT()
  const { app, issue, member } = model
  const admin = app.role === "owner" || app.role === "admin"
  // Locking, pinning and moving are triage: members and up (viewers on the team can't).
  const triage = atLeast(app.role, "member")
  const privacy = member || (issue.viewer_is_author && !!app.visibility?.reporter_can_choose)
  if (!member && !privacy) return null
  return (
    <Menu
      align="end"
      width={260}
      trigger={(p) => <Button iconOnly size="small" variant="ghost-muted" aria-label={t("issue.actions")} icon={<KebabIcon />} {...p} />}
    >
      {(close) => {
        const pick = (fn: () => unknown) => () => {
          close()
          onError(null)
          void Promise.resolve(fn()).catch((e) => onError(errorMessage(e)))
        }
        return (
          <>
            {triage && (
              <>
                <MenuItem
                  description={issue.pinned ? t("issue.unpinText") : t("issue.pinText")}
                  onSelect={pick(() => model.onPin(!issue.pinned))}
                >
                  {issue.pinned ? t("issue.unpin") : t("issue.pin")}
                </MenuItem>
                <MenuItem
                  description={issue.locked ? t("issue.unlockText") : t("issue.lockText")}
                  onSelect={pick(() => model.onLock(!issue.locked))}
                >
                  {issue.locked ? t("issue.unlock") : t("issue.lock")}
                </MenuItem>
              </>
            )}
            {privacy &&
              (issue.private ? (
                <MenuItem description={t("issue.makePublicText")} onSelect={pick(() => model.onPrivacy(false))}>
                  {t("issue.makePublic")}
                </MenuItem>
              ) : (
                <MenuItem description={t("issue.makePrivateText")} onSelect={pick(() => model.onPrivacy(true))}>
                  {t("issue.makePrivate")}
                </MenuItem>
              ))}
            {member &&
              (issue.hidden ? (
                <MenuItem description={t("issue.unhideText")} onSelect={pick(() => model.onHide(null))}>
                  {t("issue.unhide")}
                </MenuItem>
              ) : (
                reasons.map((r) => (
                  <MenuItem key={r.value} description={r.value === "spam" ? t("issue.hideSpamText") : undefined} onSelect={pick(() => model.onHide(r.value))}>
                    {r.hideAs}
                  </MenuItem>
                ))
              ))}
            {triage && (
              <MenuItem description={t("issue.moveText")} onSelect={pick(onMove)}>
                {t("issue.move")}
              </MenuItem>
            )}
            {admin && (
              <MenuItem danger description={t("issue.deleteText")} onSelect={pick(onDelete)}>
                {t("issue.delete")}
              </MenuItem>
            )}
          </>
        )
      }}
    </Menu>
  )
}

/** "Me too": everyone can add theirs (guests pass the human check), with the count. */
function MeToo({ model }: { model: IssueModel }) {
  const t = useT()
  const { issue } = model
  const on = !!issue.viewer_voted
  const votes = issue.votes ?? 0
  return (
    <Button
      size="small"
      className="btn me-too"
      aria-pressed={on}
      data-active={on || undefined}
      title={on ? t("metoo.on") : t("metoo.off")}
      icon={<ThumbIcon size={14} />}
      onClick={() => void model.onVote(!on)}
    >
      {t("metoo.label")}
      {votes > 0 && <span className="mono-num me-too-n">{formatNumber(votes)}</span>}
    </Button>
  )
}

/** Moving to another workspace: pick where (workspaces you're a member of), see what carries over, then move. */
function MovePanel({ model, onCancel }: { model: IssueModel; onCancel: () => void }) {
  const t = useT()
  const { app, issue } = model
  const { data: apps } = useResource<App[]>(keys.apps, api.apps, 10_000)
  const targets = (apps ?? []).filter((a) => a.slug !== app.slug && atLeast(a.role, "member"))
  const [to, setTo] = useState<App | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const move = async () => {
    if (!to) return
    setBusy(true)
    setError(null)
    try {
      await model.onTransfer(to.slug)
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="report-confirm move-panel">
      <div className="move-pick">
        <span className="report-confirm-text">
          <strong>{t("move.to", { number: String(issue.number) })}</strong>
        </span>
        <Menu
          align="start"
          width={280}
          trigger={(p) => (
            <button type="button" className="btn move-select" data-variant="default" data-size="small" disabled={!apps} {...p}>
              {to ? (
                <>
                  <AppIcon src={to.icon_url} size={16} />
                  <span className="move-select-name">{to.name}</span>
                </>
              ) : (
                <span className="move-select-name">{apps ? (targets.length ? t("move.choose") : t("move.none")) : t("common.loading")}</span>
              )}
              <ChevronDownIcon size={12} />
            </button>
          )}
        >
          {(close) =>
            targets.map((a) => (
              <MenuItem
                key={a.id}
                checked={to?.id === a.id}
                description={appLabel(a.slug)}
                onSelect={() => {
                  setTo(a)
                  close()
                }}
              >
                {a.name}
              </MenuItem>
            ))
          }
        </Menu>
      </div>
      <p className="report-confirm-text move-note">
        {t("move.note")}
      </p>
      <div className="report-confirm-actions">
        <Button size="small" variant="invisible" onClick={onCancel} disabled={busy}>
          {t("common.cancel")}
        </Button>
        <Button size="small" variant="primary" onClick={move} disabled={!to || busy}>
          {busy ? t("move.moving") : t("move.button")}
        </Button>
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}
