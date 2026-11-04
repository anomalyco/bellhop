import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import type { Analytics, AppDetail, Tier } from "../../../shared/api"
import { api, errorMessage, keys } from "../../lib/api"
import { useResource } from "../../lib/cache"
import { TierBadge } from "../../ui/Actor"
import { Label } from "../../ui/primitives"
import { t, tr, tKey, useT } from "../../i18n/settings"
import { formatNumber, getLocale } from "../../i18n"
import "../../styles/insights.css"
import { isDesk } from "../../lib/helpdesk"
import { useT as useDeskT } from "../../i18n/helpdesk"

type Days = 7 | 30 | 90
const windows: Days[] = [7, 30, 90]

/** One decimal below 10 ("3.4"), whole numbers above, in the active language's digits. */
const compact = (n: number) => new Intl.NumberFormat(getLocale(), { maximumFractionDigits: n < 10 ? 1 : 0 }).format(n)

/** "45s", "12m", "3.4h", "2.1d" (in the language's compact units); null as "—". */
export function duration(seconds: number | null | undefined) {
  if (seconds == null) return "—"
  if (seconds < 60) return t("insights.seconds", { n: Math.max(0, Math.round(seconds)) })
  if (seconds < 3600) return t("insights.minutes", { n: Math.round(seconds / 60) })
  if (seconds < 86400) return t("insights.hours", { n: compact(seconds / 3600) })
  return t("insights.daysShort", { n: compact(seconds / 86400) })
}

const percent = (share: number | null | undefined) =>
  share == null ? "—" : new Intl.NumberFormat(getLocale(), { style: "percent", maximumFractionDigits: 0 }).format(share)
const ratio = (n: number | null | undefined) =>
  n == null ? "—" : new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)

/**
 * Settings → Insights (members): how the workspace is doing over 7, 30 or 90 days. The agent-resolved rate leads,
 * then response and resolution times, reopen share, "This helped" per reply and the queue waiting on the team; a
 * daily chart of opened and closed with the first-response median; and breakdowns by tier and label.
 */
