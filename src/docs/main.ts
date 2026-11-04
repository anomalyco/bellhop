// The docs pages are complete without JavaScript. This only adds copy buttons to code blocks
// and keeps the current page visible in the phone nav, which scrolls sideways.
for (const button of document.querySelectorAll<HTMLButtonElement>(".code-block button.copy")) {
  const code = button.closest(".code-block")?.querySelector("pre > code")
  if (!code || !navigator.clipboard) continue
  let timer = 0
  button.hidden = false
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code.textContent ?? "")
      button.textContent = "Copied"
    } catch {
      button.textContent = "Couldn't copy"
    }
    clearTimeout(timer)
    timer = window.setTimeout(() => (button.textContent = "Copy"), 1600)
  })
}

const nav = document.querySelector<HTMLElement>(".side > ul")
const current = nav?.querySelector<HTMLElement>(':scope > li > a[aria-current="page"]')
if (nav && current && nav.scrollWidth > nav.clientWidth) {
  nav.scrollLeft = current.offsetLeft - (nav.clientWidth - current.offsetWidth) / 2
}
