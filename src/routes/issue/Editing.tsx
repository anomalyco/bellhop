import { useState, type FormEvent } from "react"
import type { AppDetail, Issue } from "../../../shared/api"
import { api, errorMessage } from "../../lib/api"
import { storeIssue } from "../../lib/issues"
import { Editor } from "../../ui/Editor"
import { Button } from "../../ui/primitives"

/** Inline title editing for members and the author. */
export function TitleForm({ app, issue, onDone }: { app: AppDetail; issue: Issue; onDone: () => void }) {
  const [title, setTitle] = useState(issue.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    const next = title.trim()
    if (!next || next === issue.title) return onDone()
    setSaving(true)
    setError(null)
    try {
      storeIssue(app.slug, await api.patchIssue(app.slug, issue.number, { title: next }))
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="issue-title-form" onSubmit={save}>
      <div className="input" data-size="large" style={{ flex: 1 }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title" autoFocus maxLength={256} />
      </div>
      <Button type="submit" disabled={saving}>
        Save
      </Button>
      <Button variant="invisible" onClick={onDone}>
        Cancel
      </Button>
      {error && <p className="field-error">{error}</p>}
    </form>
  )
}

/** Inline description editing for members and the author. */
export function BodyForm({ app, issue, onDone }: { app: AppDetail; issue: Issue; onDone: () => void }) {
  const [body, setBody] = useState(issue.body)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (busy) return
    setSaving(true)
    setError(null)
    try {
      storeIssue(app.slug, await api.patchIssue(app.slug, issue.number, { body }))
      onDone()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="msg-edit">
      <Editor
        slug={app.slug}
        value={body}
        onChange={setBody}
        member={!!app.role}
        onAttachment={() => {}}
        onBusyChange={setBusy}
        onSubmit={save}
        autoFocus
        label="Description"
        actions={
          <>
            <Button variant="invisible" onClick={onDone}>
              Cancel
            </Button>
            <Button variant="primary" onClick={save} disabled={saving || busy}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </>
        }
      />
      {error && <p className="field-error">{error}</p>}
    </div>
  )
}
