import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react"
import type { Actor, Issue } from "../../../shared/api"
import { stateText, visibleState } from "../../lib/issues"
import { appPath } from "../../lib/site"
import { Time } from "../../lib/time"
import { ActorAvatar, ActorName, TierBadge, actorName } from "../../ui/Actor"
import { TierPicker, canHaveTier } from "../../ui/tiers/TierPicker"
import { api, keys } from "../../lib/api"
import { load } from "../../lib/cache"
import { ChevronDownIcon, LinkIcon, PersonIcon, PlusIcon, SettingsIcon, TagIcon } from "../../ui/icons"
import { Menu } from "../../ui/Menu"
import { AiBadge, Button, Label, StateIcon } from "../../ui/primitives"
import { AppLink } from "../../ui/SiteLink"
import { allAttachments, type IssueModel } from "./model"
import { AssignMenu, LabelMenu, RelationForm, RelationList, StatusMenu, SystemInfoList, statusOptions } from "./Properties"
import { AttachmentList } from "./Timeline"

const statusText = { open: "Open", in_progress: "In progress", waiting: "Waiting on reporter", closed: "Closed", not_planned: "Not planned" }

/** The desktop sidebar: the editable properties, then who reported it, when, who's involved, files, system info and a link. */
export function IssueSidebar({ model }: { model: IssueModel }) {
  const ref = useRef<HTMLElement>(null)
  const sticky = useFits(ref)
  return (
    <aside ref={ref} className="issue-side" data-sticky={sticky || undefined}>
      <StatusSection model={model} />
      <AssigneeSection model={model} />
      <LabelsSection model={model} />
      <RelationsSection model={model} />
      <InfoSections model={model} />
    </aside>
  )
}

/** Phones: status, assignee and labels as small pills under the title, opening the same editors. */
export function MobileProps({ model }: { model: IssueModel }) {
  const { app, issue, member, actions } = model
  const state = visibleState(issue)
  return (
    <div className="mobile-props">
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
              <AssigneeValue issue={issue} />
            </button>
          )}
        />
      ) : (
        issue.assignee && (
          <span className="prop" data-static title="Assignee">
            <AssigneeValue issue={issue} />
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
              {issue.labels.length ? (
                issue.labels.map((l) => <Label key={l.id} name={l.name} color={l.color} />)
              ) : (
                <>
                  <TagIcon size={14} />
                  Add labels
                </>
              )}
            </button>
          )}
        />
      ) : (
        issue.labels.length > 0 && (
          <span className="prop" data-static data-labels title="Labels">
            {issue.labels.map((l) => (
              <Label key={l.id} name={l.name} color={l.color} />
            ))}
          </span>
        )
      )}
    </div>
  )
}

/** Phones: everything else from the sidebar, folded after the report so it's reachable before the thread. */
export function MobileDetails({ model }: { model: IssueModel }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="mobile-details" data-open={open || undefined}>
      <button type="button" className="mobile-details-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        Details
        <ChevronDownIcon size={14} />
      </button>
      {open && (
        <div className="mobile-details-body">
          <RelationsSection model={model} />
          <InfoSections model={model} />
        </div>
      )}
    </section>
  )
}

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="side-section">
      <div className="side-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

type TriggerProps = Parameters<Parameters<typeof Menu>[0]["trigger"]>[0]

const edit = (label: string, icon: ReactNode = <SettingsIcon size={14} />) =>
  function EditTrigger(p: TriggerProps) {
    return <Button iconOnly size="small" variant="invisible" aria-label={label} title={label} icon={icon} {...p} />
  }

function StatusSection({ model }: { model: IssueModel }) {
  const { issue, member, actions } = model
  const state = visibleState(issue)
  return (
    <Section title="Status">
      {member && issue.status !== "closed" ? (
        <StatusMenu
          issue={issue}
          onSet={actions.setStatus}
          trigger={(p) => (
            <button type="button" className="btn side-select" data-variant="default" {...p}>
              <StateIcon state={state} size={14} />
              <span className="side-select-text">{statusOptions.find((o) => o.status === issue.status)?.label}</span>
              <ChevronDownIcon size={14} />
            </button>
          )}
        />
      ) : (
        <div className="side-value">
          <StateIcon state={state} size={14} />
          {stateText(issue) ?? statusText[state]}
        </div>
      )}
    </Section>
  )
}

