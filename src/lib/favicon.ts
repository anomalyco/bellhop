// On an app's pages the tab shows the app's icon; everywhere else Bellhop's own.
const defaults = { icon: "/favicon.svg", type: "image/svg+xml", touch: "/apple-touch-icon.png" }

function link(rel: string) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`)
  if (!el) {
    el = document.createElement("link")
    el.rel = rel
    document.head.appendChild(el)
  }
  return el
}

/** Points the favicon and the home-screen icon at `url`, or back at Bellhop's with null. */
export function setFavicon(url: string | null) {
  const icon = link("icon")
  const touch = link("apple-touch-icon")
  if (url) {
    if (icon.getAttribute("href") === url) return
    icon.removeAttribute("type")
    icon.href = url
    touch.href = url
  } else {
    if (icon.getAttribute("href") === defaults.icon) return
    icon.type = defaults.type
    icon.href = defaults.icon
    touch.href = defaults.touch
  }
}