export function Insights({ app }: { app: AppDetail }) {
  useT()
  const [days, setDays] = useState<Days>(30)
  const { data, error } = useResource<Analytics>(keys.analytics(app.slug, days), () => api.analytics(app.slug, days), 60_000)
  // The last answer stays up (dimmed) while another window loads, so nothing collapses and nothing moves.
  const last = useRef<Analytics | null>(null)
  if (data) last.current = data
  const shown = data ?? (error ? null : last.current)
  const pending = !data && !error

  return (
    <div className="insights">
      <div className="settings-heading insights-heading">
        <h1>{tKey("section.insights")}</h1>
        <div className="segmented" role="radiogroup" aria-label={t("insights.period")}>
          {windows.map((d) => (
            <button key={d} type="button" role="radio" aria-checked={days === d} aria-pressed={days === d} onClick={() => setDays(d)}>
              {t("insights.days", { count: d })}
            </button>
          ))}
        </div>
      </div>
      <p className="settings-lede">{t("insights.lede", { count: days })}</p>
      {error && !shown ? (
        <p className="flash" data-tone="danger">
          {errorMessage(error)}
        </p>
      ) : !shown ? (
        // Nothing until the first answer: translated numbers and notes wrap differently from any skeleton, and an
        // empty area below can fill in without moving anything.
        <div className="insights-body" aria-busy="true" />
      ) : (
        <div className="insights-body" data-pending={pending || undefined} aria-busy={pending || undefined}>
          <Headline data={shown} days={days} />
          {isDesk(app) && <Handoff data={shown} />}
          <Chart data={shown} />
          <Breakdowns app={app} data={shown} />
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, hint, ready }: { label: string; value: string; sub?: ReactNode; hint?: string; ready: boolean }) {
  const empty = value === "—"
  return (
    <div className="stat" title={empty ? hint : undefined}>
      <span className="stat-label">{label}</span>
      <span className="stat-value" data-empty={empty || undefined}>
        {ready ? value : <span className="skeleton stat-skeleton" />}
      </span>
      <span className="stat-sub">{ready ? (empty && hint ? hint : sub) : "\u00a0"}</span>
    </div>
  )
}

function Headline({ data, days }: { data: Analytics | null; days: Days }) {
  const ready = !!data
  const d = data
  const resolved = d?.agent_resolved_share
  return (
    <section className="headline" aria-label={t("insights.headline")}>
      <div className="hero">
        <span className="stat-label">{t("insights.resolvedByAgents")}</span>
        <span className="hero-value" data-empty={(ready && resolved == null) || undefined}>
          {ready ? percent(resolved) : <span className="skeleton hero-skeleton" />}
        </span>
        <p className="hero-text">
          {!ready
            ? "\u00a0"
            : resolved == null
              ? t("insights.nothingResolved", { count: days })
              : t("insights.resolvedText")}
        </p>
        <div className="hero-bar" aria-hidden="true">
          <span style={{ width: `${Math.round((resolved ?? 0) * 100)}%` }} />
        </div>
      </div>
      <div className="stats">
        <Stat
          ready={ready}
          label={t("insights.firstResponse")}
          value={duration(d?.first_response.median)}
          hint={t("insights.noReplies")}
          sub={
            <>
              {t("insights.p90", { value: duration(d?.first_response.p90) })}
              {d?.first_response.by_agent_share != null && <> · {t("insights.byAgents", { share: percent(d.first_response.by_agent_share) })}</>}
            </>
          }
        />
        <Stat
          ready={ready}
          label={t("insights.resolution")}
          value={duration(d?.resolution.median)}
          hint={t("insights.nothingResolvedYet")}
          sub={t("insights.p90", { value: duration(d?.resolution.p90) })}
        />
        <Stat ready={ready} label={t("insights.reopened")} value={percent(d?.reopened_share)} hint={t("insights.noIssues")} sub={t("insights.ofOpened")} />
        <Stat
          ready={ready}
          label={t("insights.helped")}
          value={ratio(d?.helpful_per_reply.agent)}
          hint={t("insights.noAgentReplies")}
          sub={t("insights.agentsPeople", { value: ratio(d?.helpful_per_reply.human) })}
        />
        <Stat ready={ready} label={t("insights.waiting")} value={d ? formatNumber(d.waiting_on_team) : "—"} sub={t("insights.openNow")} />
        <Stat
          ready={ready}
          label={t("insights.openedClosed")}
          value={d ? `${formatNumber(d.opened)} · ${formatNumber(d.closed)}` : "—"}
          sub={t("insights.inDays", { count: days })}
        />
      </div>
    </section>
  )
}

/** Help desks: how often requests went to a person, and how fast a person replied once they did. */
function Handoff({ data }: { data: Analytics }) {
  const td = useDeskT()
  return (
    <section className="stats stats-pair" aria-label={td("queue.handoff")}>
      <Stat ready label={td("insights.escalationRate")} value={percent(data.escalation_rate)} hint={td("insights.noHandoffs")} sub={td("insights.escalationRateSub")} />
      <Stat ready label={td("insights.humanReply")} value={duration(data.time_to_human_reply_median)} hint={td("insights.noHandoffs")} sub={td("insights.humanReplySub")} />
    </section>
  )
}

const fmtDate = (iso: string) =>
  new Intl.DateTimeFormat(getLocale(), { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))

/** The daily chart: opened and closed as bars, the first-response median as a line on its own scale. Plain SVG. */
function Chart({ data }: { data: Analytics | null }) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [focus, setFocus] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setWidth(Math.round(el.clientWidth))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const daily = data?.daily ?? []
  const height = 168
  const pad = { top: 10, right: 40, bottom: 22, left: 28 }
  const w = Math.max(0, width - pad.left - pad.right)
  const h = height - pad.top - pad.bottom
  const maxCount = Math.max(1, ...daily.map((d) => Math.max(d.opened, d.closed)))
  const top = niceMax(maxCount)
  const responses = daily.map((d) => d.first_response_median).filter((v): v is number => v != null)
  const maxResponse = responses.length ? Math.max(...responses) : null
  const slot = daily.length ? w / daily.length : 0
  const bar = Math.max(1, Math.min(10, slot * 0.36))
  const y = (n: number) => pad.top + h - (n / top) * h
  const ry = (s: number) => pad.top + h - (maxResponse ? (s / maxResponse) * h * 0.9 : 0)
  const x = (i: number) => pad.left + slot * i + slot / 2
  const line = daily
    .map((d, i) => (d.first_response_median == null ? null : `${x(i).toFixed(1)},${ry(d.first_response_median).toFixed(1)}`))
    .filter(Boolean) as string[]
  const empty = !!data && data.opened === 0 && daily.every((d) => d.closed === 0)
  const active = focus !== null ? daily[focus] : null

  const onKey = (e: KeyboardEvent) => {
    if (!daily.length) return
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault()
      const step = e.key === "ArrowRight" ? 1 : -1
      setFocus((f) => Math.min(daily.length - 1, Math.max(0, (f ?? (step > 0 ? -1 : daily.length)) + step)))
    } else if (e.key === "Escape") setFocus(null)
  }

  return (
    <section className="chart" aria-label={t("insights.chart")}>
      <div className="chart-head">
        <div className="chart-legend" aria-hidden="true">
          <span className="legend" data-kind="opened">
            {t("insights.opened")}
          </span>
          <span className="legend" data-kind="closed">
            {t("insights.closed")}
          </span>
          <span className="legend" data-kind="response">
            {t("insights.firstResponse")}
          </span>
        </div>
        <p className="chart-readout" aria-live="polite">
          {active ? (
            tr("insights.readoutDay", {
              date: <span className="mono">{fmtDate(active.date)}</span>,
              opened: active.opened,
              closed: active.closed,
              response: duration(active.first_response_median),
            })
          ) : data ? (
            t("insights.readoutTotal", { opened: data.opened, closed: data.closed })
          ) : (
            "\u00a0"
          )}
        </p>
      </div>
      <div
        ref={box}
        className="chart-box"
        style={{ height }}
        tabIndex={0}
        role="img"
        aria-label={data ? t("insights.chartLabel", { opened: data.opened, closed: data.closed, days: data.days }) : t("insights.chartLoading")}
        onKeyDown={onKey}
        onBlur={() => setFocus(null)}
        onPointerLeave={() => setFocus(null)}
        onPointerMove={(e) => {
          if (!slot) return
          const r = e.currentTarget.getBoundingClientRect()
          const i = Math.floor((e.clientX - r.left - pad.left) / slot)
          setFocus(i >= 0 && i < daily.length ? i : null)
        }}
      >
        {width > 0 && data && (
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {[0, top / 2, top].map((tick) => (
              <g key={tick}>
                <line className="chart-grid" x1={pad.left} x2={pad.left + w} y1={y(tick)} y2={y(tick)} />
                <text className="chart-axis" x={pad.left - 6} y={y(tick) + 3.5} textAnchor="end">
                  {formatNumber(tick)}
                </text>
              </g>
            ))}
            {maxResponse != null && (
              <text className="chart-axis" x={pad.left + w + 6} y={ry(maxResponse) + 3.5}>
                {duration(maxResponse)}
              </text>
            )}
            {active && focus !== null && <rect className="chart-focus" x={pad.left + slot * focus} y={pad.top} width={slot} height={h} />}
            {daily.map((d, i) => (
              <g key={d.date}>
                {d.opened > 0 && <rect className="chart-bar" data-kind="opened" x={x(i) - bar - 0.5} y={y(d.opened)} width={bar} height={pad.top + h - y(d.opened)} rx={1} />}
                {d.closed > 0 && <rect className="chart-bar" data-kind="closed" x={x(i) + 0.5} y={y(d.closed)} width={bar} height={pad.top + h - y(d.closed)} rx={1} />}
              </g>
            ))}
            {line.length > 1 && <polyline className="chart-line" points={line.join(" ")} />}
            {line.map((p) => {
              const [cx, cy] = p.split(",")
              return <circle key={p} className="chart-dot" cx={cx} cy={cy} r={line.length > 40 ? 1.5 : 2.5} />
            })}
            {daily.length > 0 &&
              [0, Math.floor((daily.length - 1) / 2), daily.length - 1].map((i, n) => (
                <text key={n} className="chart-axis" x={x(i)} y={height - 6} textAnchor={n === 0 ? "start" : n === 2 ? "end" : "middle"}>
                  {fmtDate(daily[i]!.date)}
                </text>
              ))}
          </svg>
        )}
        {empty && (
          <p className="chart-empty">
            <span>{t("insights.chartEmpty")}</span>
          </p>
        )}
      </div>
    </section>
  )
}

