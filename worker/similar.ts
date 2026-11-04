import type { IssueRef } from "../shared/api"
import { browserGuest, sessionHash } from "./auth"
import { missing, now, sha256, sql, str, type Ctx } from "./core"
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
  const cookie = browserGuest(c),
    [session, guest] = await Promise.all([sessionHash(c), cookie ? sha256(cookie) : null])
  const r = await sql(
    c.env,
    `WITH scope AS MATERIALIZED (SELECT a.id,s.user_id,m.role FROM apps a LEFT JOIN sessions s ON s.token_hash=? AND s.expires_at>?
      LEFT JOIN members m ON m.app_id=a.id AND m.user_id=s.user_id WHERE a.slug=?),
    hits AS MATERIALIZED (SELECT i.id,i.number,i.title,i.status,i.close_reason,rank score FROM issue_fts JOIN issues i ON i.rowid=issue_fts.rowid JOIN scope ON scope.id=i.app_id
      WHERE issue_fts MATCH ? AND rank MATCH 'bm25(6.0,1.0)' AND (scope.role IS NOT NULL OR (i.hidden IS NULL AND (i.private=0 OR json_extract(i.author,'$.id')=scope.user_id
        OR (scope.user_id IS NULL AND json_extract(i.author,'$.id') IN(SELECT actor_id FROM guest_report_authors WHERE guest_hash=?))))) ORDER BY rank LIMIT 5)
    SELECT hits.id,hits.number,hits.title,hits.status,hits.close_reason FROM scope LEFT JOIN hits ON 1 ORDER BY hits.score,hits.number DESC`,
    session,
    now(),
    c.req.param("slug"),
    tokens.map((t) => `"${t}"*`).join(" OR "),
    guest
  ).all<IssueRef>()
  if (!r.results.length) missing()
  return c.json(r.results.filter((i) => i.id !== null))
}
