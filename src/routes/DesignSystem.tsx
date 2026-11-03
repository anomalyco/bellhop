import type { CSSProperties, ReactNode } from "react"
import {
  ChevronDownIcon,
  CommentIcon,
  ImageIcon,
  IssueOpenIcon,
  KebabIcon,
  PaperclipIcon,
  PersonIcon,
  PlusIcon,
  RecordIcon,
  SearchIcon,
  SettingsIcon,
  TagIcon,
  VideoIcon,
} from "../ui/icons"
import {
  AgentAvatar,
  AiBadge,
  Button,
  Counter,
  Dots,
  Identicon,
  Label,
  Logo,
  StateIcon,
  StateLabel,
  type ButtonVariant,
} from "../ui/primitives"

const swatches: [string, string, string][] = [
  ["Canvas", "--bg", "#0d1013"],
  ["Subtle", "--bg-subtle", "#14181b"],
  ["Control", "--control-bg", "#1a1f22"],
  ["Border", "--border", "#2b3135"],
  ["Text", "--fg", "#f2f4f8"],
  ["Muted", "--fg-muted", "#a2a9b0"],
  ["Blue 60", "--accent", "#0f62fe"],
  ["Blue 40", "--accent-fg", "#78a9ff"],
  ["Open", "--open", "#42be65"],
  ["In progress", "--progress", "#f1c21b"],
  ["Waiting", "--waiting", "#33b1ff"],
  ["Closed", "--closed", "#a56eff"],
  ["Not planned", "--neutral", "#878d96"],
  ["Danger", "--danger", "#fa4d56"],
  ["Focus", "--focus", "#4589ff"],
  ["Inset", "--bg-inset", "#090b0d"],
]

const rows: [ButtonVariant, string, string][] = [
  ["primary", "Primary", "New issue"],
  ["default", "Default", "Comment"],
  ["danger", "Danger", "Close issue"],
  ["outline", "Outline", "Claim"],
  ["invisible", "Invisible", "Cancel"],
]

const labels: [string, string][] = [
  ["bug", "fa4d56"],
  ["question", "4589ff"],
  ["enhancement", "42be65"],
  ["needs info", "f1c21b"],
  ["video", "a56eff"],
  ["safari", "ff832b"],
  ["billing", "08bdba"],
  ["duplicate", "878d96"],
]

function Section({ title, children, style }: { title: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <section style={{ display: "grid", gap: 14, alignContent: "start", ...style }}>
      <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, lineHeight: "20px" }}>{title}</h2>
      {children}
    </section>
  )
}

const muted: CSSProperties = { color: "var(--fg-muted)", fontSize: 12 }
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }

