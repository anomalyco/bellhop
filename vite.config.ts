import { cloudflare } from "@cloudflare/vite-plugin"
import react from "@vitejs/plugin-react"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { build, defineConfig, type Manifest, type Plugin, type Rolldown } from "vite"

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

// The embeddable chat widget and the public SDK are standalone bundles (no chunks shared with the app): the widget
// as a classic script any site can load, the SDK as one ES module. Built here, emitted into the client's assets with
// content hashes, and announced to the Worker (worker/widget.ts) through the same index.html hints as below.
const embeds: Record<string, string> = {}
const embedBundles: Plugin = {
  name: "bellhop-embed-bundles",
  apply: "build",
  applyToEnvironment: (env) => env.name === "client",
  async generateBundle() {
    for (const [name, entry, format] of [
      ["widget", "src/widget/main.ts", "iife"],
      ["sdk", "src/sdk/index.ts", "es"],
    ] as const) {
      const out = (await build({
        configFile: false,
        logLevel: "warn",
        plugins: [],
        build: { write: false, minify: true, emptyOutDir: false, lib: { entry, formats: [format], name: "BellhopEmbed", fileName: name } },
      })) as Rolldown.RolldownOutput[]
      const chunk = out.flatMap((o) => o.output).find((o) => o.type === "chunk")
      if (!chunk || chunk.type !== "chunk") throw new Error(`No ${name} bundle`)
      const fileName = `assets/${name}-${createHash("sha256").update(chunk.code).digest("base64url").slice(0, 10)}.js`
      this.emitFile({ type: "asset", fileName, source: chunk.code })
      embeds[name] = fileName
    }
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
        // worker/widget.ts serves the stable loader URLs from these.
        hint("widget-script", embeds.widget),
        hint("sdk-script", embeds.sdk),
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
  plugins: [react(), cloudflare(), fontsAfterAssets, embedBundles, routePreloadHints, productionConfig],
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
