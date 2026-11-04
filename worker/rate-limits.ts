import { fail, type Ctx } from "./core"

// CF supplies this at ingress. Never use a caller-provided forwarding chain or guest cookie.
export const clientIP = (c: Ctx) => c.req.header("CF-Connecting-IP") || "unknown"
type Bucket = "RL_UPLOAD" | "RL_HUMAN" | "RL_WRITE" | "RL_IP" | "RL_TEAM" | "RL_AGENT"
export async function allowed(c: Ctx, bucket: Bucket, key: string) {
  if (!c.env.APP_DOMAIN && c.env.DEV_LOGIN === "1" && c.env.RATE_LIMIT_TEST_BYPASS === "1") return true
  return (await c.env[bucket].limit({ key })).success
}
export async function enforce(c: Ctx, bucket: Bucket, key: string) {
  if (!(await allowed(c, bucket, key))) {
    c.header("Retry-After", "60")
    fail(429, "rate_limited", "Too many requests; try again in a minute")
  }
}
export async function workspaceLimit(c: Ctx, slug: string, team: boolean, upload: boolean) {
  const ip = clientIP(c)
  if (upload) return enforce(c, team ? "RL_WRITE" : "RL_UPLOAD", `upload:${team}:${ip}`)
  await enforce(c, team ? "RL_AGENT" : "RL_IP", `write:${team}:${ip}`)
  await enforce(c, team ? "RL_TEAM" : "RL_WRITE", `workspace:${slug}:${ip}`)
}
