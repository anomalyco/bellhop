import type { IssueSort } from "../shared/api"
import { str } from "./core"

export const sorts = ["newest", "oldest", "updated", "votes", "comments"] as const
type Term = { key: "is" | "status" | "reason" | "label" | "no" | "assignee" | "author" | "has"; value: string }
export function parseSearch(input: unknown, feed = false) {
  const q = input === undefined ? "" : str(input, "query", 512, true),
    terms: Term[] = [],
    text: string[] = []
  let sort: IssueSort | undefined, tab: "closed" | "open" | undefined
  for (const [token] of q.matchAll(/(?:[^\s"]+|"[^"]*")+|\S+/g)) {
    const split = /^([a-z]+):(?:"([^"]+)"|([^\s"]+))$/i.exec(token)
    if (!split) {
      text.push(token)
      continue
    }
    const key = split[1]!.toLowerCase(),
      value = (split[2] ?? split[3])!.toLowerCase()
    if (key === "sort" && sorts.some((s) => s === value)) {
      sort = value as IssueSort
      continue
    }
    if (key === "is" && ["open", "closed", "private", "locked", "pinned", "hidden"].includes(value)) {
      if (value === "open" || value === "closed") tab = value
    } else if (key === "status" && ["open", "in_progress", "waiting", "closed"].includes(value))
      tab = value === "closed" ? "closed" : "open"
    else if (key === "reason" && !feed && ["completed", "not_planned", "duplicate"].includes(value)) tab = "closed"
    else if (!(
      key === "label" ||
      (key === "no" && ["label", "assignee"].includes(value)) ||
      (key === "has" && value === "metadata") ||
      (!feed && (key === "assignee" || key === "author") && /^@?[a-z0-9][a-z0-9-]*$/.test(value))
    )) {
      text.push(token)
      continue
    }
    terms.push({ key: key as Term["key"], value: key === "label" ? (split[2] ?? split[3])! : value })
  }
  return { terms, text: text.join(" "), sort, tab }
}
