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
import { tKey, tr, useT } from "../../i18n/core"
import { sentenceGap } from "../../i18n"

export const reasons: { value: ModerationReason; readonly label: string; readonly hideAs: string }[] = (["spam", "abuse", "off_topic"] as const).map((value) => ({
  value,
  get label() {
    return tKey(`reason.${value}`)
  },
  get hideAs() {
    return tKey(`hideAs.${value}`)
  },
}))
/** A reason inside a sentence ("Hidden · spam"), in the active language. */
export const reasonText = {
  get spam() {
    return tKey("reasonText.spam")
  },
  get abuse() {
    return tKey("reasonText.abuse")
  },
  get off_topic() {
    return tKey("reasonText.off_topic")
  },
} as Record<ModerationReason, string>

/** On the team: an account with a role here, or an agent. The team can't be blocked. */
export const onTeam = (a: Actor) => a.type === "agent" || (a.type === "member" && !!a.role)

/** "edited" beside a time; opens the earlier versions, newest first (the old text as markdown, title changes for issues). */
export function EditedMarker({ slug, number, commentId }: { slug: string; number: number; commentId?: string }) {
  const t = useT()
  return (
    <Menu
      align="start"
      width={440}
      trigger={(p) => (
        <button type="button" className="edited-marker" aria-label={t("edited.aria")} {...p}>
          {t("edited.marker")}
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
  const t = useT()
  return (
    <div className="history">
      <MenuHeader>
        <strong>{t("history.title")}</strong>
        <span className="menu-item-description">{t("history.subtitle")}</span>
      </MenuHeader>
      <div className="history-scroll">
        {!data && !error && <div className="history-empty">{t("common.loading")}</div>}
        {!!error && !data && <div className="history-empty">{errorMessage(error)}</div>}
        {data?.length === 0 && <div className="history-empty">{t("history.none")}</div>}
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
                {rev.body.trim() ? <Markdown source={rev.body} slug={slug} /> : <p className="muted-text">{t("history.noDescription")}</p>}
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
  const t = useT()
  if (!issue.private && !issue.hidden && !issue.locked && !issue.pinned) return null
  return (
    <div className="report-flags">
      {issue.pinned && (
        <p className="flag-line">
          <span className="flag">
            <PinIcon size={12} />
            {t("flag.pinned")}
          </span>
          <span className="flag-text">{t("flag.pinnedText")}</span>
        </p>
      )}
      {issue.locked && (
        <p className="flag-line">
          <span className="flag">
            <CommentIcon size={12} />
            {t("flag.locked")}
          </span>
          <span className="flag-text">{t("flag.lockedText")}</span>
        </p>
      )}
      {issue.private && (
        <p className="flag-line">
          <span className="flag">
            <LockIcon size={12} />
            {t("flag.private")}
          </span>
          <span className="flag-text">{issue.viewer_is_author ? t("flag.privateYou") : t("flag.privateReporter")}</span>
        </p>
      )}
      {issue.hidden && (
        <p className="flag-line">
          <span className="flag" data-tone="hidden">
            <EyeOffIcon size={12} />
            {t("flag.hidden", { reason: reasonText[issue.hidden.reason] })}
          </span>
          <span className="flag-text">
            {t("flag.hiddenText")}
            {sentenceGap()}
            {issue.hidden.by
              ? tr("flag.hiddenBy", { name: actorName(issue.hidden.by), time: <Time iso={issue.hidden.at} /> })
              : tr("flag.hiddenAt", { time: <Time iso={issue.hidden.at} /> })}
          </span>
        </p>
      )}
    </div>
  )
}

/** For people outside the team: a hidden comment as one quiet line, with nothing of what it said. */
export function HiddenLine({ reason }: { reason: ModerationReason }) {
  const t = useT()
  return (
    <div className="event hidden-line">
      <span className="event-icon">
        <EyeOffIcon size={14} />
      </span>
      <span className="event-text">{t("hiddenLine", { reason: reasonText[reason] })}</span>
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
  const t = useT()
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
        trigger={(p) => <Button iconOnly size="small" variant="ghost-muted" aria-label={t("comment.actions", { name: actorName(author) })} icon={<KebabIcon />} {...p} />}
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
                  {t("common.edit")}
                </MenuItem>
              )}
              {member &&
                (comment.hidden ? (
                  <MenuItem onSelect={pick(() => act(async () => store(await api.unhideComment(slug, issue.number, comment.id))))}>{t("comment.unhide")}</MenuItem>
                ) : (
                  reasons.map((r) => (
                    <MenuItem key={r.value} onSelect={pick(() => act(async () => store(await api.hideComment(slug, issue.number, comment.id, r.value))))}>
                      {r.hideAs}
                    </MenuItem>
                  ))
                ))}
              {(mine || member) && (
                <MenuItem danger onSelect={pick(() => setMode("delete"))}>
                  {t("common.delete")}
                </MenuItem>
              )}
              {member && canHaveTier(author) && (
                <MenuItem description={t("comment.setTierText")} onSelect={pick(() => setMode("tier"))}>
                  {t("comment.setTier")}
                </MenuItem>
              )}
              {canBlock && (
                <MenuItem
                  danger
                  description={t("comment.blockText")}
                  onSelect={pick(() => {
                    setHideAll(false)
                    setMode("block")
                  })}
                >
                  {t("comment.block", { name: actorName(author) })}
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
            label={t("comment.editLabel")}
            actions={
              <>
                <Button variant="invisible" onClick={() => setMode(null)} disabled={busy}>
                  {t("common.cancel")}
                </Button>
                <Button variant="primary" onClick={() => void save()} disabled={busy || uploading || !draft.trim()}>
                  {busy ? t("common.saving") : t("common.save")}
                </Button>
              </>
            }
          />
        </div>
      ) : comment.hidden ? (
        <>
          <p className="msg-hidden">
            <EyeOffIcon size={12} />
            <span>{t("comment.hidden", { reason: reasonText[comment.hidden.reason] })}</span>
            <button type="button" className="link-button msg-hidden-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
              {expanded ? t("comment.collapse") : t("comment.show")}
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
                {t("comment.foundHelpful", { count: comment.helpful ?? 0 })}
              </span>
            )
          )}
          {comment.edited_at && <EditedMarker slug={slug} number={issue.number} commentId={comment.id} />}
        </div>
      )}
      {mode === "delete" && (
        <div className="msg-confirm">
          <span className="msg-confirm-text">{mine ? t("comment.deleteYours") : t("comment.deleteTheirs", { name: actorName(author) })}</span>
          <Button size="small" variant="invisible" onClick={() => setMode(null)} disabled={busy}>
            {t("common.cancel")}
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
            {t("common.delete")}
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
          <span className="msg-confirm-text">{t("comment.blockConfirm", { name: actorName(author) })}</span>
          <label className="checkbox msg-confirm-check">
            <input type="checkbox" checked={hideAll} onChange={(e) => setHideAll(e.target.checked)} />
            {t("comment.blockHideAll")}
          </label>
          <span className="msg-confirm-actions">
            <Button size="small" variant="invisible" onClick={() => setMode(null)} disabled={busy}>
              {t("common.cancel")}
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
                  setNote(t("comment.blocked", { name: actorName(author) }))
                })
              }
            >
              {t("comment.blockButton")}
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
  const t = useT()
  return (
    <Page narrow>
      <div className="blank deleted">
        <h1 className="blank-title">{t("deleted.title")}</h1>
        <p className="muted-text">{t("deleted.text", { number: String(number) })}</p>
        <AppLink slug={slug} href={appPath(slug)} className="btn">
          {t("deleted.back")}
        </AppLink>
      </div>
    </Page>
  )
}

