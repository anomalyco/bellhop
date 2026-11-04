// Vite features the docs module uses at build time (the Worker is bundled by Vite).
declare module "*?raw" {
  const text: string
  export default text
}
declare module "*?inline" {
  const dataUrl: string
  export default dataUrl
}
interface ImportMeta {
  glob<T>(pattern: string, options: { query: "?raw"; import: "default"; eager: true }): Record<string, T>
}
/** The production Worker config (wrangler.jsonc env.production), parsed by vite.config.ts. */
declare module "virtual:bellhop-production-config" {
  const config: {
    ratelimits: { name: string; simple: { limit: number; period: number } }[]
    queues: { consumers: { queue: string; max_retries: number }[] }
  }
  export default config
}