export function DesignSystem() {
  return (
    <div style={{ width: 1600, height: 1200, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          height: 64,
          padding: "0 32px",
          background: "var(--bg-inset)",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <Logo size={26} />
        <span style={{ color: "var(--fg-subtle)", fontSize: 18 }}>/</span>
        <span style={{ fontWeight: 600, fontSize: 15 }}>opencode</span>
        <div style={{ flex: 1 }} />
        <div className="input" style={{ width: 300, height: 32 }}>
          <SearchIcon />
          <span className="placeholder">Search issues</span>
          <kbd
            style={{
              marginLeft: "auto",
              padding: "0 5px",
              fontSize: 11,
              color: "var(--fg-muted)",
              border: "1px solid var(--border)",
              borderRadius: 4,
            }}
          >
            /
          </kbd>
        </div>
        <Button variant="primary" icon={<PlusIcon />}>
          New issue
        </Button>
        <Identicon seed="member-ryan" size={32} />
      </header>

      <nav className="underline-nav" style={{ padding: "0 24px" }}>
        <a aria-current="page" href="#">
          <IssueOpenIcon />
          Issues <Counter>12</Counter>
        </a>
        <a href="#">
          <TagIcon />
          Labels
        </a>
        <a href="#">
          <SettingsIcon />
          Settings
        </a>
      </nav>

      <main
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "340px 712px 1fr",
          gridTemplateRows: "auto 1fr",
          gap: "28px 36px",
          padding: "24px 32px 28px",
          minHeight: 0,
        }}
      >
        <div style={{ display: "grid", gap: 26, alignContent: "start" }}>
          <Section title="Color">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px 8px" }}>
              {swatches.map(([name, token, hex]) => (
                <div key={token} style={{ display: "grid", gap: 6 }}>
                  <div
                    style={{
                      height: 34,
                      borderRadius: 6,
                      background: `var(${token})`,
                      boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.08)",
                    }}
                  />
                  <div style={{ lineHeight: "14px" }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{name}</div>
                    <div className="mono" style={{ fontSize: 11, color: "var(--fg-subtle)" }}>
                      {hex}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Type">
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontSize: 26, fontWeight: 700, lineHeight: "32px", letterSpacing: "-0.01em" }}>
                Uploads stall at 99%{" "}
                <span style={{ color: "var(--fg-subtle)", fontWeight: 400 }} className="mono">
                  #142
                </span>
              </div>
              <div style={{ fontSize: 16, fontWeight: 600 }}>Satoshi 16 semibold for titles</div>
              <div>Satoshi 14 for body text, comments and controls.</div>
              <div style={muted}>Satoshi 12 muted for metadata</div>
              <div className="mono" style={{ fontSize: 13, color: "var(--fg-muted)" }}>
                OpenTUI Mono · #142 · 3m ago · v1.4.3
              </div>
            </div>
          </Section>
        </div>

        <div style={{ display: "grid", gap: 26, alignContent: "start" }}>
          <Section title="Buttons">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "64px repeat(5, auto)",
                alignItems: "center",
                justifyContent: "start",
                gap: "10px 10px",
              }}
            >
              <span />
              {["Rest", "Hover", "Pressed", "Focus", "Disabled"].map((s) => (
                <span key={s} style={muted}>
                  {s}
                </span>
              ))}
              {rows.map(([variant, name, text]) => (
                <Row key={variant} variant={variant} name={name} text={text} />
              ))}
            </div>
          </Section>

          <Section title="Sizes, icons and groups">
            <div style={row}>
              <Button size="small" icon={<PersonIcon />}>
                Assign
              </Button>
              <Button icon={<TagIcon />} trailing={<Counter>3</Counter>}>
                Labels
              </Button>
              <Button size="large" variant="primary" icon={<PlusIcon />}>
                New issue
              </Button>
            </div>
            <div style={row}>
              <Button iconOnly aria-label="Search" icon={<SearchIcon />} />
              <Button iconOnly aria-label="Attach" icon={<PaperclipIcon />} />
              <Button iconOnly variant="invisible" aria-label="Image" icon={<ImageIcon />} />
              <Button iconOnly variant="invisible" aria-label="Record" icon={<RecordIcon />} />
              <Button iconOnly variant="invisible" aria-label="More" icon={<KebabIcon />} />
              <span style={{ width: 8 }} />
              <span className="btn-group">
                <Button icon={<StateIcon state="closed" />}>Close as completed</Button>
                <Button iconOnly aria-label="More close options" icon={<ChevronDownIcon />} />
              </span>
            </div>
          </Section>
        </div>

        <div style={{ display: "grid", gap: 26, alignContent: "start" }}>
          <Section title="States">
            <div style={row}>
              <StateLabel state="open" />
              <StateLabel state="in_progress" />
              <StateLabel state="waiting" />
            </div>
            <div style={row}>
              <StateLabel state="closed" />
              <StateLabel state="not_planned" />
              <span style={{ width: 6 }} />
              <StateLabel state="open" size="small" />
              <StateLabel state="closed" size="small" />
            </div>
          </Section>

          <Section title="Labels and badges">
            <div style={row}>
              {labels.map(([name, color]) => (
                <Label key={name} name={name} color={color} />
              ))}
            </div>
            <div style={row}>
              <AiBadge />
              <span className="role-badge">Author</span>
              <span className="role-badge">Member</span>
              <Counter>8</Counter>
              <Counter>142</Counter>
            </div>
          </Section>

          <Section title="People and agents">
            <div style={{ ...row, gap: 12 }}>
              <Identicon seed="guest-7f3a" size={40} />
              <Identicon seed="guest-19c0" size={32} />
              <Identicon seed="guest-b2e4" size={24} />
              <Identicon seed="guest-04dd" size={20} />
              <AgentAvatar size={40} />
              <AgentAvatar size={24} />
              <span className="activity" style={{ marginLeft: 4 }}>
                <Dots />
                <span style={{ fontSize: 13 }}>Working</span>
              </span>
            </div>
          </Section>

          <Section title="Inputs">
            <div className="input">
              <SearchIcon />
              <span className="qualifier">is:open</span>
              <span className="qualifier">label:bug</span>
              <span className="term">safari</span>
            </div>
            <div style={row}>
              <div className="input" data-demo="focus" style={{ flex: 1 }}>
                <span>Uploads stall at 99%</span>
                <span style={{ width: 1, height: 16, background: "var(--fg)", marginLeft: -6 }} />
              </div>
              <div className="segmented">
                <button aria-pressed="true">Write</button>
                <button aria-pressed="false">Preview</button>
              </div>
            </div>
          </Section>
        </div>

        <div style={{ gridColumn: "1 / span 2", minHeight: 0 }}>
          <IssueList />
        </div>
        <div style={{ minHeight: 0, overflow: "hidden" }}>
          <Timeline />
        </div>
      </main>
    </div>
  )
}

