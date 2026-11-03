import { cloudflare } from "@cloudflare/vite-plugin"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), cloudflare()],
  // The dev server is shared over the tailnet (https://bellhop.i.vogel.dev).
  server: { allowedHosts: [".i.vogel.dev"] },
})
