import { cloudflare } from "@cloudflare/vite-plugin"
import react from "@vitejs/plugin-react"
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
      ]
      html.source = html.source.replace("</head>", hints.join("") + "</head>")
    },
  },
}

export default defineConfig({
  plugins: [react(), cloudflare(), fontsAfterAssets, routePreloadHints],
  environments: { client: { build: { manifest: true } } },
  // The dev server is shared over the tailnet (https://bellhop.i.vogel.dev).
  server: { allowedHosts: [".i.vogel.dev"] },
})
