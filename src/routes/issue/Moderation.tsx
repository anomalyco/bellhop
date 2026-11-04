import { useEffect, useState, type ReactNode } from "react"
import { useLocation } from "wouter"
import type { Actor, AppDetail, Comment, Issue, ModerationReason, Revision } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { load, useResource } from "../../lib/cache"
import { ensureHuman } from "../../lib/human"
import { removeComment, replaceComment } from "../../lib/issues"
import { appPath, isAbsolute } from "../../lib/site"
import { Time } from "../../lib/time"
import { ActorAvatar, ActorName, actorName } from "../../ui/Actor"
import { Editor } from "../../ui/Editor"
import { CommentIcon, EyeOffIcon, KebabIcon, LockIcon, PinIcon, ThumbIcon } from "../../ui/icons"
import { Markdown } from "../../ui/Markdown"
import { Menu, MenuHeader, MenuItem } from "../../ui/Menu"
import { Button } from "../../ui/primitives"
import { Page } from "../../ui/Shell"
import { TierPicker, canHaveTier } from "../../ui/tiers/TierPicker"
import { AppLink, SiteLink } from "../../ui/SiteLink"
import "../../styles/moderation.css"

export const reasons: { value: ModerationReason; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "abuse", label: "Abuse" },
  { value: "off_topic", label: "Off topic" },
]
export const reasonText: Record<ModerationReason, string> = { spam: "spam", abuse: "abuse", off_topic: "off topic" }

/** On the team: an account with a role here, or an agent. The team can't be blocked. */
export const onTeam = (a: Actor) => a.type === "agent" || (a.type === "member" && !!a.role)

/** "edited" beside a time; opens the earlier versions, newest first (the old text as markdown, title changes for issues). */
export function EditedMarker({ slug, number, commentId }: { slug: string; number: number; commentId?: string }) {
  return (
    <Menu
      align="start"
      width={440}
      trigger={(p) => (
        <button type="button" className="edited-marker" aria-label="Edited: show earlier versions" {...p}>
          edited
        </button>
      )}
    >
      {() => <History slug={slug} number={number} commentId={commentId} />}
    </Menu>
  )
}

function History({ slug, number, commentId }: { slug: string; number: number; commentId?: string }) {
  const { data, error } = useResource<Revision[]>(
    keys.history(slug, number, commentId),
    () => (commentId ? api.commentHistory(slug, number, commentId) : api.issueHistory(slug, number)),
    1_000,
  )
  return (
    <div className="history">
      <MenuHeader>
        <strong>Earlier versions</strong>
        <span className="menu-item-description">Newest first. The current text is on the page.</span>
      </MenuHeader>
      <div className="history-scroll">
        {!data && !error && <div className="history-empty">Loading…</div>}
        {!!error && !data && <div className="history-empty">{errorMessage(error)}</div>}
        {data?.length === 0 && <div className="history-empty">No earlier versions.</div>}
        {data?.map((rev, i) => {
          const older = data[i + 1]
          const titleChanged = rev.title !== null && (!older || older.title !== rev.title)
          return (
            <article key={rev.id} className="history-item">
              <header className="history-head">
                <ActorAvatar actor={rev.actor} size={16} />
                <ActorName actor={rev.actor} badge={false} />
                <span className="history-time">
                  <Time iso={rev.created_at} />
                </span>
              </header>
              {titleChanged && <p className="history-title">{rev.title}</p>}
              <div className="history-body">
                {rev.body.trim() ? <Markdown source={rev.body} slug={slug} /> : <p className="muted-text">No description</p>}
              </div>
            </article>
          )
        })}
      </div>
    </div>
  )
}

/** The lock and eye markers under an issue's title, each with who can see it. */
export function IssueFlags({ issue }: { issue: Issue }) {
  if (!issue.private && !issue.hidden && !issue.locked && !issue.pinned) return null
  return (
    <div className="report-flags">
      {issue.pinned && (
        <p className="flag-line">
          <span className="flag">
            <PinIcon size={12} />
            Pinned
          </span>
          <span className="flag-text">Shown at the top of the issue list.</span>
        </p>
      )}
      {issue.locked && (
        <p className="flag-line">
          <span className="flag">
            <CommentIcon size={12} />
            Locked
          </span>
          <span className="flag-text">Only the team can reply. Anyone can still say "Me too".</span>
        </p>
      )}
      {issue.private && (
        <p className="flag-line">
          <span className="flag">
            <LockIcon size={12} />
            Private
          </span>
          <span className="flag-text">Only the team and {issue.viewer_is_author ? "you" : "the reporter"} can see this issue.</span>
        </p>
      )}
      {issue.hidden && (
        <p className="flag-line">
          <span className="flag" data-tone="hidden">
            <EyeOffIcon size={12} />
            Hidden · {reasonText[issue.hidden.reason]}
          </span>
          <span className="flag-text">
            Only the team can see it. Hidden by {actorName(issue.hidden.by)} <Time iso={issue.hidden.at} />.
          </span>
        </p>
      )}
    </div>
  )
}

