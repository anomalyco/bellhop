import type { CSSProperties, ReactNode } from "react"
import {
  ChevronDownIcon,
  CommentIcon,
  ImageIcon,
  IssueOpenIcon,
  KebabIcon,
  LinkIcon,
  PaperclipIcon,
  PersonIcon,
  PlusIcon,
  RecordIcon,
  SearchIcon,
  SettingsIcon,
  TagIcon,
} from "../ui/icons"
import {
  AgentAvatar,
  AiBadge,
  Avatar,
  Button,
  Counter,
  Dots,
  Label,
  Logo,
  StateIcon,
  StateLabel,
  type ButtonVariant,
} from "../ui/primitives"

const swatches: [string, string, string][] = [
  ["Deep", "--bg-deep", "#050505"],
  ["Base", "--bg", "#0a0a0a"],
  ["Layer 1", "--layer-1", "#131313"],
  ["Layer 2", "--layer-2", "#1b1b1b"],
  ["Layer 3", "--layer-3", "#262626"],
  ["Primary", "--primary-bg", "#f2f2f2"],
  ["Hover", "--hover", "white 6%"],
  ["Border", "--border", "white 10%"],
  ["Text", "--fg", "#fafafa"],
  ["Muted", "--fg-muted", "#aeaeae"],
  ["Faint", "--fg-faint", "#808080"],
  ["Focus", "--focus", "#7698fd"],
  ["Open", "--open", "#6bd586"],
  ["In progress", "--progress", "#f2cf76"],
  ["Closed", "--closed", "#9e99f7"],
  ["Danger", "--danger", "#f17471"],
]

const variants: [ButtonVariant, string, string][] = [
  ["primary", "Primary", "Send"],
  ["default", "Neutral", "Label"],
  ["danger", "Danger", "Delete"],
  ["outline", "Outline", "Claim"],
  ["invisible", "Ghost", "Cancel"],
]

const labels: [string, string][] = [
  ["bug", "fa4d56"],
  ["question", "d26ae8"],
  ["enhancement", "4fd1c5"],
  ["needs info", "f1c21b"],
  ["safari", "ff832b"],
  ["billing", "33b1ff"],
  ["duplicate", "cccccc"],
]

const people: [string, string][] = [
  ["guest-7f3a", "guest-7f3a"],
  ["guest-19c0", "guest-19c0"],
  ["guest-b2e4", "guest-b2e4"],
  ["member-ryan", "Ryan"],
  ["member-dax", "Dax"],
  ["guest-04dd", "guest-04dd"],
]

function Section({ title, children, style }: { title: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <section style={{ display: "grid", gap: 12, alignContent: "start", ...style }}>
      <h2 style={{ margin: 0, fontSize: 13, fontWeight: 600, lineHeight: "20px", color: "var(--fg-muted)" }}>{title}</h2>
      {children}
    </section>
  )
}

const caption: CSSProperties = { color: "var(--fg-faint)", fontSize: 12 }
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }

