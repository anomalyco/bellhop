import { useState } from "react"
import { Link } from "wouter"
import type { Activity, IssueEvent } from "../../../shared/api"
import { stateText, visibleState } from "../../lib/issues"
import { appPath } from "../../lib/site"
import { Time, useUntil } from "../../lib/time"
import { ActorAvatar, ActorName, actorName } from "../../ui/Actor"
import { ChevronDownIcon, LinkIcon, PersonIcon, TagIcon } from "../../ui/icons"
import { Markdown } from "../../ui/Markdown"
import { Menu } from "../../ui/Menu"
import { Button, Dots, Label, StateIcon } from "../../ui/primitives"
import { Page } from "../../ui/Shell"
import { Composer } from "./Composer"
import { BodyForm, TitleForm } from "./Editing"
import { allAttachments, blocks, entries, type IssueModel } from "./model"
import { AssignMenu, LabelMenu, RelationForm, RelationList, StatusMenu, SystemInfoList, statusOptions } from "./Sidebar"
import { AttachmentList, eventContent } from "./Timeline"
import "../../styles/issue-layouts.css"

/** Prototype B: the report as a card with its properties inline, then a tight thread without a sidebar. */
export function CardLayout({ model }: { model: IssueModel }) {
  const { app, issue, actionError } = model
  return (
    <Page>
      <div className="card-page">
        <ReportCard model={model} />
        <div className="cthread">
          {blocks(entries(model, false)).map((b) =>
            b.kind === "events" ? (
              b.events.length > 2 ? (
                <EventBurst key={b.key} slug={app.slug} events={b.events} />
              ) : (
                b.events.map((e) => <EventLine key={e.id} slug={app.slug} event={e} />)
              )
            ) : (
              <section key={b.key} className="cgroup" data-agent={b.author.type === "agent" || undefined}>
                <header className="cgroup-head">
                  <span className="cgroup-avatar" data-reporter={b.byAuthor || undefined} title={b.byAuthor ? `${actorName(b.author)} opened this issue` : undefined}>
                    <ActorAvatar actor={b.author} size={20} />
                  </span>
                  <ActorName actor={b.author} />
                  <span className="cgroup-time">
                    <Time iso={b.messages[0]!.createdAt} />
                  </span>
                </header>
                {b.messages.map((m) => {
                  const loose = m.attachments.filter((a) => !m.body.includes(a.url))
                  return (
                    <div key={m.key} className="cmsg" data-pending={m.note ? "" : undefined}>
                      <Markdown source={m.body} slug={app.slug} />
                      {loose.length > 0 && <AttachmentList attachments={loose} />}
                      {m.note && <div className="cmsg-note">{m.note}</div>}
                    </div>
                  )
                })}
              </section>
            ),
          )}
          <TypingLine activity={issue.activity} />
        </div>
        {actionError && (
          <p className="flash" data-tone="danger">
            {actionError}
          </p>
        )}
        <Composer app={app} issue={issue} onComment={model.onComment} onStatus={model.onStatus} onDuplicate={model.onDuplicate} />
      </div>
    </Page>
  )
}

function ReportCard({ model }: { model: IssueModel }) {
  const { app, issue, member, canEdit, viewers, actions } = model
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingBody, setEditingBody] = useState(false)
  const [sysinfo, setSysinfo] = useState(false)
  const files = allAttachments(issue)
  const loose = issue.attachments.filter((a) => !issue.body.includes(a.url))
  const state = visibleState(issue)
  const showSysinfo = member && issue.system_info && issue.system_info !== "hidden"

  return (
    <article className="report">
      {editingTitle ? (
        <TitleForm app={app} issue={issue} onDone={() => setEditingTitle(false)} />
      ) : (
        <div className="report-head">
          <h1 className="report-title">
            {issue.title} <span className="mono report-number">#{issue.number}</span>
          </h1>
          <div className="report-head-actions">
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
          <ActorName actor={issue.author} badge={false} /> opened this <Time iso={issue.created_at} />
          {viewers !== null && viewers > 0 && (
            <span className="report-viewers">
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
            {loose.length > 0 && <AttachmentList attachments={loose} />}
            {canEdit && (
              <button type="button" className="report-edit-body" onClick={() => setEditingBody(true)}>
                Edit description
              </button>
            )}
          </>
        )}
      </div>

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
            {stateText(issue)}
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
          <span className="prop" data-static title="Assignee">
            <Assignee model={model} />
          </span>
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
      </div>

      {(files.length > 0 || showSysinfo) && (
        <div className="report-foot">
          {files.length > 0 && <AttachmentList attachments={files} />}
          {showSysinfo && (
            <button type="button" className="report-sysinfo-toggle" aria-expanded={sysinfo} onClick={() => setSysinfo(!sysinfo)}>
              System info
              <ChevronDownIcon size={12} />
            </button>
          )}
        </div>
      )}
      {showSysinfo && sysinfo && (
        <div className="report-sysinfo">
          <SystemInfoList info={issue.system_info!} />
        </div>
      )}
    </article>
  )
}

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

function EventLine({ slug, event }: { slug: string; event: IssueEvent }) {
  const { icon, tone, body } = eventContent(slug, event)
  return (
    <div className="cevent" data-tone={tone}>
      <span className="cevent-icon">{icon}</span>
      <span className="cevent-text">
        <ActorName actor={event.actor} badge={false} /> {body} · <Time iso={event.created_at} />
      </span>
    </div>
  )
}

/** More than two events in a row fold into one line; who did them and when, expandable. */
function EventBurst({ slug, events }: { slug: string; events: IssueEvent[] }) {
  const [open, setOpen] = useState(false)
  const names = [...new Set(events.map((e) => actorName(e.actor)))]
  const last = events[events.length - 1]!
  return (
    <div className="cburst" data-open={open || undefined}>
      <button type="button" className="cburst-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="cburst-icons" aria-hidden="true">
          {events.slice(0, 3).map((e) => {
            const { icon, tone } = eventContent(slug, e)
            return (
              <span key={e.id} className="cevent-icon" data-tone={tone}>
                {icon}
              </span>
            )
          })}
        </span>
        <span className="cburst-text">
          {events.length} updates by {names.join(", ")} · <Time iso={last.created_at} />
        </span>
        <ChevronDownIcon size={12} />
      </button>
      {open && events.map((e) => <EventLine key={e.id} slug={slug} event={e} />)}
    </div>
  )
}

function TypingLine({ activity }: { activity: Activity | null }) {
  const live = useUntil(activity?.expires_at)
  if (!activity || !live) return null
  return (
    <div className="cgroup ctyping" aria-live="polite">
      <header className="cgroup-head">
        <span className="cgroup-avatar">
          <ActorAvatar actor={activity.actor} size={20} />
        </span>
        <ActorName actor={activity.actor} />
        <Dots />
        {activity.text && <span className="ctyping-text">{activity.text}</span>}
      </header>
    </div>
  )
}
