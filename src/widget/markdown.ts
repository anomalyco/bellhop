// A tiny, safe Markdown subset for chat messages: paragraphs, line breaks, - and 1. lists, **bold**, *italic* /
// _italic_, `code`, [links](https://…) and bare URLs. Everything becomes DOM nodes with textContent; nothing is ever
// parsed as HTML, and links only open http(s) and mailto.

const safeUrl = (raw: string) => {
  try {
    const u = new URL(raw)
    return ["http:", "https:", "mailto:"].includes(u.protocol) ? u.href : null
  } catch {
    return null
  }
}

function link(href: string, text: string) {
  const a = document.createElement("a")
  a.href = href
  a.target = "_blank"
  a.rel = "noopener noreferrer nofollow"
  a.textContent = text
  return a
}

// One pass over inline text. Order matters: code spans first (their contents are literal), then links, then emphasis.
const inlinePattern =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|(?<![\w])_([^_\n]+)_(?![\w])|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

export function inline(text: string, into: Node) {
  let at = 0
  for (const m of text.matchAll(inlinePattern)) {
    if (m.index! > at) into.appendChild(document.createTextNode(text.slice(at, m.index)))
    const [whole, code, label, url, bold, bold2, em, em2, bare] = m
    if (code !== undefined) {
      const el = document.createElement("code")
      el.textContent = code
      into.appendChild(el)
    } else if (label !== undefined) {
      const href = safeUrl(url!)
      into.appendChild(href ? link(href, label) : document.createTextNode(whole))
    } else if (bold !== undefined || bold2 !== undefined) {
      const el = document.createElement("strong")
      inline(bold ?? bold2!, el)
      into.appendChild(el)
    } else if (em !== undefined || em2 !== undefined) {
      const el = document.createElement("em")
      inline(em ?? em2!, el)
      into.appendChild(el)
    } else if (bare !== undefined) {
      const href = safeUrl(bare)
      into.appendChild(href ? link(href, bare) : document.createTextNode(bare))
    }
    at = m.index! + whole.length
  }
  if (at < text.length) into.appendChild(document.createTextNode(text.slice(at)))
}

/** Renders a message body into a fragment of <p>, <ul> and <ol> blocks. */
export function markdown(source: string): DocumentFragment {
  const out = document.createDocumentFragment()
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  let paragraph: string[] = [],
    list: HTMLElement | null = null
  const flushParagraph = () => {
    if (!paragraph.length) return
    const p = document.createElement("p")
    paragraph.forEach((line, i) => {
      if (i) p.appendChild(document.createElement("br"))
      inline(line, p)
    })
    out.appendChild(p)
    paragraph = []
  }
  for (const line of lines) {
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line),
      numbered = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushParagraph()
      const tag = bullet ? "UL" : "OL"
      if (!list || list.tagName !== tag) {
        list = document.createElement(tag.toLowerCase())
        out.appendChild(list)
      }
      const li = document.createElement("li")
      inline((bullet ?? numbered)![1]!, li)
      list.appendChild(li)
    } else if (!line.trim()) {
      flushParagraph()
      list = null
    } else {
      list = null
      paragraph.push(line)
    }
  }
  flushParagraph()
  return out
}