/** For people outside the team: a hidden comment as one quiet line, with nothing of what it said. */
export function HiddenLine({ reason }: { reason: ModerationReason }) {
  return (
    <div className="event hidden-line">
      <span className="event-icon">
        <EyeOffIcon size={14} />
      </span>
      <span className="event-text">Hidden by a moderator · {reasonText[reason]}</span>
    </div>
  )
}

export interface CommentContext {
  app: AppDetail
  issue: Issue
  /** On the team (any role): may delete, hide and block. */
  member: boolean
  /** The viewer as an actor, to keep "Block" off their own comments. */
  viewerId: string | null
  /** Signed in (accounts skip the guest human check). */
  signedIn: boolean
}

type Mode = "edit" | "delete" | "block" | "tier" | null

/**
 * One comment in a group: its body (collapsed behind a marker when hidden, for the team), "edited", and the "…"
 * menu: edit and delete for the author; delete, hide or unhide, and block for the team. Confirms are inline.
 */
export function CommentBody({ ctx, comment, children }: { ctx: CommentContext; comment: Comment; children: ReactNode }) {
  const { app, issue, member } = ctx
  const slug = app.slug
  const [mode, setMode] = useState<Mode>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [hideAll, setHideAll] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [uploading, setUploading] = useState(false)
  const author = comment.author
  const mine = !!comment.viewer_is_author
  const canBlock = member && !onTeam(author) && author.id !== ctx.viewerId
  const hasMenu = mine || member

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      await fn()
      setMode(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const store = (c: Comment) => replaceComment(slug, issue.id, c)

  const menu = hasMenu && mode !== "edit" && (
    <div className="msg-menu">
      <Menu
        align="end"
        width={240}
        trigger={(p) => <Button iconOnly size="small" variant="ghost-muted" aria-label={`Actions for ${actorName(author)}'s comment`} icon={<KebabIcon />} {...p} />}
      >
        {(close) => {
          const pick = (fn: () => void) => () => {
            close()
            fn()
          }
          return (
            <>
              {mine && !comment.hidden && (
                <MenuItem
                  onSelect={pick(() => {
                    setDraft(comment.body)
                    setError(null)
                    setMode("edit")
                  })}
                >
                  Edit
                </MenuItem>
              )}
              {member &&
                (comment.hidden ? (
                  <MenuItem onSelect={pick(() => act(async () => store(await api.unhideComment(slug, issue.number, comment.id))))}>Unhide</MenuItem>
                ) : (
                  reasons.map((r) => (
                    <MenuItem key={r.value} onSelect={pick(() => act(async () => store(await api.hideComment(slug, issue.number, comment.id, r.value))))}>
                      Hide as {r.label.toLowerCase()}
                    </MenuItem>
                  ))
                ))}
              {(mine || member) && (
                <MenuItem danger onSelect={pick(() => setMode("delete"))}>
                  Delete
                </MenuItem>
              )}
              {member && canHaveTier(author) && (
                <MenuItem description="VIP, Pro… only the team sees it" onSelect={pick(() => setMode("tier"))}>
                  Set tier…
                </MenuItem>
              )}
              {canBlock && (
                <MenuItem
                  danger
                  description="They can't post or upload here any more"
                  onSelect={pick(() => {
                    setHideAll(false)
                    setMode("block")
                  })}
                >
                  Block {actorName(author)}
                </MenuItem>
              )}
            </>
          )
        }}
      </Menu>
    </div>
  )

  const save = () =>
    act(async () => {
      if (!draft.trim() || uploading) return
      await ensureHuman(member)
      store(await api.patchComment(slug, issue.number, comment.id, draft))
    })

  return (
    <div className="msg" data-menu={(hasMenu && mode !== "edit") || undefined} data-hidden={comment.hidden ? "" : undefined}>
      {menu}
      {mode === "edit" ? (
        <div className="msg-edit">
          <Editor
            slug={slug}
            value={draft}
            onChange={setDraft}
            member={member}
            mentions={member}
            onAttachment={() => {}}
            onBusyChange={setUploading}
            onSubmit={() => void save()}
            autoFocus
            label="Edit comment"
            actions={
              <>
                <Button variant="invisible" onClick={() => setMode(null)} disabled={busy}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={() => void save()} disabled={busy || uploading || !draft.trim()}>
                  {busy ? "Saving…" : "Save"}
                </Button>
              </>
            }
          />
        </div>
      ) : comment.hidden ? (
        <>
          <p className="msg-hidden">
            <EyeOffIcon size={12} />
            <span>Hidden · {reasonText[comment.hidden.reason]}</span>
            <button type="button" className="link-button msg-hidden-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? "Collapse" : "Show"}
            </button>
          </p>
          {expanded && <div className="msg-hidden-body">{children}</div>}
        </>
      ) : (
        children
      )}
      {mode !== "edit" && (!comment.hidden || expanded) && (comment.edited_at || !mine || (comment.helpful ?? 0) > 0) && (
        <div className="msg-meta">
          {!mine ? (
            <Helpful ctx={ctx} comment={comment} onError={setError} />
          ) : (
            (comment.helpful ?? 0) > 0 && (
              <span className="helpful-count">
                <ThumbIcon size={12} />
                {comment.helpful} found this helpful
              </span>
            )
          )}
          {comment.edited_at && <EditedMarker slug={slug} number={issue.number} commentId={comment.id} />}
        </div>
      )}
      {mode === "delete" && (
        <div className="msg-confirm">
          <span className="msg-confirm-text">{mine ? "Delete your comment?" : `Delete ${actorName(author)}'s comment?`} This can't be undone.</span>
          <Button size="small" variant="invisible" onClick={() => setMode(null)} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={busy}
            onClick={() =>
              act(async () => {
                await api.deleteComment(slug, issue.number, comment.id)
                removeComment(slug, issue.id, comment.id)
              })
            }
          >
            Delete
          </Button>
        </div>
      )}
      {mode === "tier" && (
        <TierPicker
          slug={slug}
          actor={author}
          onDone={() => setMode(null)}
          onChanged={() => void load(keys.issue(slug, issue.number), () => api.issue(slug, issue.number)).catch(() => {})}
        />
      )}
      {mode === "block" && (
        <div className="msg-confirm msg-confirm-block">
          <span className="msg-confirm-text">Block {actorName(author)}? They won't be able to post, edit or upload here.</span>
          <label className="checkbox msg-confirm-check">
            <input type="checkbox" checked={hideAll} onChange={(e) => setHideAll(e.target.checked)} />
            Also hide everything they wrote here
          </label>
          <span className="msg-confirm-actions">
            <Button size="small" variant="invisible" onClick={() => setMode(null)} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="danger"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await api.block(slug, author.id, hideAll)
                  // Hiding their posts changes comments across the page; take the server's view.
                  if (hideAll) await load(keys.issue(slug, issue.number), () => api.issue(slug, issue.number))
                  setNote(`Blocked ${actorName(author)}. Unblock them in Settings → Blocked.`)
                })
              }
            >
              Block
            </Button>
          </span>
        </div>
      )}
      {error && <p className="field-error">{error}</p>}
      {note && <p className="msg-note">{note}</p>}
    </div>
  )
}

