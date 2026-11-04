import type { IssueRef } from "../shared/api"
import { viewerApp } from "./apps"
import { actorBindings, visibleSQL } from "./visibility"
import { sql, str, type Ctx } from "./core"
import { clientIP, enforce } from "./rate-limits"

const stop = new Set(
  "a an and are as at be but by can cannot could did do does for from had has have how i if in into is it its me my not of on or our so than that the their them then there these they this to was we what when where which while who why will with would you your".split(
    " "
  )
)
export async function similar(c: Ctx) {
  await enforce(c, "RL_TEAM", `similar:${clientIP(c)}`)
  const title = str(c.req.query("title") ?? "", "title", 256, true)
    .normalize("NFKC")
    .toLowerCase()
  const tokens = [...new Set((title.match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => !stop.has(t)))].slice(0, 12)
  if ((tokens.join("").match(/\p{L}/gu)?.length ?? 0) < 3) return c.json([])
  // Quote tokens as literals (never accept MATCH syntax). Title hits outweigh body hits.
  // The B4a index proves guest ownership without a second lookup or trusting an actor ID.
  const { app, viewer } = await viewerApp(c, c.req.param("slug")!)
  const r = await sql(
    c.env,
    `SELECT i.id,i.number,i.title,i.status,i.close_reason FROM issue_fts JOIN issues i ON i.rowid=issue_fts.rowid WHERE i.app_id=? AND issue_fts MATCH ? AND rank MATCH 'bm25(6.0,1.0)' AND ${visibleSQL(viewer)} ORDER BY rank,i.number DESC LIMIT 5`,
    app.id,
    tokens.map((t) => `"${t}"*`).join(" OR "),
    ...actorBindings(viewer)
  ).all<IssueRef>()
  return c.json(r.results)
}
