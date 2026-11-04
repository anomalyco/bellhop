import MarkdownIt from "markdown-it"
import type { IssueStatus, CloseReason } from "../shared/api"
import { sha256, sql } from "./core"
import { firstRow, type Read } from "./read-scope"

export const OG_DESIGN_VERSION = "b10-1"
export const homeTitle = "Bellhop: live support for your product"
const tagline = "Report bugs, ask questions, and get answers from the people who build your product."
export const statuses = {
  open: { name: "Open", color: "#56bf85" },
  in_progress: { name: "In progress", color: "#779bff" },
  waiting: { name: "Waiting", color: "#e5b364" },
  closed: { name: "Closed", color: "#aca6bf" }
} satisfies Record<IssueStatus, { name: string; color: string }>

export type PreviewCard = {
  kind: "home" | "app" | "issue" | "docs"
  appId: string
  name: string
  slug: string
  icon: string | null
  title: string
  description: string
  number: number | null
  status: IssueStatus | null
  labels: { name: string; color: string }[]
  agent: string | null
}
const home: PreviewCard = {
  kind: "home",
  appId: "home",
  name: "Bellhop",
  slug: "",
  icon: null,
  title: homeTitle,
  description: tagline,
  number: null,
  status: null,
  labels: [],
  agent: null
}
type AppRow = {
  app_id: string
  slug: string
  name: string
  description: string
  public: number
  icon_version: string | null
}
type Row = AppRow & {
  number: number | null
  tombstone: number | null
  title: string
  body: string
  status: IssueStatus
  close_reason: CloseReason | null
  created_at: string
  updated_at: string
  reporter: string
  replies: number
  latest: string | null
  labels: string
}
const markdown = new MarkdownIt({ html: true })
export function snippet(body: string, limit = 160) {
  const text = markdown
    .parse(body, {})
    .flatMap((t) =>
      t.type === "inline"
        ? [
            (t.children ?? [])
              .map((c) =>
                c.type === "text" || c.type === "code_inline" ? c.content : c.type.endsWith("break") ? " " : ""
              )
              .join("")
          ]
        : t.type === "fence" || t.type === "code_block"
          ? [t.content]
          : []
    )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  return Array.from(text).slice(0, limit).join("")
}

// No cookies, membership, session, or user-supplied v. Both the HTML and the PNG use this
// projection before consulting any image cache. A hidden row cannot supply a single field.
export async function preview(env: Env, slug: string | null, number: string | null, html: boolean, read?: Read) {
  const cols = "a.id app_id,a.name,a.slug,a.icon_version,a.public,a.description"
  let card = home,
    code: 200 | 404 | 410 = 200,
    listed = true,
    reason: CloseReason | null = null
  let article: { published: string; modified: string; reporter: string; summary: string; description: string } | null =
    null
  if (slug !== null) {
    const row =
      number === null
        ? await firstRow<AppRow>(sql(env, `SELECT ${cols} FROM apps a WHERE a.slug=?`, slug), read)
        : await firstRow<Row>(
            sql(
              env,
              `SELECT ${cols},i.number,i.title,i.status,i.close_reason,i.created_at,i.updated_at,
        ${html ? "i.body,coalesce(json_extract(i.author,'$.name'),json_extract(i.author,'$.handle'),'Guest') reporter,(SELECT count(*) FROM comments WHERE issue_id=i.id AND internal=0 AND hidden IS NULL) replies," : ""}
        (SELECT author FROM comments WHERE issue_id=i.id AND internal=0 AND hidden IS NULL ORDER BY created_at DESC,rowid DESC LIMIT 1) latest,
        (SELECT json_group_array(json_object('name',l.name,'color',l.color) ORDER BY l.name,l.id) FROM issue_labels il JOIN labels l ON l.id=il.label_id WHERE il.issue_id=i.id) labels,
        t.number tombstone FROM apps a LEFT JOIN issues i ON i.app_id=a.id AND i.number=?1 AND i.private=0 AND i.hidden IS NULL
        LEFT JOIN public_issue_tombstones t ON t.app_id=a.id AND t.number=?1 WHERE a.slug=?2`,
              number,
              slug
            ),
            read
          )
    if (!row) {
      code = 404
      listed = false
    } else {
      listed = !!row.public
      card = {
        ...home,
        kind: "app",
        appId: row.app_id,
        name: row.name,
        slug: row.slug,
        icon: row.icon_version,
        title: `${row.name} support`,
        description: row.description.trim() || `Report bugs and ask ${row.name} questions`
      }
      if ("number" in row) {
        const i = row as Row
        if (i.number === null) {
          code = i.tombstone ? 410 : 404
          listed = false
        } else if (listed) {
          const latest = i.latest ? JSON.parse(i.latest) : null
          card = {
            ...card,
            kind: "issue",
            title: i.title,
            description: "",
            number: i.number,
            status: i.status,
            labels: JSON.parse(i.labels),
            agent: latest?.type === "agent" ? latest.name : null
          }
          reason = i.close_reason
          if (html) {
            const summary = `${statuses[i.status].name} · ${i.replies} ${i.replies === 1 ? "reply" : "replies"}`
            article = {
              published: i.created_at,
              modified: i.updated_at,
              reporter: i.reporter,
              summary,
              description: snippet(i.body) || summary
            }
          }
        }
      }
    }
  }
  const v = (
    await sha256(
      JSON.stringify([
        card.kind === "issue" ? card.title : card.description,
        card.status,
        reason,
        card.labels.map((l) => [l.name, l.color]),
        card.name,
        card.icon,
        OG_DESIGN_VERSION
      ])
    )
  ).slice(0, 8)
  // The specified v has no reply-author input. Keep it stable and vary the image URL on
  // this one additional pixel input so an immutable card never retains an old AI attribution.
  const reply = card.agent ? (await sha256(card.agent)).slice(0, 8) : ""
  return { card, code, listed, article, v, reply }
}
