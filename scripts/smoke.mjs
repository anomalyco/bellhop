// Load real production pages in Chromium; exit 1 if any page throws, logs a console error, or gets HTML for a script.
// OVERRIDE_VERSION=<version id> routes our own hosts to that Worker version via Cloudflare-Workers-Version-Overrides,
// so a 0% version can be tested before it takes traffic (third-party hosts never get the header: CORS rejects it).
import { chromium } from "playwright-core"
import { tmpdir } from "node:os"
const override = process.env.OVERRIDE_VERSION
const pages = [
  ["https://bellhop.blhp.app/issues/1", "issue", 1440],
  ["https://bellhop.blhp.app/", "list", 390],
  ["https://blhp.app/", "feed", 390],
  ["https://blhp.app/signin", "signin", 390],
  ["https://blhp.app/docs", "docs", 1440],
]
const browser = await chromium.launch()
let failed = 0
for (const [url, name, w] of pages) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w > 500 ? 900 : 844 }, deviceScaleFactor: w > 500 ? 1 : 2 })
  if (override)
    await ctx.route("**/*", (route) => {
      const host = new URL(route.request().url()).hostname
      if (host !== "blhp.app" && !host.endsWith(".blhp.app")) return route.continue()
      return route.continue({ headers: { ...route.request().headers(), "cloudflare-workers-version-overrides": `bellhop="${override}"` } })
    })
  const page = await ctx.newPage()
  const errors = []
  page.on("pageerror", (e) => errors.push(e.message))
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()))
  page.on("response", (r) => {
    const ct = r.headers()["content-type"] || ""
    if (r.request().resourceType() === "script" && !ct.includes("javascript")) errors.push(`script as ${ct}: ${r.url()}`)
  })
  const res = await page.goto(url, { waitUntil: "load" })
  await page.waitForTimeout(2000)
  const text = (await page.evaluate(() => document.body.innerText)).trim()
  if (!res || res.status() >= 500) errors.push(`status ${res?.status()}`)
  if (text.length < 20) errors.push("blank page")
  await page.screenshot({ path: `${process.env.SMOKE_DIR || tmpdir()}/bellhop-smoke-${name}${override ? "-candidate" : ""}.png` })
  console.log(`${errors.length ? "FAIL" : "ok  "} ${name} ${url}${errors.length ? " " + JSON.stringify(errors.slice(0, 3)) : ""}`)
  if (errors.length) failed++
  await ctx.close()
}
await browser.close()
process.exit(failed ? 1 : 0)
