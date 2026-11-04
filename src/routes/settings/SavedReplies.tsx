import { useEffect, useRef, useState, type FormEvent } from "react"
import type { AppDetail, SavedReply } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { setData, useResource } from "../../lib/cache"
import { atLeast } from "../../lib/roles"
import { Time } from "../../lib/time"
import { actorName } from "../../ui/Actor"
import { PlusIcon } from "../../ui/icons"
import { Markdown, loadMarkdown } from "../../ui/Markdown"
import { Button } from "../../ui/primitives"
import { t, tr, tKey, useT } from "../../i18n/settings"
import { t as tc } from "../../i18n/core"
import "../../styles/insights.css"

const byName = (a: SavedReply, b: SavedReply) => a.name.localeCompare(b.name)

/**
 * Settings → Saved replies: answers the team (and agents) reuse, like "Needs logs". Everyone on the team reads them;
 * members and up write them. `{reporter}` becomes the reporter's name when one is inserted.
 */
export function SavedReplies({ app }: { app: AppDetail }) {
  useT()
  const canWrite = atLeast(app.role, "member")
  const key = keys.savedReplies(app.slug)
  const { data: list, error } = useResource<SavedReply[]>(key, () => api.savedReplies(app.slug), 5_000)
  const [editing, setEditing] = useState<string | "new" | null>(null)
  const replies = [...(list ?? [])].sort(byName)
  const store = (fn: (l: SavedReply[]) => SavedReply[]) => setData<SavedReply[]>(key, (l) => fn(l ?? []))

  return (
    <div>
      <div className="settings-heading">
        <h1>{tKey("section.saved-replies")}</h1>
        {canWrite && editing !== "new" && (
          <Button variant="primary" size="small" icon={<PlusIcon />} onClick={() => setEditing("new")}>
            {t("replies.new")}
          </Button>
        )}
      </div>
      <p className="settings-lede">{tr("replies.lede", { code: <code>{"{reporter}"}</code> })}</p>
      {!canWrite && <p className="settings-readonly">{t("replies.readOnly")}</p>}
      <section className="box">
        {editing === "new" && (
          <ReplyForm
            slug={app.slug}
            onDone={(r) => {
              if (r) store((l) => [...l, r])
              setEditing(null)
            }}
          />
        )}
        {!list && !error && <div className="box-row skeleton-row" />}
        {!!error && !list && <div className="box-row muted-text">{errorMessage(error)}</div>}
        {list?.length === 0 && editing !== "new" && <div className="box-empty">{t("replies.empty")}</div>}
        {replies.map((r) =>
          editing === r.id ? (
            <ReplyForm
              key={r.id}
              slug={app.slug}
              reply={r}
              onDone={(next) => {
                if (next) store((l) => l.map((x) => (x.id === next.id ? next : x)))
                setEditing(null)
              }}
            />
          ) : (
            <ReplyRow key={r.id} slug={app.slug} reply={r} canWrite={canWrite} onEdit={() => setEditing(r.id)} onDeleted={() => store((l) => l.filter((x) => x.id !== r.id))} />
          ),
        )}
      </section>
    </div>
  )
}

function ReplyRow({ slug, reply, canWrite, onEdit, onDeleted }: { slug: string; reply: SavedReply; canWrite: boolean; onEdit: () => void; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.deleteSavedReply(slug, reply.id)
      onDeleted()
    } catch (e) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  return (
    <div className="box-row settings-row reply-row">
      <div className="settings-row-main">
        <div className="reply-row-name">{reply.name}</div>
        <div className="reply-row-body">{reply.body}</div>
        <div className="issue-meta">
          {tr("replies.meta", { author: actorName(reply.created_by), time: <Time iso={reply.updated_at} /> })}
        </div>
        {error && <p className="field-error">{error}</p>}
      </div>
      {canWrite &&
        (confirming ? (
          <div className="agent-confirm-inline">
            <span className="agent-confirm-text">{t("replies.confirmDelete", { name: reply.name })}</span>
            <Button size="small" variant="invisible" onClick={() => setConfirming(false)} disabled={busy}>
              {tc("common.cancel")}
            </Button>
            <Button size="small" variant="danger" onClick={remove} disabled={busy}>
              {busy ? t("replies.deleting") : tc("common.delete")}
            </Button>
          </div>
        ) : (
          <div className="settings-row-actions">
            <Button size="small" variant="invisible" onClick={onEdit}>
              {tc("common.edit")}
            </Button>
            <Button size="small" variant="invisible" onClick={() => setConfirming(true)}>
              {tc("common.delete")}
            </Button>
          </div>
        ))}
    </div>
  )
}

function ReplyForm({ slug, reply, onDone }: { slug: string; reply?: SavedReply; onDone: (r: SavedReply | null) => void }) {
  const [name, setName] = useState(reply?.name ?? "")
  const [body, setBody] = useState(reply?.body ?? "")
  const [tab, setTab] = useState<"write" | "preview">("write")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    void loadMarkdown()
  }, [])

  const insertReporter = () => {
    const el = area.current
    const at = el ? el.selectionStart : body.length
    const end = el ? el.selectionEnd : body.length
    const next = body.slice(0, at) + "{reporter}" + body.slice(end)
    setBody(next)
    setTab("write")
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(at + 10, at + 10)
    })
  }

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !body.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const input = { name: name.trim(), body }
      onDone(reply ? await api.patchSavedReply(slug, reply.id, input) : await api.createSavedReply(slug, input))
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <form className="box-row reply-form" onSubmit={save}>
      <div className="field">
        <label className="field-label" htmlFor="reply-name">
          {t("field.name")}
        </label>
        <div className="input">
          <input id="reply-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("replies.namePlaceholder")} maxLength={80} required autoFocus autoComplete="off" />
        </div>
      </div>
      <div className="field">
        <div className="reply-tabs">
          <div className="segmented" role="radiogroup" aria-label={t("replies.body")}>
            <button type="button" role="radio" aria-checked={tab === "write"} aria-pressed={tab === "write"} onClick={() => setTab("write")}>
              {t("replies.write")}
            </button>
            <button type="button" role="radio" aria-checked={tab === "preview"} aria-pressed={tab === "preview"} onClick={() => setTab("preview")}>
              {t("replies.preview")}
            </button>
          </div>
          <Button size="small" variant="invisible" onClick={insertReporter}>
            {tr("replies.insert", { code: <code>{"{reporter}"}</code> })}
          </Button>
        </div>
        {tab === "write" ? (
          <textarea
            ref={area}
            id="reply-body"
            aria-label={t("replies.body")}
            className="textarea reply-body"
            rows={7}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t("replies.bodyPlaceholder", { reporter: "{reporter}" })}
            maxLength={10000}
          />
        ) : (
          <div className="reply-preview">
            {body.trim() ? <Markdown source={body.replaceAll("{reporter}", t("replies.previewName"))} slug={slug} /> : <p className="muted-text">{t("replies.nothing")}</p>}
          </div>
        )}
        <span className="reply-hint">
          {tr("replies.hint", { code: <code>{"{reporter}"}</code>, name: t("replies.previewName") })}
        </span>
      </div>
      {error && <p className="field-error">{error}</p>}
      <div className="form-actions">
        <Button variant="invisible" onClick={() => onDone(null)} disabled={busy}>
          {tc("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim() || !body.trim()}>
          {busy ? tc("common.saving") : reply ? tc("common.save") : t("replies.create")}
        </Button>
      </div>
    </form>
  )
}
