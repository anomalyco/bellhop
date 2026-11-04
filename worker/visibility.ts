import type { Comment, IssueSummary } from "../shared/api"

export type Viewer = { team: boolean; actorId: string | null }
export const outsider: Viewer = { team: false, actorId: null }
export const teamViewer: Viewer = { team: true, actorId: null }
export type Gate = { private: boolean; hidden: boolean; reporter: string }
export const gateOf = (i: Pick<IssueSummary, "private" | "hidden" | "author">): Gate => ({
  private: i.private,
  hidden: !!i.hidden,
  reporter: i.author.id
})
export function sees(v: Viewer, g: Gate) {
  return v.team || (!g.hidden && (!g.private || v.actorId === g.reporter))
}
// SQL projection of the same policy. An actor binding is required only for a non-team reporter.
export function visibleSQL(v: Viewer, alias = "i") {
  if (v.team) return "1"
  return `${alias}.hidden IS NULL AND (${alias}.private=0${v.actorId ? ` OR json_extract(${alias}.author,'$.id')=?` : ""})`
}
export const actorBindings = (v: Viewer) => (!v.team && v.actorId ? [v.actorId] : [])
export const seesComment = (v: Viewer, hidden: unknown) => v.team || !hidden
export function commentView(c: Comment, v: Viewer): Comment {
  return {
    ...c,
    ...(!seesComment(v, c.hidden) ? { body: "", attachments: [] } : {}),
    viewer_is_author: c.author.id === v.actorId
  }
}
