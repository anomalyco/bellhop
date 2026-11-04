import { homeUrl } from "../../lib/site"

/** The public developer docs are server-rendered pages on the home site, never an in-app route. */
export function DocsLink({ page }: { page: "reports" | "mcp" | "webhooks" }) {
  return (
    <a className="btn" data-variant="invisible" data-size="small" href={homeUrl(`/docs/${page}`)} target="_blank" rel="noopener">
      Docs ↗
    </a>
  )
}
