import { useState, type RefObject } from "react"
import { Link } from "wouter"
import { stateText, visibleState } from "../../lib/issues"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { ActorAvatar, ActorName } from "../../ui/Actor"
import { ChevronDownIcon, LinkIcon, PersonIcon, TagIcon } from "../../ui/icons"
import { Markdown } from "../../ui/Markdown"
import { Menu } from "../../ui/Menu"
import { Button, Label, StateIcon } from "../../ui/primitives"
import { Page } from "../../ui/Shell"
import { Composer } from "./Composer"
import { BodyForm, TitleForm } from "./Editing"
import { allAttachments, blocks, entries, type IssueModel } from "./model"
import { AssignMenu, LabelMenu, RelationForm, RelationList, StatusMenu, SystemInfoList, statusOptions } from "./Properties"
import { AttachmentList, EventBurst, EventLine, MessageGroup, TypingLine } from "./Timeline"

/** The issue page: the report on the page itself, its properties as pills, then the thread and the pinned composer. */
export function IssueView({ model, nameField }: { model: IssueModel; nameField: RefObject<HTMLInputElement | null> }) {
  const { app, issue, actionError } = model
  return (
    <Page>
      <div className="issue">
        <Report model={model} />
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
    </Page>
  )
}

function Report({ model }: { model: IssueModel }) {
  const { app, issue, member, canEdit, viewers, actions } = model
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingBody, setEditingBody] = useState(false)
  const [sysinfo, setSysinfo] = useState(false)
  const files = allAttachments(issue)
  const state = visibleState(issue)
  const showSysinfo = member && !!issue.system_info && issue.system_info !== "hidden"

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
            <Link href={appPath(app.slug, "/new")} className="btn report-new" data-variant="default" data-size="small">
              New issue
            </Link>
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

      <div className="report-body">
        {editingBody ? (
          <BodyForm app={app} issue={issue} onDone={() => setEditingBody(false)} />
        ) : (
          <>
            <Markdown source={issue.body} slug={app.slug} />
            {canEdit && (
              <button type="button" className="report-edit-body" onClick={() => setEditingBody(true)}>
                Edit description
              </button>
            )}
          </>
        )}
      </div>

      {files.length > 0 && <AttachmentList attachments={files} />}

      <div className="report-props">
        {member && issue.status !== "closed" ? (
          <StatusMenu
            issue={issue}
            onSet={actions.setStatus}
            trigger={(p) => (
              <button type="button" className="prop" title="Status" {...p}>
                <StateIcon state={state} size={14} />
                {statusOptions.find((o) => o.status === issue.status)?.label}
                <ChevronDownIcon size={12} />
              </button>
            )}
          />
        ) : (
          <span className="prop" data-static title="Status">
            <StateIcon state={state} size={14} />
            {stateText(issue) ?? statusText[state]}
          </span>
        )}

        {member ? (
          <AssignMenu
            app={app}
            issue={issue}
            onAssign={actions.assign}
            trigger={(p) => (
              <button type="button" className="prop" title="Assignee" {...p}>
                <Assignee model={model} />
              </button>
            )}
          />
        ) : (
          issue.assignee && (
            <span className="prop" data-static title="Assignee">
              <Assignee model={model} />
            </span>
          )
        )}

        {member ? (
          <LabelMenu
            app={app}
            selected={issue.labels.map((l) => l.id)}
            onToggle={actions.toggleLabel}
            trigger={(p) => (
              <button type="button" className="prop" data-labels={issue.labels.length || undefined} title="Labels" {...p}>
                <Labels model={model} />
              </button>
            )}
          />
        ) : (
          issue.labels.length > 0 && (
            <span className="prop" data-static data-labels title="Labels">
              <Labels model={model} />
            </span>
          )
        )}

        {(member || issue.relations.length > 0) && (
          <Menu
            width={300}
            trigger={(p) => (
              <button type="button" className="prop" title="Relationships" {...p}>
                <LinkIcon size={14} />
                {issue.relations.length === 0 ? "Link an issue" : issue.relations.length === 1 ? "1 relation" : `${issue.relations.length} relations`}
              </button>
            )}
          >
            {(close) => (
              <div className="prop-relations">
                {issue.relations.length > 0 && <RelationList app={app} issue={issue} onRemove={member ? actions.removeRelation : undefined} />}
                {member && <RelationForm onAdd={actions.addRelation} onDone={close} />}
              </div>
            )}
          </Menu>
        )}

        {showSysinfo && (
          <button type="button" className="report-sysinfo" aria-expanded={sysinfo} onClick={() => setSysinfo(!sysinfo)}>
            System info
            <ChevronDownIcon size={12} />
          </button>
        )}
      </div>
      {showSysinfo && sysinfo && <SystemInfoList info={issue.system_info!} />}
    </header>
  )
}

const statusText = { open: "Open", in_progress: "In progress", waiting: "Waiting on reporter", closed: "Closed", not_planned: "Not planned" }

function Assignee({ model }: { model: IssueModel }) {
  const a = model.issue.assignee
  if (!a)
    return (
      <>
        <PersonIcon size={14} />
        Unassigned
      </>
    )
  return (
    <>
      <ActorAvatar actor={a} size={16} />
      <ActorName actor={a} />
    </>
  )
}

function Labels({ model }: { model: IssueModel }) {
  const labels = model.issue.labels
  if (!labels.length)
    return (
      <>
        <TagIcon size={14} />
        Add labels
      </>
    )
  return (
    <>
      {labels.map((l) => (
        <Label key={l.id} name={l.name} color={l.color} />
      ))}
    </>
  )
}
