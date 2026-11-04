import { Widget, type WidgetEvent, type WidgetOptions } from "./widget"

// The widget's entry: turns the loader's call queue into the real `Bellhop` API.
//
//   <script src="https://blhp.app/widget/v1.js" data-key="bh_pk_…" async></script>
//   Bellhop.init({ key, identityToken?, sessionToken?, locale?, theme?, position? })
//   Bellhop.identify(token) · open() · close() · newConversation({ subject?, message?, metadataId? })
//   Bellhop.on("unread" | "open" | "close", fn) · logout()

type Defaults = { apiBase?: string; turnstileSiteKey?: string; key?: string; locale?: string; theme?: string; position?: string }
type Stub = { q?: unknown; _c?: Defaults; version?: string }
const w = window as unknown as { Bellhop?: Stub & Record<string, unknown> }
const stub: Stub = w.Bellhop ?? {}
const defaults = stub._c ?? {}
let widget: Widget | null = null
const early: [string, unknown[]][] = []

const api = {
  version: "1.0.0",
  init(options: WidgetOptions) {
    if (!options?.key) throw new Error("Bellhop.init: `key` (a bh_pk_… publishable key) is required")
    widget?.destroy()
    widget = new Widget({ baseUrl: defaults.apiBase, turnstileSiteKey: defaults.turnstileSiteKey, ...options })
    for (const [name, args] of early.splice(0)) call(name, args)
  },
  identify: (token: string) => widget!.identify(token),
  open: () => widget!.open(),
  close: () => widget!.close(),
  toggle: () => widget!.toggle(),
  newConversation: (input?: { subject?: string; message?: string; metadataId?: string }) => widget!.newConversation(input),
  on: (event: WidgetEvent, fn: (data?: unknown) => void) => widget!.on(event, fn),
  logout: () => widget!.logout(),
}
type Name = Exclude<keyof typeof api, "version">

/** Runs one queued or early call. Unknown names and failing calls are reported and skipped, never thrown, so one
 *  bad entry can't drop the calls queued after it. */
function call(name: unknown, args: unknown) {
  if (typeof name !== "string" || !Object.hasOwn(api, name) || typeof (api as Record<string, unknown>)[name] !== "function") return console.warn(`[chat] unknown call Bellhop.${String(name)}`)
  if (name !== "init" && !widget) return void early.push([name, Array.isArray(args) ? args : []])
  try {
    return (api[name as Name] as (...a: unknown[]) => unknown)(...(Array.isArray(args) ? args : []))
  } catch (e) {
    console.error(`[chat] Bellhop.${name} failed:`, e)
  }
}

const queued: unknown[] = Array.isArray(stub.q) ? stub.q : []
w.Bellhop = Object.assign(api, { q: undefined, _c: defaults }) as unknown as Stub & Record<string, unknown>
if (defaults.key && !queued.some((e) => Array.isArray(e) && e[0] === "init"))
  call("init", [{ key: defaults.key, locale: defaults.locale, theme: defaults.theme as WidgetOptions["theme"], position: defaults.position as WidgetOptions["position"] }])
for (const entry of queued) call(Array.isArray(entry) ? entry[0] : undefined, Array.isArray(entry) ? entry[1] : undefined)