function Row({ variant, name, text }: { variant: ButtonVariant; name: string; text: string }) {
  return (
    <>
      <span style={muted}>{name}</span>
      <Button variant={variant}>{text}</Button>
      <Button variant={variant} demo="hover">
        {text}
      </Button>
      <Button variant={variant} demo="active">
        {text}
      </Button>
      <Button variant={variant} demo="focus">
        {text}
      </Button>
      <Button variant={variant} disabled>
        {text}
      </Button>
    </>
  )
}

const issues = [
  {
    state: "open" as const,
    title: "Uploads stall at 99% on Safari 18",
    labels: [["bug", "fa4d56"], ["safari", "ff832b"], ["video", "a56eff"]],
    meta: ["#142", "opened 3m ago by", "guest-7f3a"],
    working: true,
    comments: 4,
  },
  {
    state: "in_progress" as const,
    title: "Can't sign in with Google on Firefox",
    labels: [["bug", "fa4d56"]],
    meta: ["#141", "opened 22m ago by", "guest-19c0"],
    agent: true,
    comments: 6,
  },
  {
    state: "waiting" as const,
    title: "Export to CSV drops the last row",
    labels: [["needs info", "f1c21b"], ["billing", "08bdba"]],
    meta: ["#139", "opened 1h ago by", "guest-b2e4"],
    comments: 3,
  },
  {
    state: "closed" as const,
    title: "Dark mode resets after reload",
    labels: [["enhancement", "42be65"]],
    meta: ["#137", "closed 2d ago by", "OpenCode"],
    comments: 2,
  },
]

function IssueList() {
  return (
    <div className="box">
      <div className="box-header">
        <a className="tab-link" aria-current="page" href="#">
          <StateIcon state="open" /> 12 Open
        </a>
        <a className="tab-link" href="#">
          <StateIcon state="closed" /> 48 Closed
        </a>
        <div style={{ flex: 1 }} />
        <Button variant="invisible" size="small" trailing={<ChevronDownIcon />}>
          Label
        </Button>
        <Button variant="invisible" size="small" trailing={<ChevronDownIcon />}>
          Assignee
        </Button>
        <Button variant="invisible" size="small" trailing={<ChevronDownIcon />}>
          Newest
        </Button>
      </div>
      {issues.map((issue) => (
        <div className="box-row issue-row" key={issue.title}>
          <StateIcon state={issue.state} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <a className="issue-title" href="#">
                {issue.title}
              </a>
              {issue.labels.map(([n, c]) => (
                <Label key={n} name={n!} color={c!} />
              ))}
            </div>
            <div className="issue-meta">
              <span className="mono">{issue.meta[0]}</span> {issue.meta[1]} {issue.meta[2]}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 14, color: "var(--fg-muted)", fontSize: 12 }}>
            {issue.working && (
              <span className="activity" style={{ fontSize: 12 }}>
                <Dots /> OpenCode
              </span>
            )}
            {issue.agent && <AgentAvatar size={20} />}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 34 }}>
              <CommentIcon /> {issue.comments}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function Timeline() {
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div className="comment">
        <Identicon seed="guest-7f3a" size={40} />
        <div className="comment-box" data-author>
          <div className="comment-header">
            <strong>guest-7f3a</strong> <span>3m ago</span>
            <span className="spacer" />
            <span className="role-badge">Author</span>
          </div>
          <div className="comment-body">
            <p>Anything over about 50 MB stops at 99% in Safari. Recording attached.</p>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                height: 28,
                padding: "0 10px",
                fontSize: 12,
                border: "1px solid var(--border)",
                borderRadius: 6,
                color: "var(--fg-muted)",
              }}
            >
              <VideoIcon /> <span style={{ color: "var(--fg)" }}>upload-stall.mp4</span>
              <span className="mono">0:14</span>
            </span>
          </div>
        </div>
      </div>

      <div className="timeline-event">
        <span className="badge">
          <PersonIcon />
        </span>
        <AgentAvatar size={20} /> <strong>OpenCode</strong> claimed this 2m ago
      </div>

      <div className="comment">
        <AgentAvatar size={40} />
        <div className="comment-box">
          <div className="comment-header">
            <strong>OpenCode</strong> <AiBadge /> <span>1m ago</span>
          </div>
          <div className="comment-body">
            <p>
              This matches <a href="#">#128</a>: Safari drops multipart uploads when the tab loses focus. The fix is in{" "}
              <code>1.4.3</code>.
            </p>
          </div>
        </div>
      </div>

      <div className="comment" style={{ alignItems: "center" }}>
        <AgentAvatar size={40} />
        <div className="activity">
          <strong>OpenCode</strong>
          <Dots />
          <span>Checking the 1.4.3 changelog</span>
        </div>
      </div>
    </div>
  )
}
