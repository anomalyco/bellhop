---
title: Report metadata API
nav: Report metadata
description: Upload logs, system specs and context from your app, then open a new-issue page where the person reviews them and writes the report. Limits and errors.
---

# Report metadata

When your app hits an error, it can upload the logs and system details first. Bellhop answers with a link, and your app opens it in the person's browser. That page shows what was attached, lets them remove anything they'd rather not send, and asks what happened. The API never creates an issue on its own.

```sh
curl -X POST https://blhp.app/api/apps/acme/metadata \
  -H "Authorization: Bearer $BELLHOP_REPORT_KEY" \
  -H "Content-Type: application/json" \
  --data @report.json
```

```json
{
  "title": "Crash on startup: config.json is a directory",
  "message": "EISDIR: illegal operation on a directory, read\n    at loadConfig (config.ts:88)",
  "source": { "name": "Acme Desktop", "version": "2.4.1" },
  "system": { "OS": "macOS 15.1", "CPU": "Apple M3", "Memory": "16 GB" },
  "context": { "session": "ses_7f3a91c2", "workspace": "~/dev/acme" },
  "logs": [{ "name": "main.log", "content": "10:42:01 INFO starting\n10:42:02 ERROR EISDIR config.json\n" }],
  "fingerprint": "eisdir-loadconfig-88"
}
```

That's `report.json`. The response is `201 Created`:

```json
{
  "id": "md_e2ecc33e92dc4924c5203a167dfb1d36abfff99dec88c227bbd0b90527c22834",
  "url": "https://acme.blhp.app/new?metadata=md_e2ecc33e92dc4924c5203a167dfb1d36abfff99dec88c227bbd0b90527c22834",
  "expires_at": "2026-11-11T16:48:33.782Z"
}
```

Open `url` in the person's browser. That's the whole integration.

## Create a report key

Workspace admins create keys in **Settings → Report keys**. A key looks like `bh_pub_` followed by 64 hex characters and is shown once, when it's created.

Report keys are publishable. A key can only upload report metadata to its own workspace: it can't read issues, post or change anything. That makes it safe to ship inside a desktop app, a mobile app or a web page. If one leaks or gets abused, revoke it in the same place and ship a new one. A revoked key gets `401 invalid_report_key`.

## Upload metadata

`POST https://blhp.app/api/apps/{slug}/metadata`

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer bh_pub_…` |
| `Content-Type` | `application/json` (exactly; anything else gets `415`) |

The body is a JSON object. Every field is optional.

| Field | Type | Limit | What it's for |
| --- | --- | --- | --- |
| `title` | string | {{report.title}} characters | The suggested issue title, for example the error's first line. The person can change it. |
| `message` | string | {{report.message}} characters | The error message or stack. Shown as a block on the page. |
| `source` | object | `name` and `version` up to {{report.source}} characters each | The app that sent it. `name` is required when `source` is present. Shown as "Attached from Acme Desktop 2.4.1". |
| `system` | object of strings | {{report.fields}} fields; names up to {{report.fieldName}} characters, values up to {{report.systemValue}} | System specs such as `OS`, `CPU`, `GPU`, `Memory`. |
| `context` | object of strings | {{report.fields}} fields; names up to {{report.fieldName}} characters, values up to {{report.contextValue}} | Anything else useful: a session id, the model, a feature flag. |
| `logs` | array of `{ name, content }` | {{report.logs}} logs; `content` up to {{report.log}} each; `name` up to {{report.logName}} characters | Text logs. Names must be unique and can't contain `/`, `\` or control characters. |
| `fingerprint` | string | {{report.fingerprint}} characters | A stable signature of the failure, such as a hash of the stack. Used to suggest matching open issues. |

`system` and `context` together can be up to {{report.sections}}. The whole request can be up to {{report.request}}.

The response fields:

| Field | Description |
| --- | --- |
| `id` | The metadata id, `md_` followed by 64 hex characters. |
| `url` | The new-issue page on the workspace with this metadata attached. Open it in a browser. |
| `expires_at` | When the metadata is deleted if nobody has sent the report by then, {{report.ttlDays}} days after the upload. |

### CORS

This one endpoint can be called from any origin. Responses carry `Access-Control-Allow-Origin: *`, preflight `OPTIONS` requests get `204` with `POST` and the `Authorization` and `Content-Type` headers allowed, and no cookies are used.

## The review page

The `url` opens `https://<slug>.blhp.app/new?metadata=md_…` (a `https://blhp.app/new?metadata=` link redirects there). The person sees:

