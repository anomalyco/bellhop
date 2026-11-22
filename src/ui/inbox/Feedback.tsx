import { useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { Attachment, FeedbackInfo, Issue, IssueRef } from "../../../shared/api"
import { useT } from "../../i18n/inbox"
import { Time } from "../../lib/time"
import { CheckIcon, ChevronDownIcon, MailIcon, XIcon } from "../icons"
import { StateIcon } from "../primitives"
import { visibleState } from "../../lib/issues"
import "../../styles/inbox.css"

function CopyGlyph() {
  return (
    <svg className="icon" width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  )
}

/** A small copy button: the text goes to the clipboard and the button says so for a moment. */
export function CopyIconButton({ text, label }: { text: string; label: string }) {
  const t = useT()
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <button
      type="button"
      className="fb-copy"
      aria-label={done ? t("metadata.copied") : `${t("metadata.copy")}: ${label}`}
      title={done ? t("metadata.copied") : t("metadata.copy")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
        } catch {
          return
        }
        setDone(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <CheckIcon size={12} /> : <CopyGlyph />}
    </button>
  )
}

/** The screenshots among an issue's attachments, in the order the app sent them. */
export function screenshotsOf(feedback: FeedbackInfo, attachments: Attachment[]) {
  const byId = new Map(attachments.map((a) => [a.id, a]))
  return feedback.screenshot_ids.map((id) => byId.get(id)).filter((a): a is Attachment => !!a)
}