function AssigneeValue({ issue }: { issue: Issue }) {
  const a = issue.assignee
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

function AssigneeSection({ model }: { model: IssueModel }) {
  const { app, issue, me, member, actions } = model
  const user = me?.user
  return (
    <Section title="Assignee" action={member ? <AssignMenu app={app} issue={issue} onAssign={actions.assign} trigger={edit("Assign")} /> : undefined}>
      {issue.assignee ? (
        <div className="side-value">
          <ActorAvatar actor={issue.assignee} size={20} />
          <ActorName actor={issue.assignee} />
        </div>
      ) : (
        <div className="side-empty">
          No one
          {member && user && (
            <>
              {" · "}
              <button type="button" className="link-button" onClick={() => actions.assign({ type: "member", id: user.id, name: user.name, avatar_url: user.avatar_url })}>
                assign yourself
              </button>
            </>
          )}
        </div>
      )}
    </Section>
  )
}

function LabelsSection({ model }: { model: IssueModel }) {
  const { app, issue, member, actions } = model
  return (
    <Section
      title="Labels"
      action={member ? <LabelMenu app={app} selected={issue.labels.map((l) => l.id)} onToggle={actions.toggleLabel} trigger={edit("Edit labels")} /> : undefined}
    >
      {issue.labels.length ? (
        <div className="side-labels">
          {issue.labels.map((l) => (
            <AppLink
              key={l.id}
              slug={app.slug}
              href={appPath(app.slug, `?q=${encodeURIComponent(`is:open label:${/\s/.test(l.name) ? `"${l.name}"` : l.name}`)}`)}
              title={l.description}
            >
              <Label name={l.name} color={l.color} />
            </AppLink>
          ))}
        </div>
      ) : (
        <div className="side-empty">None yet</div>
      )}
    </Section>
  )
}

function RelationsSection({ model }: { model: IssueModel }) {
  const { app, issue, member, actions } = model
  return (
    <Section
      title="Relationships"
      action={
        member ? (
          <Menu align="end" width={260} trigger={edit("Add relationship", <PlusIcon size={14} />)}>
            {(close) => <RelationForm onAdd={actions.addRelation} onDone={close} />}
          </Menu>
        ) : undefined
      }
    >
      <RelationList app={app} issue={issue} onRemove={member ? actions.removeRelation : undefined} />
    </Section>
  )
}

/** Reporter, times, participants, attachments, system info and the copy-link action. */
function InfoSections({ model }: { model: IssueModel }) {
  const { issue, member } = model
  const [settingTier, setSettingTier] = useState(false)
  const files = allAttachments(issue)
  const people = participants(issue)
  return (
    <>
      <Section
        title="Reporter"
        action={
          member && canHaveTier(issue.author) ? (
            <Button
              iconOnly
              size="small"
              variant="invisible"
              aria-label="Set tier"
              title="Set tier"
              aria-expanded={settingTier}
              icon={<SettingsIcon size={14} />}
              onClick={() => setSettingTier(!settingTier)}
            />
          ) : undefined
        }
      >
        <div className="side-value">
          <ActorAvatar actor={issue.author} size={20} />
          <ActorName actor={issue.author} badge={false} />
          <ReporterKind actor={issue.author} />
          {issue.author.type !== "agent" && issue.author.tier && <TierBadge tier={issue.author.tier} />}
        </div>
        {issue.author.type !== "agent" && issue.author.tier && !issue.author.tier.agents_reply && (
          <p className="side-humans" title={`${issue.author.tier.name}: agents can only leave internal notes here`}>
            Humans only: agents leave internal notes, a person replies
          </p>
        )}
        {settingTier && (
          <TierPicker
            slug={model.app.slug}
            actor={issue.author}
            onDone={() => setSettingTier(false)}
            onChanged={() => void load(keys.issue(model.app.slug, issue.number), () => api.issue(model.app.slug, issue.number)).catch(() => {})}
          />
        )}
        <dl className="side-times">
          <div>
            <dt>Opened</dt>
            <dd>
              <Time iso={issue.created_at} />
            </dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>
              <Time iso={lastActivity(issue)} />
            </dd>
          </div>
        </dl>
      </Section>

      <Section title={people.length === 1 ? "1 participant" : `${people.length} participants`}>
        <div className="side-people">
          {people.map((a) => (
            <span key={`${a.type}:${a.id}`} className="side-person" title={a.type === "agent" ? `${actorName(a)} (AI)` : actorName(a)}>
              <ActorAvatar actor={a} size={22} />
              {a.type === "agent" && <AiBadge />}
            </span>
          ))}
        </div>
      </Section>

      {files.length > 0 && (
        <Section title="Attachments">
          <AttachmentList attachments={files} />
        </Section>
      )}

      <section className="side-section side-foot">
        {member && issue.system_info && issue.system_info !== "hidden" && <SystemInfo info={issue.system_info} />}
        <CopyLink number={issue.number} />
      </section>
    </>
  )
}

function ReporterKind({ actor }: { actor: Actor }) {
  if (actor.type === "agent") return <AiBadge />
  if (actor.type === "guest") return <span className="guest-marker">Guest</span>
  if (actor.role) return <span className="role-badge">{actor.role === "owner" ? "Owner" : "Member"}</span>
  return <span className="guest-marker">Account</span>
}

function SystemInfo({ info }: { info: Exclude<Issue["system_info"], null | "hidden"> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="side-sysinfo">
      <button type="button" className="side-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        System info
        <ChevronDownIcon size={12} />
      </button>
      {open && <SystemInfoList info={info} />}
    </div>
  )
}

function CopyLink({ number }: { number: number }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${window.location.pathname}`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access denied; the address bar still has the link.
    }
  }
  return (
    <button type="button" className="side-copy" onClick={copy}>
      <LinkIcon size={14} />
      {copied ? "Copied" : "Copy link"}
      <span className="mono side-copy-number">#{number}</span>
    </button>
  )
}

/** Everyone who wrote or did something here, in order of first appearance. */
function participants(issue: Issue): Actor[] {
  const seen = new Map<string, Actor>()
  const add = (a: Actor) => seen.has(`${a.type}:${a.id}`) || seen.set(`${a.type}:${a.id}`, a)
  add(issue.author)
  for (const t of issue.timeline) add(t.kind === "comment" ? t.comment.author : t.event.actor)
  return [...seen.values()]
}

function lastActivity(issue: Issue) {
  let last = issue.updated_at
  for (const t of issue.timeline) {
    const at = t.kind === "comment" ? t.comment.created_at : t.event.created_at
    if (at > last) last = at
  }
  return last
}

/** Sticky only while the whole sidebar fits in the window; otherwise it scrolls with the page so nothing is cut off. */
function useFits(ref: RefObject<HTMLElement | null>) {
  const [fits, setFits] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setFits(el.offsetHeight + 48 <= window.innerHeight)
    check()
    const observer = new ResizeObserver(check)
    observer.observe(el)
    window.addEventListener("resize", check)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", check)
    }
  }, [ref])
  return fits
}
