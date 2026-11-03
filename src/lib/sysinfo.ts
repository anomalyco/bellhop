import type { SystemInfo } from "../../shared/api"

interface UAData {
  platform?: string
  brands?: { brand: string; version: string }[]
  getHighEntropyValues?(hints: string[]): Promise<{
    platform?: string
    platformVersion?: string
    architecture?: string
    model?: string
    fullVersionList?: { brand: string; version: string }[]
  }>
}

type Nav = Navigator & {
  userAgentData?: UAData
  deviceMemory?: number
  connection?: { effectiveType?: string; downlink?: number; type?: string }
}

function osFromUA(ua: string): string {
  let m: RegExpMatchArray | null
  if ((m = ua.match(/(?:iPhone|CPU) OS (\d+(?:_\d+)*)/))) return `iOS ${m[1]!.replace(/_/g, ".")}`
  if ((m = ua.match(/iPad.*OS (\d+(?:_\d+)*)/))) return `iPadOS ${m[1]!.replace(/_/g, ".")}`
  if ((m = ua.match(/Android (\d+(?:\.\d+)*)/))) return `Android ${m[1]}`
  if ((m = ua.match(/Mac OS X (\d+(?:[._]\d+)*)/))) return `macOS ${m[1]!.replace(/_/g, ".")}`
  if ((m = ua.match(/Windows NT (\d+\.\d+)/))) return m[1] === "10.0" ? "Windows 10 or later" : `Windows NT ${m[1]}`
  if (/CrOS/.test(ua)) return "ChromeOS"
  if (/Linux/.test(ua)) return "Linux"
  return "Unknown"
}

function browserFromUA(ua: string): string {
  const tests: [RegExp, string][] = [
    [/Edg(?:e|A|iOS)?\/([\d.]+)/, "Edge"],
    [/OPR\/([\d.]+)/, "Opera"],
    [/Firefox\/([\d.]+)/, "Firefox"],
    [/FxiOS\/([\d.]+)/, "Firefox"],
    [/CriOS\/([\d.]+)/, "Chrome"],
    [/Chrome\/([\d.]+)/, "Chrome"],
    [/Version\/([\d.]+).*Safari/, "Safari"],
  ]
  for (const [re, name] of tests) {
    const m = ua.match(re)
    if (m) return `${name} ${m[1]}`
  }
  return "Unknown"
}

function osFromHints(platform: string, version: string): string | null {
  if (!platform) return null
  if (platform === "Windows") {
    const major = Number(version.split(".")[0])
    if (!version) return "Windows"
    return major >= 13 ? "Windows 11" : major > 0 ? "Windows 10" : "Windows"
  }
  const name = platform === "macOS" ? "macOS" : platform === "Chrome OS" ? "ChromeOS" : platform
  return version ? `${name} ${version}` : name
}

function gpu(): string | null {
  try {
    const canvas = document.createElement("canvas")
    const gl = (canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl")) as WebGLRenderingContext | null
    if (!gl) return null
    const ext = gl.getExtension("WEBGL_debug_renderer_info")
    const renderer = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "")
    gl.getExtension("WEBGL_lose_context")?.loseContext()
    return renderer || null
  } catch {
    return null
  }
}

/** Everything the reporter can review and trim before it is sent. Keys are the labels shown on the issue. */
export async function collectSystemInfo(): Promise<SystemInfo> {
  const nav = navigator as Nav
  const ua = nav.userAgent
  const info: SystemInfo = {}
  let device = ""
  let os = osFromUA(ua)
  let browser = browserFromUA(ua)
  const data = nav.userAgentData
  if (data?.getHighEntropyValues) {
    try {
      const hints = await data.getHighEntropyValues(["platformVersion", "fullVersionList", "architecture", "model"])
      os = osFromHints(hints.platform ?? data.platform ?? "", hints.platformVersion ?? "") ?? os
      if (hints.architecture && hints.architecture !== "") os += ` (${hints.architecture === "arm" ? "ARM" : hints.architecture})`
      const brands = (hints.fullVersionList ?? []).filter((b) => !/not.?a.?brand/i.test(b.brand))
      const pick = brands.find((b) => b.brand !== "Chromium") ?? brands[0]
      if (pick) browser = `${pick.brand.replace(/^Google /, "").replace(/^Microsoft /, "")} ${pick.version}`
      if (hints.model) device = hints.model
    } catch {
      // Fall back to the user agent string.
    }
  }
  info.OS = os
  info.Browser = browser
  if (device) info.Device = device
  info.Screen = `${screen.width}×${screen.height} @${Math.round(devicePixelRatio * 100) / 100}x`
  info.Viewport = `${innerWidth}×${innerHeight}`
  info.Language = (nav.languages?.length ? nav.languages.slice(0, 3).join(", ") : nav.language) || "Unknown"
  info["Time zone"] = Intl.DateTimeFormat().resolvedOptions().timeZone
  const renderer = gpu()
  if (renderer) info.GPU = renderer
  if (nav.deviceMemory) info.Memory = `${nav.deviceMemory} GB or more`
  if (nav.hardwareConcurrency) info["CPU cores"] = String(nav.hardwareConcurrency)
  const conn = nav.connection
  if (conn?.effectiveType || conn?.type) {
    info.Connection = [conn.type, conn.effectiveType, conn.downlink ? `${conn.downlink} Mb/s` : ""].filter(Boolean).join(", ")
  }
  return info
}