export function DesignSystem() {
  return (
    <div style={{ width: 1600, height: 1200, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <header className="header">
        <div className="header-inner" style={{ maxWidth: "none", padding: "0 32px" }}>
          <Logo size={22} />
          <span className="header-sep">/</span>
          <span className="header-app">OpenCode</span>
          <nav className="app-nav">
            <a aria-current="page" href="#">
              <IssueOpenIcon size={14} />
              Issues <Counter>12</Counter>
            </a>
            <a href="#">
              <SettingsIcon size={14} />
              Settings
            </a>
          </nav>
          <span className="spacer" />
          <Avatar seed="member-ryan" name="Ryan" size={24} />
        </div>
      </header>

      <main
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "340px 540px 1fr",
          gridTemplateRows: "auto 1fr",
          gap: "36px 40px",
          padding: "28px 32px 0",
          minHeight: 0,
        }}
      >
        <div style={{ display: "grid", gap: 28, alignContent: "start" }}>
          <Section title="Colour">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "12px 8px" }}>
              {swatches.map(([name, token, value]) => (
                <div key={token} style={{ display: "grid", gap: 6 }}>
                  <div
                    style={{
                      height: 30,
                      borderRadius: 6,
                      background: `var(${token})`,
                      boxShadow: "inset 0 0 0 0.5px rgb(255 255 255 / 0.12)",
                    }}
                  />
                  <div style={{ lineHeight: "14px" }}>
                    <div style={{ fontSize: 12, fontWeight: 500 }}>{name}</div>
                    <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-faint)" }}>
                      {value}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section title="Type">
            <div style={{ display: "grid", gap: 10 }}>
              <div style={{ fontSize: 20, fontWeight: 600, lineHeight: "28px", letterSpacing: "-0.018em" }}>
                Uploads stall at 99%{" "}
                <span className="mono" style={{ color: "var(--fg-faint)", fontSize: 17, fontWeight: 400 }}>
                  #142
                </span>
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.015em" }}>Inter 16 semibold, section titles</div>
              <div style={{ fontWeight: 500 }}>Inter 14 medium, names and labels</div>
              <div>Inter 14 regular for messages and body text.</div>
              <div style={{ fontSize: 13, fontWeight: 530 }}>Inter 13 at 530 for buttons and controls</div>
              <div style={caption}>Inter 12 faint for times and metadata</div>
              <div className="mono" style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                OpenTUI Mono · #142 · v1.4.3
              </div>
            </div>
          </Section>
        </div>

        <div style={{ display: "grid", gap: 28, alignContent: "start" }}>
          <Section title="Buttons">
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "72px repeat(5, auto)",
                alignItems: "center",
                justifyContent: "start",
                gap: "10px 12px",
              }}
            >
              <span />
              {["Rest", "Hover", "Pressed", "Focus", "Disabled"].map((s) => (
                <span key={s} style={caption}>
                  {s}
                </span>
              ))}
              {variants.map(([variant, name, text]) => (
                <ButtonRow key={variant} variant={variant} name={name} text={text} />
              ))}
            </div>
            <div style={caption}>Buttons are pills, 30 px tall; icon-only ones are circles. Fields, menus and labels keep the 6 px corner.</div>
          </Section>

          <Section title="Sizes, icons and split">
            <div style={row}>
              <Button size="small" icon={<PersonIcon size={14} />}>
                Assign
              </Button>
              <Button icon={<TagIcon size={14} />} trailing={<Counter>3</Counter>}>
                Labels
              </Button>
              <Button size="large" variant="primary" icon={<PlusIcon size={14} />}>
                New issue
              </Button>
              <span className="split">
                <Button icon={<StateIcon state="closed" size={14} />}>Close issue</Button>
                <Button iconOnly aria-label="More close options" icon={<ChevronDownIcon size={14} />} />
              </span>
            </div>
            <div style={row}>
              <Button iconOnly aria-label="Search" icon={<SearchIcon size={14} />} />
              <Button iconOnly variant="invisible" aria-label="Attach" icon={<PaperclipIcon />} />
              <Button iconOnly variant="invisible" aria-label="Image" icon={<ImageIcon />} />
              <Button iconOnly variant="invisible" aria-label="Record" icon={<RecordIcon />} />
              <Button iconOnly variant="invisible" aria-label="More" icon={<KebabIcon />} />
              <Button variant="invisible" aria-pressed="true">
                Preview
              </Button>
              <Button variant="primary" trailing={<kbd className="kbd">⌘↵</kbd>}>
                Send
              </Button>
            </div>
          </Section>

          <Section title="Inputs">
            <div className="input">
              <SearchIcon size={14} />
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
                <button aria-pressed="true">
                  <StateIcon state="open" size={14} /> Open <span className="segmented-count">12</span>
                </button>
                <button aria-pressed="false">
                  <StateIcon state="closed" size={14} /> Closed <span className="segmented-count">48</span>
                </button>
              </div>
            </div>
          </Section>
        </div>

        <div style={{ display: "grid", gap: 28, alignContent: "start", gridTemplateColumns: "1fr 236px", columnGap: 28 }}>
          <div style={{ display: "grid", gap: 28, alignContent: "start" }}>
            <Section title="States">
              <div style={row}>
                <StateLabel state="open" />
                <StateLabel state="in_progress" />
                <StateLabel state="waiting" />
                <StateLabel state="closed" />
                <StateLabel state="not_planned" />
              </div>
              <div style={row}>
                <StateLabel state="open" size="small" />
                <StateLabel state="in_progress" size="small" />
                <StateLabel state="closed" size="small" text="Duplicate" />
                <span className="state" style={{ "--state-fg": "var(--danger)", "--state-bg": "var(--danger-bg)", "--state-border": "var(--danger-border)" } as CSSProperties} data-size="small">
                  Failed
                </span>
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
                <span className="role-badge">Owner</span>
                <span className="role-badge">Member</span>
                <span className="guest-marker">Guest</span>
                <Counter>8</Counter>
                <Counter>142</Counter>
              </div>
            </Section>

            <Section title="People and agents">
              <div style={{ ...row, gap: 10 }}>
                {people.map(([seed, name], i) => (
                  <Avatar key={seed} seed={seed} name={name} size={[32, 32, 28, 28, 24, 20][i]} />
                ))}
                <AgentAvatar size={32} />
                <AgentAvatar size={20} />
              </div>
            </Section>
          </div>

          <Section title="Menu">
            <div className="menu" style={{ position: "static", width: 236, animation: "none" }}>
              <div className="menu-filter">
                <div className="input" data-size="small">
                  <span className="placeholder">Filter labels</span>
                </div>
              </div>
              <button type="button" className="menu-item" role="menuitemcheckbox" aria-checked="true">
                <span className="menu-check">
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="m3.75 8.25 2.75 2.75 5.75-6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span className="menu-item-main">
                  <span className="menu-item-text">
                    <span className="label-dot" style={{ background: "#fa4d56" }} />
                    bug
                  </span>
                  <span className="menu-item-description">Something isn't working</span>
                </span>
              </button>
              <button type="button" className="menu-item" role="menuitemcheckbox" aria-checked="false" style={{ background: "var(--hover)" }}>
                <span className="menu-check" />
                <span className="menu-item-main">
                  <span className="menu-item-text">
                    <span className="label-dot" style={{ background: "#d26ae8" }} />
                    question
                  </span>
                  <span className="menu-item-description">A question about the app</span>
                </span>
              </button>
              <button type="button" className="menu-item" role="menuitemcheckbox" aria-checked="false">
                <span className="menu-check" />
                <span className="menu-item-main">
                  <span className="menu-item-text">
                    <span className="label-dot" style={{ background: "#4fd1c5" }} />
                    enhancement
                  </span>
                </span>
              </button>
            </div>
          </Section>
        </div>

        <div style={{ gridColumn: "1 / span 2", minHeight: 0 }}>
          <Section title="Issue list">
            <IssueList />
          </Section>
        </div>
        <div style={{ minHeight: 0 }}>
          <Section title="Conversation">
            <Conversation />
          </Section>
        </div>
      </main>
    </div>
  )
}

