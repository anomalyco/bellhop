import { cloudflare } from "@cloudflare/vite-plugin"
import react from "@vitejs/plugin-react"
import { defineConfig, type Plugin } from "vite"

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

export default defineConfig({
  plugins: [react(), cloudflare(), fontsAfterAssets],
  // The dev server is shared over the tailnet (https://bellhop.i.vogel.dev).
  server: { allowedHosts: [".i.vogel.dev"] },
})
