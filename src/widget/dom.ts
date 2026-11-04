// Small DOM helpers: the widget renders with plain elements (no framework) to stay small.
type Child = Node | string | null | undefined | false
type Attrs = Record<string, string | number | boolean | null | undefined | EventListener>

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v as EventListener)
    else if (k === "class") el.className = String(v)
    else if (v === true) el.setAttribute(k, "")
    else el.setAttribute(k, String(v))
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c)
  return el
}

const svg = (paths: string, viewBox = "0 0 24 24") => {
  const t = document.createElement("template")
  t.innerHTML = `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  return t.content.firstChild as SVGElement
}
// Static, trusted markup only (no message content ever goes through innerHTML).
export const icons = {
  chat: () => svg('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4h0A1.5 1.5 0 0 1 4 14.5z"/>'),
  close: () => svg('<path d="M6 6l12 12M18 6 6 18"/>'),
  down: () => svg('<path d="m6 9 6 6 6-6"/>'),
  back: () => svg('<path d="M15 5l-7 7 7 7"/>'),
  send: () => svg('<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>'),
  plus: () => svg('<path d="M12 5v14M5 12h14"/>'),
}