function ButtonRow({ variant, name, text }: { variant: ButtonVariant; name: string; text: string }) {
  return (
    <>
      <span style={caption}>{name}</span>
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
    labels: [["bug", "fa4d56"], ["safari", "ff832b"]],
    meta: "#142 · guest-7f3a opened 3m ago",
    working: true,
    comments: 4,
  },
  {
    state: "in_progress" as const,
    title: "Can't sign in with Google on Firefox",
    labels: [["bug", "fa4d56"]],
    meta: "#141 · guest-19c0 opened 22m ago",
    agent: true,
    comments: 6,
  },
  {
    state: "waiting" as const,
    title: "Export to CSV drops the last row",
    labels: [["needs info", "f1c21b"], ["billing", "33b1ff"]],
    meta: "#139 · guest-b2e4 opened 1h ago",
    comments: 3,
  },
  {
    state: "closed" as const,
    title: "Dark mode resets after reload",
    labels: [["enhancement", "4fd1c5"]],
    meta: "#137 · Ryan opened 2d ago",
    comments: 2,
  },
]

function IssueList() {
  return (
    <div>
      <div className="list-toolbar" style={{ gridTemplateColumns: "auto minmax(0, 1fr) auto auto" }}>
        <div className="segmented list-states">
          <a aria-current="page" href="#">
            <StateIcon state="open" size={14} /> Open <span className="segmented-count">12</span>
          </a>
          <a href="#">
            <StateIcon state="closed" size={14} /> Closed <span className="segmented-count">48</span>
          </a>
        </div>
        <div className="input list-search">
          <SearchIcon size={14} />
          <span className="placeholder">Search issues</span>
        </div>
        <div className="list-label">
          <Button icon={<TagIcon size={14} />} trailing={<ChevronDownIcon size={14} />}>
            Label
          </Button>
        </div>
        <Button variant="primary" icon={<PlusIcon size={14} />} className="btn list-new">
          New issue
        </Button>
      </div>
      <div className="issue-list">
        {issues.map((issue, i) => (
          <div className="issue-row" key={issue.title} style={i === 1 ? { background: "rgb(255 255 255 / 0.035)" } : undefined}>
            <StateIcon state={issue.state} />
            <div className="issue-row-main">
              <div className="issue-row-title">
                <a className="issue-title" href="#">
                  {issue.title}
                </a>
                {issue.labels.map(([n, c]) => (
                  <span key={n} className="label-button">
                    <Label name={n!} color={c!} />
                  </span>
                ))}
              </div>
              <div className="issue-meta">{issue.meta}</div>
            </div>
            <div className="issue-row-side">
              {issue.working && (
                <span className="issue-row-activity">
                  <Dots /> OpenCode
                </span>
              )}
              {issue.agent && <AgentAvatar size={20} />}
              <span className="issue-row-comments">
                <CommentIcon size={14} /> {issue.comments}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Conversation() {
  return (
    <div style={{ display: "grid" }}>
      <header className="report" style={{ paddingBottom: 14 }}>
        <div className="report-head">
          <h1 className="report-title" style={{ fontSize: 18, lineHeight: "26px" }}>
            Uploads stall at 99% on Safari 18 <span className="mono report-number">#142</span>
          </h1>
        </div>
        <p className="report-by">
          <Avatar seed="guest-7f3a" name="Alex" size={18} />
          <span>
            <strong className="actor-name">Alex</strong>
            <span className="guest-marker">Guest</span> opened this 3m ago
          </span>
        </p>
        <div className="report-props" style={{ marginTop: 12 }}>
          <button type="button" className="prop">
            <StateIcon state="in_progress" size={14} />
            In progress
            <ChevronDownIcon size={12} />
          </button>
          <button type="button" className="prop">
            <AgentAvatar size={16} />
            <strong className="actor-name">OpenCode</strong>
            <AiBadge />
          </button>
          <button type="button" className="prop" data-labels>
            <Label name="bug" color="fa4d56" />
            <Label name="safari" color="ff832b" />
          </button>
          <button type="button" className="prop">
            <LinkIcon size={14} />1 relation
          </button>
        </div>
      </header>
      <div className="thread" style={{ padding: "8px 0 0" }}>
        <div className="burst">
          <button type="button" className="burst-toggle">
            <span className="burst-icons">
              <span className="event-icon">
                <TagIcon size={14} />
              </span>
              <span className="event-icon">
                <PersonIcon size={14} />
              </span>
              <span className="event-icon" data-tone="in_progress">
                <StateIcon state="in_progress" size={14} />
              </span>
            </span>
            <span className="burst-text">3 updates by Alex, OpenCode · 2m ago</span>
            <ChevronDownIcon size={12} />
          </button>
        </div>
        <section className="group">
          <header className="group-head">
            <span className="group-avatar">
              <AgentAvatar size={20} />
            </span>
            <strong className="actor-name">OpenCode</strong>
            <AiBadge />
            <span className="group-time">1m ago</span>
          </header>
          <div className="group-msg markdown">
            This matches <a href="#">#128</a>. The fix ships in <code>1.4.3</code>.
          </div>
        </section>
        <section className="group">
          <header className="group-head">
            <span className="group-avatar" data-reporter>
              <Avatar seed="guest-7f3a" name="Alex" size={20} />
            </span>
            <strong className="actor-name">Alex</strong>
            <span className="guest-marker">Guest</span>
            <span className="group-time">just now</span>
          </header>
          <div className="group-msg">Thanks, I'll update.</div>
        </section>
        <div className="group typing">
          <header className="group-head">
            <span className="group-avatar">
              <Avatar seed="member-ryan" name="Ryan" size={20} />
            </span>
            <strong className="actor-name">Ryan</strong>
            <span className="role-badge">Owner</span>
            <Dots />
            <span className="typing-text">Writing a reply</span>
          </header>
        </div>
      </div>
      <div className="composer" style={{ position: "static", padding: "10px 0 0", boxShadow: "0 -1px 0 0 var(--border-muted)" }}>
        <div className="guest-bar">
          <span>
            Posting as <strong>Alex</strong>
          </span>
          <span>·</span>
          <button type="button" className="guest-bar-link">
            Change name
          </button>
          <span>·</span>
          <a href="#" className="guest-bar-link">
            Sign in
          </a>
        </div>
        <div className="editor" data-variant="chat">
          <div className="editor-area" style={{ minHeight: 40, color: "var(--fg-faint)" }}>
            Write a reply…
          </div>
          <div className="editor-foot">
            <div className="editor-tools">
              <Button variant="invisible" iconOnly aria-label="Attach file" icon={<PaperclipIcon />} />
              <Button variant="invisible" iconOnly aria-label="Add image" icon={<ImageIcon />} />
              <Button variant="invisible" iconOnly aria-label="Record screen" icon={<RecordIcon />} />
              <Button variant="invisible">Preview</Button>
            </div>
            <div className="editor-actions">
              <Button variant="primary" trailing={<kbd className="kbd">⌘↵</kbd>}>
                Send
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