/** In place of an issue that moved to another workspace: straight there (an old link), or an offer (moved while open). */
export function MovedIssue({ number, to, redirect }: { number: number; to: { slug: string; number: number }; redirect?: boolean }) {
  const t = useT()
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
        <h1 className="blank-title">{t("moved.title")}</h1>
        <p className="muted-text">
          {tr(redirect ? "moved.textRedirect" : "moved.text", {
            number: String(number),
            place: (
              <>
                <span className="mono">{to.slug}</span> #{to.number}
              </>
            ),
          })}
        </p>
        <SiteLink href={href} className="btn" data-variant="primary">
          {t("moved.go", { number: String(to.number) })}
        </SiteLink>
      </div>
    </Page>
  )
}

/** "This helped" on someone else's comment: a quiet toggle with its count (guests pass the human check first). */
function Helpful({ ctx, comment, onError }: { ctx: CommentContext; comment: Comment; onError: (e: string | null) => void }) {
  const t = useT()
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
    <button type="button" className="helpful" aria-pressed={on} onClick={toggle} title={on ? t("comment.helpedOn") : t("comment.markHelpful")}>
      <ThumbIcon size={12} />
      {t("comment.helped")}
      {count > 0 && <span className="mono-num helpful-n">{count}</span>}
    </button>
  )
}