function niceMax(n: number) {
  if (n <= 4) return 4
  const pow = 10 ** Math.floor(Math.log10(n))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * pow >= n) return Math.ceil((m * pow) / 2) * 2
  return n
}

function Breakdowns({ app, data }: { app: AppDetail; data: Analytics | null }) {
  // Analytics names labels and tiers; their colours come from the app and the tier list.
  const { data: tierList } = useResource<Tier[]>(keys.tiers(app.slug), () => api.tiers(app.slug), 30_000)
  const labelColor = (name: string) => app.labels.find((l) => l.name === name)?.color ?? "878d96"
  const tierColor = (name: string) => tierList?.find((x) => x.name === name)?.color ?? "878d96"
  const labels = data?.by_label ?? []
  const tiers = data?.by_tier ?? []
  const maxLabel = Math.max(1, ...labels.map((l) => l.opened))
  const maxTier = Math.max(1, ...tiers.map((x) => x.opened))
  return (
    <div className="breakdowns">
      <section className="breakdown" aria-labelledby="by-label">
        <h2 id="by-label" className="section-title">
          {t("insights.byLabel")}
        </h2>
        <div className="box">
          {!data && <div className="box-row skeleton-row" />}
          {data && labels.length === 0 && <div className="box-empty">{t("insights.byLabelEmpty")}</div>}
          {labels.map((l) => (
            <div key={l.label} className="box-row breakdown-row">
              <span className="breakdown-name">
                <Label name={l.label} color={labelColor(l.label)} />
              </span>
              <span className="breakdown-bar" aria-hidden="true">
                <span style={{ width: `${(l.opened / maxLabel) * 100}%` }} />
              </span>
              <span className="breakdown-num">{formatNumber(l.opened)}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="breakdown" aria-labelledby="by-tier">
        <h2 id="by-tier" className="section-title">
          {t("insights.byTier")}
        </h2>
        <div className="box">
          {!data && <div className="box-row skeleton-row" />}
          {data && tiers.length === 0 && <div className="box-empty">{t("insights.byTierEmpty")}</div>}
          {tiers.map((tier) => (
            <div key={tier.tier} className="box-row breakdown-row">
              <span className="breakdown-name">
                <TierBadge tier={{ name: tier.tier, color: tierColor(tier.tier) }} />
              </span>
              <span className="breakdown-bar" aria-hidden="true">
                <span style={{ width: `${(tier.opened / maxTier) * 100}%` }} />
              </span>
              <span className="breakdown-num" title={t("insights.opened")}>
                {formatNumber(tier.opened)}
              </span>
              <span className="breakdown-sub" title={t("insights.median")}>
                {duration(tier.first_response_median)}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