/** In place of an issue that was deleted (410, or deleted while open). */
export function DeletedIssue({ slug, number }: { slug: string; number: number }) {
  return (
    <Page narrow>
      <div className="blank deleted">
        <h1 className="blank-title">This issue was deleted</h1>
        <p className="muted-text">#{number} was removed by the team, along with its comments and files.</p>
        <AppLink slug={slug} href={appPath(slug)} className="btn">
          Back to issues
        </AppLink>
      </div>
    </Page>
  )
}

/** In place of an issue that moved to another workspace: straight there (an old link), or an offer (moved while open). */
export function MovedIssue({ number, to, redirect }: { number: number; to: { slug: string; number: number }; redirect?: boolean }) {
  const [, navigate] = useLocation()
  const href = appPath(to.slug, `/issues/${to.number}`)
  useEffect(() => {
    if (!redirect) return
    if (isAbsolute(href)) window.location.replace(href)
    else navigate(href, { replace: true })
  }, [redirect, href, navigate])
  return (
    <Page narrow>
      <div className="blank moved">
        <h1 className="blank-title">This issue moved</h1>
        <p className="muted-text">
          #{number} is now <span className="mono">{to.slug}</span> #{to.number}
          {redirect ? ". Taking you there…" : ", in another workspace."}
        </p>
        <SiteLink href={href} className="btn" data-variant="primary">
          Go to #{to.number}
        </SiteLink>
      </div>
    </Page>
  )
}

/** "This helped" on someone else's comment: a quiet toggle with its count (guests pass the human check first). */
function Helpful({ ctx, comment, onError }: { ctx: CommentContext; comment: Comment; onError: (e: string | null) => void }) {
  const { app, issue } = ctx
  const on = !!comment.viewer_helpful
  const count = comment.helpful ?? 0
  const toggle = async () => {
    onError(null)
    const next = !on
    replaceComment(app.slug, issue.id, { ...comment, viewer_helpful: next, helpful: Math.max(0, count + (next ? 1 : -1)) })
    try {
      await ensureHuman(ctx.signedIn)
      const r = await api.helpful(app.slug, issue.number, comment.id, next)
      replaceComment(app.slug, issue.id, { ...comment, ...r })
    } catch (e) {
      replaceComment(app.slug, issue.id, comment)
      onError(errorMessage(e))
    }
  }
  return (
    <button type="button" className="helpful" aria-pressed={on} onClick={toggle} title={on ? "You found this helpful" : "Mark as helpful"}>
      <ThumbIcon size={12} />
      This helped{count > 0 && <span className="mono-num helpful-n">{count}</span>}
    </button>
  )
}
