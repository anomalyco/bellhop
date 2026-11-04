---
title: Webhooks
nav: Webhooks
description: Get a signed HTTPS POST when issues open, change or get comments in a workspace. Events, payloads, headers, signature checks, retries and redelivery.
---

# Webhooks

A workspace can send a signed JSON `POST` to your server whenever something happens to its issues. Check the signature, skip deliveries you've already handled, and answer `2xx` quickly:

```ts
export default {
  async fetch(req: Request, env: { BELLHOP_WEBHOOK_SECRET: string }) {
    const body = await req.text() // the raw body: the signature covers these exact bytes
    const ok = await verifyBellhop(env.BELLHOP_WEBHOOK_SECRET, req.headers.get("Bellhop-Signature"), body)
    if (!ok) return new Response("Bad signature", { status: 401 })

    const event = JSON.parse(body)
    if (await seen(event.id)) return new Response(null, { status: 204 })
    if (event.type === "issue.opened") await triage(event.issue, event.metadata ?? [])
    return new Response(null, { status: 204 })
  },
}
```

`verifyBellhop` is under [Verify the signature](#verify-the-signature); `seen` and `triage` are yours.

## Set up

Workspace admins set the webhook in **Settings → Webhook**:

- **Payload URL**: an `https` URL on a public domain name. IP addresses, `localhost`, `.local`, `.internal`, `.localdomain`, `.home.arpa` and Bellhop's own hosts aren't allowed, and neither is `user:password@`.
- **Events**: which events to send. A new webhook gets the defaults marked below.
- **Signing secret**: reveal, copy or rotate it. Rotating takes effect at once, so update your server first or accept both for a moment.
- **Send test** sends a `ping` event, which is always delivered whatever you've selected.
- **Recent deliveries** lists the last 50 with their status, response code and attempts, and can **Redeliver** any of them.

Agents with the admin role can do the same with the `get_webhook`, `set_webhook`, `test_webhook`, `redeliver_webhook` and `rotate_webhook_secret` tools.

## Events

{{table:webhook-events}}

`issue.updated` fires for every change and says which fields changed in `changes`: for example `["status", "close_reason"]`, `["labels"]`, `["assignee"]` or `["comment.edited"]`. The specific events fire alongside it if you've selected them. Comments written by agents don't send `comment.created` or `comment.edited`, so an agent that listens to webhooks never wakes itself.

## Payload

Every delivery is one JSON object:

| Field | Present | Description |
| --- | --- | --- |
| `id` | always | The delivery id, the same as the `Bellhop-Delivery` header. A redelivery has a new one. |
| `type` | always | The event. |
| `created_at` | always | When the event happened. A redelivery keeps the original time. |
| `app` | always | The workspace: `id`, `slug`, `name`. |
| `actor` | always | Who did it: a member, a guest or an agent, with their tier if they have one. |
| `mcp_url` | always | The MCP endpoint, for agents that act on the event. |
| `issue` | all but `ping` | The issue as it is after the change, with its `url` and the reporter's language in `reporter_locale`. |
| `comment` | comment events, `mention.created`, comment edits | The comment, including internal notes (`internal: true`). |
| `changes` | `issue.updated` | Which fields changed. |
| `label` | `issue.labeled`, `issue.unlabeled` | The label. |
| `mentioned` | `mention.created` | Who was mentioned: a team member or an agent. |
| `moved_to` | `issue.moved` | Where it went: `slug`, `number`, `url`. |
| `metadata` | `issue.opened`, `comment.created` | Report metadata attached to that post: specs, context, logs and fingerprint matches. |
| `contact` | help desk requests | The requester's contact: `id`, `name`, verified `email`, display-only `unverified_email`, your app's `external_id`, `verified_via` (`host` or `email`), `created_at` and `last_seen_at`. |
| `verification` | `verification.completed` | The email verification: `id`, `email`, `state` (`verified`, `failed` or `expired`), `requested_by`, `created_at` and `verified_at`. The code is never included. |
| `redelivery_of` | redeliveries | The id of the delivery this repeats. |

Webhooks are for the team, so payloads include private issues, internal notes and reporter tiers. Keep them out of anything public.

An `issue.opened` delivery for a report with metadata:

```json
{
  "actor": { "type": "member", "id": "085329df-a2d5-42bf-a4ad-a1b15c742067", "name": "ryan", "avatar_url": null, "role": "owner", "tier": null },
  "issue": {
    "id": "d667e97e-8996-4602-b6b2-993e4dd2b4b0",
    "number": 80,
    "title": "Crash on startup: config.json is a directory",
    "status": "open",
    "close_reason": null,
    "created_at": "2026-11-04T16:49:54.075Z",
    "updated_at": "2026-11-04T16:49:54.075Z",
    "comment_count": 0,
    "votes": 0,
    "viewer_voted": false,
    "pinned": false,
    "locked": false,
    "private": false,
    "hidden": null,
    "author": { "type": "member", "id": "085329df-a2d5-42bf-a4ad-a1b15c742067", "name": "ryan", "avatar_url": null, "role": "owner", "tier": null },
    "assignee": null,
    "activity": null,
    "labels": [],
    "reporter_locale": "en",
    "url": "https://acme.blhp.app/issues/80"
  },
  "app": { "id": "2377e83c-1cb3-4bde-b1de-f10ee8912acb", "slug": "acme", "name": "Acme" },
  "mcp_url": "https://blhp.app/mcp",
  "type": "issue.opened",
  "metadata": [
    {
      "id": "md_947e87d776e850f971022a808ecc8bc9a4934f2e5141ced515fd8249c5a67dba",
      "title": "Crash on startup: config.json is a directory",
      "message": "EISDIR: illegal operation on a directory, read\n    at loadConfig (config.ts:88)",
      "source": { "name": "Acme Desktop", "version": "2.4.1" },
      "system": { "OS": "macOS 15.1", "CPU": "Apple M3", "Memory": "16 GB" },
      "context": { "session": "ses_7f3a91c2", "workspace": "~/dev/acme" },
      "fingerprint": "eisdir-loadconfig-88",
      "created_at": "2026-11-04T16:49:54.048Z",
      "expires_at": null,
      "logs": [
        {
          "id": "ml_77408702-3cbe-4aa7-b1c3-f2002b3ccdbb",
          "name": "main.log",
          "size": 57,
          "kind": "file",
          "mime": "text/plain",
          "url": "/media/ml_77408702-3cbe-4aa7-b1c3-f2002b3ccdbb/main.log?metadata=md_947e87d776e850f971022a808ecc8bc9a4934f2e5141ced515fd8249c5a67dba"
        }
      ],
      "matches": [],
      "attached_to": { "number": 80, "comment_id": null }
    }
  ],
  "id": "2cf308bf-5527-49b2-a935-587dfcaf11cc",
  "created_at": "2026-11-04T16:49:54.083Z"
}
```

Log `url`s are paths on the workspace host and need a team member's session. An agent reads logs with the `get_attachment` tool instead.

## Headers

| Header | Value |
| --- | --- |
| `Content-Type` | `application/json` |
| `Bellhop-Event` | The event type, such as `issue.opened`. |
| `Bellhop-Delivery` | The delivery id, the same as the payload's `id`. |
| `Bellhop-Signature` | `t=<unix seconds>,v1=<signature>`, where the signature is the lowercase hex HMAC-SHA256 of `<t>.<raw body>` keyed with the signing secret. |

## Verify the signature

Compute the HMAC over the timestamp, a dot and the raw body exactly as received, compare it in constant time, and reject old timestamps so a captured request can't be replayed later.

TypeScript, with the Web Crypto API (Workers, Node 18+, Bun, Deno):

```ts
export async function verifyBellhop(secret: string, header: string | null, body: string, toleranceSeconds = 300) {
  const parts = new Map((header ?? "").split(",").map((p) => p.split("=", 2) as [string, string]))
  const t = Number(parts.get("t")), v1 = parts.get("v1") ?? ""
  if (!Number.isInteger(t) || Math.abs(Date.now() / 1000 - t) > toleranceSeconds || !/^[0-9a-f]{64}$/.test(v1)) return false
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"])
  const signature = Uint8Array.from(v1.match(/../g)!, (h) => parseInt(h, 16))
  return crypto.subtle.verify("HMAC", key, signature, enc.encode(`${t}.${body}`))
}
```

Python 3, with the standard library:

```python
import hashlib
import hmac
import time


def verify_bellhop(secret: str, header: str, body: bytes, tolerance: int = 300) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts["t"])
    except (KeyError, ValueError):
        return False
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(secret.encode(), str(t).encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

Use the raw body, not JSON you've parsed and serialized again: any change in spacing or key order breaks the signature.

## Delivery, retries and redelivery

- Bellhop waits up to 10 seconds for an answer. A `2xx` marks the delivery as delivered. Do slow work after you've answered.
- A non-`2xx` answer, a timeout or a network error is retried up to {{webhook.retries}} more times, after {{webhook.backoff}}. After that the delivery is marked failed.
- Redirects aren't followed. A `3xx` fails the delivery at once.
- **Redeliver** in Settings sends the same payload again with a new `id` and `redelivery_of` set to the original. It goes to the URL configured now, and only if the webhook still subscribes to that event.
- Deliveries can arrive more than once and out of order. Use `id` to skip ones you've handled, and `created_at` or the issue's `updated_at` to ignore stale ones.
- Deleting an issue or a comment also deletes stored deliveries that contain it, so they can't be redelivered.
