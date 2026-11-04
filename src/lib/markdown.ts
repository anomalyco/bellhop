import MarkdownIt, { type Token } from "markdown-it"
import { appPath } from "./site"

// Loaded lazily (see ui/Markdown.tsx) so the list page never pays for the parser.

const md = new MarkdownIt({ html: false, linkify: true, breaks: true })
const escape = md.utils.escapeHtml
const videoExt = /\.(mp4|m4v|webm|mov|ogv)(?:[?#]|$)/i

export const isVideo = (url: string) => url.startsWith("/media/") && videoExt.test(url)

/** A slot the Markdown component fills with Bellhop's own player (ui/VideoPlayer.tsx). */
const video = (src: string) => `<span class="video-slot" data-src="${escape(src)}"></span>`

md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]!
  const src = String(token.attrGet("src") ?? "")
  if (isVideo(src)) return video(src)
  const alt = escape(token.content)
  return `<a class="md-image" href="${escape(src)}" target="_blank" rel="noopener"><img src="${escape(src)}" alt="${alt}" loading="lazy"></a>`
}

const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  const href = String(token.attrGet("href") ?? "")
  if (!href.startsWith("/") && !href.startsWith("#")) {
    token.attrSet("target", "_blank")
    token.attrSet("rel", "noopener noreferrer nofollow")
  }
  return defaultLink(tokens, idx, options, env, self)
}

/** A resolved @mention: a quiet token, never a link (there are no profile pages). */
interface MentionInfo {
  name: string
  agent: boolean
}

/**
 * Links to uploaded videos become players; `#123` becomes a link to that issue in the same app; `@handle` becomes a
 * mention token, but only for handles the server resolved for this body (everything else stays text).
 */
md.core.ruler.after("linkify", "bellhop", (state) => {
  const { slug, mentions } = state.env as { slug?: string; mentions?: Map<string, MentionInfo> }
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue
    const out: Token[] = []
    const children = block.children
    let depth = 0
    for (let i = 0; i < children.length; i++) {
      const t = children[i]!
      if (t.type === "link_open") {
        const href = String(t.attrGet("href") ?? "")
        const close = children.findIndex((c, j) => j > i && c.type === "link_close")
        if (isVideo(href) && close > 0) {
          const html = new state.Token("html_inline", "", 0)
          html.content = video(href)
          out.push(html)
          i = close
          continue
        }
        depth++
      } else if (t.type === "link_close") depth--
      const refs = !!slug && t.content.includes("#")
      const ats = !!mentions?.size && t.content.includes("@")
      if (t.type !== "text" || depth > 0 || (!refs && !ats)) {
        out.push(t)
        continue
      }
      const re = /(^|[^\w&/#@.-])(?:#(\d{1,9})\b|@([a-z0-9][a-z0-9-]{0,62}))/gi
      let last = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(t.content))) {
        const start = m.index + m[1]!.length
        const handle = m[3]?.toLowerCase()
        const mention = handle ? mentions?.get(handle) : undefined
        if (m[2] ? !slug : !mention) continue
        if (start > last) {
          const text = new state.Token("text", "", 0)
          text.content = t.content.slice(last, start)
          out.push(text)
        }
        if (m[2]) {
          const open = new state.Token("link_open", "a", 1)
          open.attrs = [
            ["href", appPath(slug!, `/issues/${m[2]}`)],
            ["class", "issue-ref"],
          ]
          const text = new state.Token("text", "", 0)
          text.content = `#${m[2]}`
          out.push(open, text, new state.Token("link_close", "a", -1))
          last = start + m[2].length + 1
        } else {
          const html = new state.Token("html_inline", "", 0)
          html.content = `<span class="mention"${mention!.agent ? ' data-agent=""' : ""} title="${escape(mention!.name)}">@${escape(handle!)}</span>`
          out.push(html)
          last = start + handle!.length + 1
        }
      }
      if (last === 0) out.push(t)
      else if (last < t.content.length) {
        const text = new state.Token("text", "", 0)
        text.content = t.content.slice(last)
        out.push(text)
      }
    }
    block.children = out
  }
})

export function render(source: string, slug: string, mentions?: { handle: string; name: string; agent: boolean }[]) {
  const map = mentions?.length ? new Map(mentions.map((m) => [m.handle.toLowerCase(), { name: m.name, agent: m.agent }])) : undefined
  return md.render(source, { slug, mentions: map })
}
