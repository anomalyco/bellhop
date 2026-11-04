import { cloudflare } from "@cloudflare/vite-plugin"
import react from "@vitejs/plugin-react"
import { readFileSync } from "node:fs"
import { defineConfig, type Manifest, type Plugin } from "vite"

/** Keeps Vite's injected stylesheet and entry module ahead of font preloads in <head>. */
const fontsAfterAssets: Plugin = {
  name: "bellhop-font-preload-order",
  enforce: "post",
  transformIndexHtml(html) {
    const fonts: string[] = []
    const stripped = html.replace(/\s*<link\b[^>]*\brel="preload"[^>]*\bas="font"[^>]*>/g, (tag) => {
      fonts.push(tag.trim())
      return ""
    })
    return fonts.length ? stripped.replace("</head>", `    ${fonts.join("\n    ")}\n  </head>`) : html
  },
}

// Cloudflare builds the Worker before the client. Carry this build's manifest
// entries in the HTML asset the Worker already reads; without rel these are inert.
const routePreloadHints: Plugin = {
  name: "bellhop-route-preload-hints",
  apply: "build",
  applyToEnvironment: (env) => env.name === "client",
  generateBundle: {
    order: "post",
    handler(_, bundle) {
      const asset = bundle[".vite/manifest.json"],
        html = bundle["index.html"]
      if (asset?.type !== "asset" || html?.type !== "asset" || typeof html.source !== "string") return
      const manifest: Manifest = JSON.parse(
        typeof asset.source === "string" ? asset.source : new TextDecoder().decode(asset.source),
      )
      const player = manifest["src/ui/VideoPlayer.tsx"]
      const hint = (kind: string, file?: string) =>
        file && bundle[file] ? `<link data-bh-preload="${kind}" href="/${encodeURI(file)}">` : ""
      const hints = [
        hint("markdown", manifest["src/lib/markdown.ts"]?.file),
        hint("video", player?.file),
        ...(player?.css ?? []).map((file) => hint("video-style", file)),
        // Server-rendered docs (worker/docs.ts) link these directly.
        hint("docs-script", manifest["src/docs/main.ts"]?.file),
        hint("docs-style", manifest["src/styles/docs.css"]?.file),
      ]
      html.source = html.source.replace("</head>", hints.join("") + "</head>")
    },
  },
}

// The public docs (worker/docs-content.ts) print rate limits and retries from the production
// config. wrangler.jsonc can't be imported directly, so this parses it at build time.
const productionConfig: Plugin = {
  name: "bellhop-production-config",
  resolveId: (id) => (id === "virtual:bellhop-production-config" ? "\0" + id : undefined),
  load(id) {
    if (id !== "\0virtual:bellhop-production-config") return
    this.addWatchFile("wrangler.jsonc")
    const strip = (s: string, pattern: RegExp) => s.replace(pattern, (m, str?: string) => str ?? "")
    const code = strip(readFileSync("wrangler.jsonc", "utf8"), /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g)
    const { ratelimits, queues } = JSON.parse(strip(code, /("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/g)).env.production
    return `export default ${JSON.stringify({ ratelimits, queues })}`
  },
}

export default defineConfig({
  plugins: [react(), cloudflare(), fontsAfterAssets, routePreloadHints, productionConfig],
  environments: {
    client: {
      build: {
        manifest: true,
        rolldownOptions: { input: { index: "index.html", docs: "src/docs/main.ts", "docs-style": "src/styles/docs.css" } },
      },
    },
  },
  // The dev server is shared over the tailnet (https://bellhop.i.vogel.dev).
  server: { allowedHosts: [".i.vogel.dev"] },
})
