import { useState, type RefObject } from "react"
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

/** The issue page: the report and thread on the left with the pinned composer under them, the sidebar on the right.
 *  Phones get one column with property pills under the title and the sidebar's information folded into "Details". */
export function IssueView({ model, nameField }: { model: IssueModel; nameField: RefObject<HTMLInputElement | null> }) {
  const { app, issue, actionError } = model
  const authorTier = issue.author.type !== "agent" ? (issue.author.tier ?? null) : null
  const ctx: CommentContext = { app, issue, member: model.member, viewerId: model.viewer?.id ?? null, signedIn: !!model.me?.user }
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
                  <EventBurst key={b.key} slug={app.slug} events={b.events} authorTier={authorTier} />
                ) : (
                  b.events.map((e) => <EventLine key={e.id} slug={app.slug} event={e} authorTier={authorTier} />)
                )
              ) : (
                <MessageGroup key={b.key} slug={app.slug} author={b.author} byAuthor={b.byAuthor} messages={b.messages} ctx={ctx} internal={b.internal} />
              ),
            )}
            <TypingLine activity={issue.activity} />
          </div>
          {actionError && (
            <p className="flash" data-tone="danger">
              {actionError}
            </p>
          )}
          {issue.locked && !model.member ? <LockedComposer /> : <Composer model={model} nameField={nameField} />}
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
  const [moving, setMoving] = useState(false)
  const [menuError, setMenuError] = useState<string | null>(null)
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
            <MeToo model={model} />
            <AppLink slug={app.slug} href={appPath(app.slug, "/new")} className="btn report-new" data-variant="default" data-size="small">
              New issue
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
            <Markdown source={issue.body} slug={app.slug} mentions={issue.mentions} />
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
      trigger={(p) => <Button iconOnly size="small" variant="invisible" aria-label="Issue actions" icon={<KebabIcon />} {...p} />}
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
                  description={issue.pinned ? "Off the top of the list" : "At the top of the list; up to three"}
                  onSelect={pick(() => model.onPin(!issue.pinned))}
                >
                  {issue.pinned ? "Unpin" : "Pin to the list"}
                </MenuItem>
                <MenuItem
                  description={issue.locked ? "Anyone who can see it can reply again" : "Only the team can reply; votes still work"}
                  onSelect={pick(() => model.onLock(!issue.locked))}
                >
                  {issue.locked ? "Unlock conversation" : "Lock conversation"}
                </MenuItem>
              </>
            )}
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
            {triage && (
              <MenuItem description="To another workspace you're on, with a new number" onSelect={pick(onMove)}>
                Move to workspace…
              </MenuItem>
            )}
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

/** "Me too": everyone can add theirs (guests pass the human check), with the count. */
function MeToo({ model }: { model: IssueModel }) {
  const { issue } = model
  const on = !!issue.viewer_voted
  const votes = issue.votes ?? 0
  return (
    <Button
      size="small"
      className="btn me-too"
      aria-pressed={on}
      data-active={on || undefined}
      title={on ? "You have this too. Click to take it back." : "You have this too"}
      icon={<ThumbIcon size={14} />}
      onClick={() => void model.onVote(!on)}
    >
      Me too
      {votes > 0 && <span className="mono-num me-too-n">{votes}</span>}
    </Button>
  )
}

/** Moving to another workspace: pick where (workspaces you're a member of), see what carries over, then move. */
function MovePanel({ model, onCancel }: { model: IssueModel; onCancel: () => void }) {
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
          <strong>Move #{issue.number} to</strong>
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
                <span className="move-select-name">{apps ? (targets.length ? "Choose a workspace" : "No other workspaces") : "Loading…"}</span>
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
        It gets a new number there. Labels carry over by name, the assignee if they're on that team; relations don't. The old link
        will point to the new place.
      </p>
      <div className="report-confirm-actions">
        <Button size="small" variant="invisible" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="small" variant="primary" onClick={move} disabled={!to || busy}>
          {busy ? "Moving…" : "Move issue"}
        </Button>
      </div>
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}