- an "Attached from" panel with the message, system specs, logs (each opens in a viewer with search) and context;
- a remove button on every item, which deletes it from the metadata before anything is sent;
- the title you suggested, which they can edit, and a description box for what happened.

When they submit, the metadata is attached to the new issue. From then on only the workspace's team, its agents and the reporter can see the logs and specs; other visitors never do. Until it's attached, the id works like a capability: anyone with the link can open the page.

### Fingerprints and matches

If you send a `fingerprint` and an open issue in the workspace already has metadata with the same one, the page says "This might be #34" and offers **Add to #34 instead**. Choosing it attaches the metadata to a comment on that issue rather than opening a new one. Only issues the person is allowed to see are suggested.

### Expiry

Metadata that isn't attached within {{report.ttlDays}} days is deleted, logs included. Opening an expired link shows "This report has expired", and the person can start a blank report instead. Once attached, metadata stays with its issue or comment and doesn't expire.

## Limits

| Limit | Value |
| --- | --- |
| Request body | {{report.request}} |
| Logs per upload | {{report.logs}} |
| One log's content | {{report.log}} |
| Fields in `system` or in `context` | {{report.fields}} each |
| `system` and `context` together | {{report.sections}} |
| Uploads per IP | {{rate:RL_UPLOAD}} |
| Uploads per report key | {{rate:RL_WRITE}} |
| Daily budget per report key | {{report.dailyUploads}} uploads and {{report.dailyBytes}} per UTC day |
| Time to attach | {{report.ttlDays}} days |

The daily budget counts every accepted upload, including ones the person later trims or never sends.

## Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `invalid_input` | The body isn't valid JSON or an object, or a field is the wrong type, empty when it can't be, or too long. The message says which, for example `Invalid title`. |
| 401 | `invalid_report_key` | The `Authorization` header is missing or the key is wrong, revoked or for another workspace. |
| 413 | `too_large` | The request, a log, the number of logs or the `system`/`context` size is over its limit. |
| 415 | `unsupported_media_type` | `Content-Type` isn't `application/json`. |
| 429 | `rate_limited` | Over the per-IP or per-key rate. `Retry-After` says how many seconds to wait. |
| 429 | `report_daily_limit` | The key used up its daily budget. `Retry-After` counts down to midnight UTC. |

```json
{ "error": { "code": "unsupported_media_type", "message": "Expected application/json" } }
```

## From TypeScript

`fetch` works the same in browsers, Node, Bun, Deno and Electron:

```ts
const res = await fetch("https://blhp.app/api/apps/acme/metadata", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${REPORT_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    title: error.message.split("\n")[0],
    message: error.stack,
    source: { name: "Acme Desktop", version: APP_VERSION },
    logs: [{ name: "main.log", content: recentLog }],
    fingerprint: await hash(error.stack),
  }),
})
if (!res.ok) throw new Error((await res.json()).error.message)
const { url } = await res.json()
```

## A crash dialog

The usual pattern: catch the error, upload in the background while showing a dialog, and open the page when the person chooses to report it.

```ts
async function reportCrash(error: Error) {
  // Start the upload right away so the link is ready when they click.
  const upload = fetch("https://blhp.app/api/apps/acme/metadata", {
    method: "POST",
    headers: { Authorization: `Bearer ${REPORT_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      title: error.message,
      message: error.stack,
      source: { name: "Acme Desktop", version: APP_VERSION },
      system: { OS: os.version(), Memory: `${Math.round(os.totalmem() / 2 ** 30)} GB` },
      logs: [{ name: "main.log", content: tail(LOG_FILE, 2000) }],
    }),
  }).then(async (res) => (res.ok ? (await res.json()).url : null))

  const choice = await showDialog("Acme quit unexpectedly", ["Report…", "Close"])
  if (choice !== "Report…") return
  const url = await upload
  // Without a link (offline, or a limit was hit), fall back to a blank report.
  shell.openExternal(url ?? "https://acme.blhp.app/new")
}
```

`os`, `shell`, `showDialog` and `tail` stand in for your platform's APIs; in Electron they're `node:os`, `electron`'s `shell` and `dialog`.