/** Thumbnails in fixed portrait boxes (nothing moves as they load); each opens the lightbox. */
export function Gallery({ shots }: { shots: Attachment[] }) {
  const t = useT()
  const [open, setOpen] = useState<number | null>(null)
  if (!shots.length) return null
  return (
    <>
      <div className="fb-gallery" role="list">
        {shots.map((a, i) => (
          <button key={a.id} type="button" role="listitem" className="fb-thumb" onClick={() => setOpen(i)} aria-label={t("gallery.open", { n: i + 1, count: shots.length })}>
            <img src={a.url} alt="" loading="lazy" decoding="async" />
          </button>
        ))}
      </div>
      {open !== null && <Lightbox shots={shots} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
    </>
  )
}

function Lightbox({ shots, index, onIndex, onClose }: { shots: Attachment[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const back = useRef<Element | null>(null)
  const shot = shots[index]!
  const step = (by: number) => onIndex((index + by + shots.length) % shots.length)
  useEffect(() => {
    back.current = document.activeElement
    ref.current?.focus()
    return () => (back.current as HTMLElement | null)?.focus?.()
  }, [])
  return createPortal(
    <div
      ref={ref}
      className="fb-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={t("gallery.label", { n: index + 1, count: shots.length })}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        } else if (e.key === "ArrowRight" || e.key === "j") {
          e.preventDefault()
          step(1)
        } else if (e.key === "ArrowLeft" || e.key === "k") {
          e.preventDefault()
          step(-1)
        }
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="fb-lightbox-bar">
        <span className="fb-lightbox-count mono">
          {index + 1} / {shots.length}
        </span>
        <a className="fb-lightbox-link" href={shot.url} target="_blank" rel="noreferrer">
          {t("gallery.download")}
        </a>
        <button type="button" className="fb-lightbox-btn" onClick={onClose} aria-label={t("gallery.close")}>
          <XIcon size={16} />
        </button>
      </div>
      <img className="fb-lightbox-img" src={shot.url} alt={t("gallery.label", { n: index + 1, count: shots.length })} />
      {shots.length > 1 && (
        <>
          <button type="button" className="fb-lightbox-btn fb-lightbox-prev" onClick={() => step(-1)} aria-label={t("gallery.prev")}>
            <ChevronDownIcon size={18} />
          </button>
          <button type="button" className="fb-lightbox-btn fb-lightbox-next" onClick={() => step(1)} aria-label={t("gallery.next")}>
            <ChevronDownIcon size={18} />
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}

/** Whether replies reach the sender: confirmed, waiting for confirmation, no address, or anonymous. */
/** Whether the team has replied in public: until then an unconfirmed address hasn't been asked to confirm. */
export const repliedInPublic = (issue: Issue) =>
  issue.timeline.some((i) => i.kind === "comment" && !i.comment.internal && !i.comment.hidden && !i.comment.by_issue_author)

export function EmailState({ feedback, replied }: { feedback: FeedbackInfo; replied: boolean }) {
  const t = useT()
  if (feedback.anonymous) return <p className="fb-email" data-state="anonymous">{t("email.anonymous")}</p>
  if (!feedback.email)
    return (
      <p className="fb-email" data-state="none">
        <MailIcon size={14} />
        {t("email.none")}
      </p>
    )
  const { address, confirmed } = feedback.email
  // Nothing is emailed at submission: the team's first public reply sends the one request to confirm.
  const state = confirmed ? "confirmed" : replied ? "asked" : "unconfirmed"
  return (
    <div className="fb-email-block">
      <p className="fb-email" data-state={state}>
        <MailIcon size={14} />
        <span className="mono fb-email-address">{address}</span>
        <span className="fb-pill" data-state={state}>
          {confirmed ? t("email.confirmed") : replied ? t("email.asked") : t("email.notConfirmed")}
        </span>
      </p>
      {!confirmed && <p className="fb-email-note">{replied ? t("email.askedText") : t("email.firstReplyAsks")}</p>}
    </div>
  )
}

function Fact({ label, children, mono, copy }: { label: string; children: ReactNode; mono?: boolean; copy?: string }) {
  return (
    <div className="fb-fact">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>
        <span className="fb-fact-value">{children}</span>
        {copy && <CopyIconButton text={copy} label={label} />}
      </dd>
    </div>
  )
}

/** App, version and build, platform, OS, model, locale, install id and the host app's user, as sent. */
export function Facts({ feedback, received }: { feedback: FeedbackInfo; received?: string }) {
  const t = useT()
  const app = feedback.app
  const device = feedback.device
  const version = [app?.version, app?.build && `(${app.build})`].filter(Boolean).join(" ")
  const user = feedback.user && [feedback.user.name, feedback.user.id && `#${feedback.user.id}`].filter(Boolean).join(" ")
  return (
    <dl className="fb-facts">
      {app?.name && <Fact label={t("fact.app")}>{app.name}</Fact>}
      {version && (
        <Fact label={t("fact.version")} mono copy={version}>
          {version}
        </Fact>
      )}
      {device?.platform && (
        <Fact label={t("fact.platform")} mono>
          {device.platform}
        </Fact>
      )}
      {device?.os && <Fact label={t("fact.os")}>{device.os}</Fact>}
      {device?.model && (
        <Fact label={t("fact.model")} mono>
          {device.model}
        </Fact>
      )}
      {device?.locale && (
        <Fact label={t("fact.locale")} mono>
          {device.locale}
        </Fact>
      )}
      {feedback.install_id && (
        <Fact label={t("fact.install")} mono copy={feedback.install_id}>
          {feedback.install_id}
        </Fact>
      )}
      {user && <Fact label={t("fact.user")}>{user}</Fact>}
      {feedback.category && <Fact label={t("fact.category")}>{feedback.category}</Fact>}
      {received && (
        <Fact label={t("fact.received")}>
          <Time iso={received} />
        </Fact>
      )}
    </dl>
  )
}

/**
 * The app's own key/value metadata, in a table: values are mono and wrap; clicking one filters the inbox to it
 * (meta:<key>=<value>) when `onFilter` is given; the copy button copies it.
 */
export function Metadata({ metadata, onFilter }: { metadata: Record<string, string>; onFilter?: (key: string, value: string) => void }) {
  const t = useT()
  const entries = Object.entries(metadata)
  if (!entries.length) return null
  return (
    <table className="fb-meta">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <th scope="row" className="mono">
              {k}
            </th>
            <td className="mono">
              {onFilter ? (
                <button type="button" className="fb-meta-value" title={t("metadata.filter", { key: k, value: v })} onClick={() => onFilter(k, v)}>
                  {v}
                </button>
              ) : (
                <span className="fb-meta-value">{v}</span>
              )}
            </td>
            <td className="fb-meta-copy">
              <CopyIconButton text={v} label={k} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** Other reports from the same install, newest first. */
export function SameInstall({ refs, link }: { refs: IssueRef[]; link: (r: IssueRef) => ReactNode }) {
  if (!refs.length) return null
  return (
    <ul className="fb-same">
      {refs.map((r) => (
        <li key={r.id}>
          <StateIcon state={visibleState(r)} size={14} />
          {link(r)}
        </li>
      ))}
    </ul>
  )
}

/** A titled block in the detail pane or the issue page's panel. */
export function FbSection({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="fb-section">
      <div className="fb-section-head">
        <h3 className="fb-section-title">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}
