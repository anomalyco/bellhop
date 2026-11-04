---
title: Public API
nav: Public API
description: Build on the help desk API v1: keys, end-user sessions, conversations, uploads, realtime and the server API, with a reference generated from OpenAPI.
---

# Public API

The help desk API (v1) is what the [chat widget](/docs/widget) is built on, so anything the widget does, your own code can do too. Your server signs in one of your users with a secret key, and their browser or app uses the session token it gets back:

```sh
curl -X POST https://api.blhp.app/v1/sessions \
  -H "Authorization: Bearer $BELLHOP_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"user": {"id": "user_8412", "email": "dana@example.com", "email_verified": true, "name": "Dana Lee"}}'
```

```json
{
  "token": "bh_us_EXAMPLE_SESSION_TOKEN",
  "expires_at": "2026-11-05T21:01:50.000Z",
  "user": {
    "id": "ct_18ddac26-429d-4400-80e0-72c003ff0217",
    "name": "Dana Lee",
    "email": "dana@example.com",
    "external_id": "user_8412",
    "verified_via": "host",
    "locale": "en",
    "anonymous": false
  }
}
```

Then, with that token, Dana opens a conversation:

```sh
curl -X POST https://api.blhp.app/v1/conversations \
  -H "Authorization: Bearer $SESSION" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-4821-message-1" \
  -d '{"message": {"body": "My invoice for October is wrong: it says $120, it should be $100."}}'
```

```json
{
  "id": "67e9902b-2fe4-4e60-bd94-17745a010358",
  "number": 70,
  "subject": "My invoice for October is wrong: it says $120, it should be $100.",
  "status": "open",
  "close_reason": null,
  "created_at": "2026-11-04T21:01:51.012Z",
  "updated_at": "2026-11-04T21:01:51.012Z",
  "assignee": null,
  "last_item": {
    "id": "67e9902b-2fe4-4e60-bd94-17745a010358",
    "created_at": "2026-11-04T21:01:51.012Z",
    "kind": "message",
    "message": {
      "id": "67e9902b-2fe4-4e60-bd94-17745a010358",
      "created_at": "2026-11-04T21:01:51.012Z",
      "conversation_id": "67e9902b-2fe4-4e60-bd94-17745a010358",
      "author": { "type": "user", "id": "ct_18ddac26-429d-4400-80e0-72c003ff0217", "name": "Dana Lee" },
      "body": "My invoice for October is wrong: it says $120, it should be $100.",
      "edited_at": null,
      "attachments": []
    }
  },
  "unread": 0,
  "request_type": null,
  "fields": {},
  "verifications": []
}
```

The API is for workspaces in help desk mode. A conversation is a help desk request: the team sees it as request #70 and answers it like any other.

## Basics

- **Base URL:** `https://api.blhp.app/v1`. Every workspace host answers on `/v1` too, for example `https://acme.blhp.app/v1`.
- **Format:** JSON in and out, with times in ISO 8601. Lists are pages: `{ "data": [...], "next_cursor": "…" }`. Pass `next_cursor` back as `cursor` for the next page; it's `null` on the last one.
- **Stability:** within v1, fields and routes are only ever added, never renamed or removed. Ignore fields you don't know.
- **White label:** end users never see "Bellhop". Team members and agents appear as the workspace presents them.
- **OpenAPI:** [`GET /v1/openapi.json`](https://api.blhp.app/v1/openapi.json) describes every route. The [reference](#reference) below is generated from it.

## Keys

Workspace admins create keys in **Settings → API keys**. There are two kinds:

| Key | Looks like | Where it goes | What it can do |
| --- | --- | --- | --- |
| Publishable | `bh_pk_…` | Browsers and apps | Read the workspace's name and sign-in options, and start end-user sessions. Only from its allowed origins. |
| Secret | `bh_sk_…` | Your server only | Start sessions for your own users, and use the [server API](#server-api). Shown once. |

A publishable key works only from the exact origins you allow, such as `https://app.example.com`: no paths, no wildcards, and `http` only for `localhost`. A request whose `Origin` doesn't match is refused, so a copied key is no use on another site. The workspace's own site, `https://<slug>.blhp.app`, is always allowed.

A secret key is refused whenever the request has an `Origin` header. Browsers always send one on cross-origin calls, so a secret key that leaks into a page doesn't work there. Keep it on your server, and revoke it in Settings if it leaks: whatever uses it stops at once, and sessions it started end.

## End-user sessions

Everything a person does goes through a session: `Authorization: Bearer bh_us_…`. A session is one contact in one workspace. It uses no cookies, so it works in iframes, third-party embeds and native apps. There are four ways to start one:

| How | Credential | Body | When |
| --- | --- | --- | --- |
| Your server vouches for the user | Secret key | `{ "user": { "id", "email"?, "email_verified"?, "name"?, "locale"? } }` | Your app has signed-in users. The best option. |
| An identity token from your server | Publishable key | `{ "identity_token": "…" }` | Your server can sign a short-lived token but shouldn't call Bellhop itself. See [Identity](/docs/identity). |
| An email code | Publishable key | `POST /v1/sessions/email`, then `POST /v1/sessions/email/verify` | Visitors without an account, on the workspace's own site. |
| Anonymously | Publishable key | `{ "anonymous": true, "turnstile_token": "…" }` | The workspace allows anonymous chats, on its own site. |

`user.id` is your user id. It becomes the contact's `external_id`, so the same person finds the same conversations on every device. Send `email_verified: true` only for an address your app has verified; an unverified email is kept for display and never used to match or reach anyone.

Email codes and anonymous sessions need a [Turnstile](https://developers.cloudflare.com/turnstile/) token, and the workspace's human check only runs on its own origin. On any other origin, `GET /v1/workspace` returns `turnstile_site_key: null`, so a page on your site can't offer those sign-ins. Sign people in through your server there.

### Lifetime and refresh

A session lasts {{v1.session}}. `POST /v1/session/refresh` swaps it for a new token valid for up to {{v1.session}} more, and the old token and its realtime sockets stop working at once. Sessions can be refreshed until {{v1.sessionCap}} after the first sign-in; after that, start a new one. Refresh before `expires_at`: an expired token can't be refreshed.

```sh
curl -X POST https://api.blhp.app/v1/session/refresh \
  -H "Authorization: Bearer $SESSION"
```

```json
{
  "token": "bh_us_EXAMPLE_SESSION_TOKEN",
  "expires_at": "2026-11-05T21:02:00.000Z",
  "user": {
    "id": "ct_18ddac26-429d-4400-80e0-72c003ff0217",
    "name": "Dana Lee",
    "email": "dana@example.com",
    "external_id": "user_8412",
    "verified_via": "host",
    "anonymous": false,
    "locale": "en"
  }
}
```

Only one refresh can win. If two tabs share a token, let one refresh it and hand the new token to the others (for example through `localStorage`), and never retry with the old token. Anonymous sessions can't be refreshed; they get `403 verification_required`.

### Linking existing contacts

Someone may have written in by email before your app vouched for them. By default, a verified email from your server does **not** connect them to that earlier email-only contact: your system saying someone owns an address isn't enough to hand them its private history. The new user gets their own contact, and the address is kept as display-only `unverified_email` until the conflict is resolved.

Add `"link_existing": true` (next to `email_verified: true`) when you have verified the address yourself and want this user to see the requests they made earlier by email. It links only to a contact that has no `external_id` yet, and a user you've already linked always keeps their own contact. Identity tokens take the same claim, and `PUT /v1/contacts/by-external-id/:id` follows the same rules.

### Email sign-in

`POST /v1/sessions/email` with `{ email, turnstile_token }` sends a 6-digit code, and its response has a `Challenge-Token` header. Keep that value in the same browser and send it back, with the code, to `POST /v1/sessions/email/verify`. A code entered anywhere else fails. Codes last 10 minutes and allow 5 tries.

If the visitor has an anonymous session, send both calls with its bearer as well. Its conversations then move to the verified contact, and the anonymous session ends.

## Conversations and messages

A session sees only its own conversations, with public messages and events. `GET /v1/conversations/:id/items` returns the timeline: `kind: "message"` items, and `kind: "event"` items for status changes, assignments and verification requests.

To open a thread at the newest messages, ask for the last few with `last`:

```sh
curl "https://api.blhp.app/v1/conversations/$CONVERSATION/items?last=2" \
  -H "Authorization: Bearer $SESSION"
```

```json
{
  "data": [
    {
      "id": "67e9902b-2fe4-4e60-bd94-17745a010358",
      "created_at": "2026-11-04T21:01:51.012Z",
      "kind": "message",
      "message": {
        "id": "67e9902b-2fe4-4e60-bd94-17745a010358",
        "created_at": "2026-11-04T21:01:51.012Z",
        "conversation_id": "67e9902b-2fe4-4e60-bd94-17745a010358",
        "author": { "type": "user", "id": "ct_18ddac26-429d-4400-80e0-72c003ff0217", "name": "Dana Lee" },
        "body": "My invoice for October is wrong: it says $120, it should be $100.",
        "edited_at": null,
        "attachments": []
      }
    }
  ],
  "next_cursor": null
}
```

| To | Ask for | Order |
| --- | --- | --- |
| Open at the newest | `?last=30` (1–100) | Display order, oldest of the page first |
| Load older ones | `?cursor=<next_cursor>`, or `?before=<item id>&last=30` | Display order; `next_cursor` keeps going back |
| Read everything | no parameters, then `?cursor=<next_cursor>` | Oldest first |
| Catch up after a gap | `?after=<last item id you have>` | Oldest first |

Don't combine `after` with `last` or `before`.

Send messages with `POST /v1/conversations/:id/messages` and `{ "body": "…", "attachments": ["<upload id>"] }`. Bodies are Markdown. `POST …/read` with `{ item_id }` marks everything up to that item as read; `unread` on a conversation counts messages from others and verification requests after that mark. `POST …/typing` shows the team that the person is typing for a few seconds.

When the team asks someone to prove an address ("the email on your billing account"), the conversation's `verifications` lists it and a `verification_requested` event appears. The person enters the code with `POST …/verifications/:vid/confirm`.

## Uploads

Upload a file with `POST /v1/uploads`, as `multipart/form-data` with one part named `file`, and put the returned `id` in a message's `attachments` within 24 hours.

| Limit | Value |
| --- | --- |
| Images | {{v1.uploadImage}} each |
| Videos | {{v1.uploadVideo}} each; the content must be a known video container |
| Other files | {{v1.uploadFile}} each |
| Uploads per person | {{rate:RL_UPLOAD}}, and {{v1.uploadsPerHour}} per hour |
| Bytes per day | {{v1.uploadContactDaily}} per person, {{v1.uploadWorkspaceDaily}} per workspace (UTC day) |

Errors you should show kindly: `413 too_large` (one file is over its limit), `413 upload_byte_quota` (today's budget is used up), `415 unsupported_video` (a "video" that isn't one) and `429 rate_limited`.

### Signed media URLs

An attachment's `url` is signed for that person and file, and works for {{v1.mediaTtl}} without a token, so it can go straight into an `<img>` or a download link. That convenience is a tradeoff: anyone the URL is copied to can open it until it expires. Each request still checks that the person exists and the message is visible, so erasing the contact or hiding the message stops the URL at once. Fetch the conversation again for fresh URLs after they expire.

## Realtime

`POST /v1/realtime` returns a single-use `wss://` URL, valid for {{v1.ticketTtl}}. Open it unchanged. The socket sends one JSON frame per event, for all of the person's conversations:

| `type` | When |
| --- | --- |
| `item.created` | A message or event was added. `item` is the full item. |
| `message.updated` | A message was edited. |
| `conversation.updated` | The conversation changed, for example its status. `conversation` is the whole conversation. |
| `typing` | A team member is typing a public reply. |
| `activity` | An agent is working on it: `text` is a short status such as "Looking up your invoice…", and `null` when it's done. |

Send the text `ping` every 25 seconds; the server answers `pong`, which is a heartbeat, not a JSON event. When the socket closes with code `4401`, the session is no longer valid: sign in again rather than reconnecting.

Events aren't replayed. To reconnect without missing anything:

1. Get a fresh URL and open the socket, buffering its frames.
2. For each conversation you show, page `items?after=<last item id you have>` and merge by item id.
3. Refresh the conversation list for new requests and changed states, then apply the buffered frames.

If the item you're catching up from was deleted or hidden, reload that conversation from the start.

## Idempotency

Send an `Idempotency-Key` header (any unique string up to 200 characters, such as a UUID) on `POST` requests and server writes, and a retry won't do it twice. A repeat with the same key gets the same response: successes are kept for {{v1.replaySuccess}} and client errors for {{v1.replayClientError}}. Reusing a key with a different body is `422 idempotency_mismatch`; a repeat while the first is still running is `409 request_pending`. Refresh and realtime URLs aren't replayed.

A request refused with a client error never ran. If you fix the cause and retry, for example after the person verifies their email following `401 contact_required`, use a new key.

## Rate limits

When you go over a limit you get `429` and a `Retry-After` header with the seconds to wait.

| What | Limit |
| --- | --- |
| A session reading | {{rate:RL_V1_READ}}, shared by every token after refreshes |
| A session writing | {{rate:RL_TEAM}} |
| Typing signals | {{rate:RL_V1_READ}} |
| Starting sessions and entering codes | {{rate:RL_TEAM}} per key and IP |
| Email codes sent | {{rate:RL_IP}} per IP, and per address and workspace |
| A secret key, in total | {{rate:RL_V1_SECRET}} |
| Any request | {{rate:RL_V1_IP}} per IP |
| Sign-in routes, and requests without a valid-looking key | {{rate:RL_AGENT}} per IP |

`OPTIONS` preflights are free, and browsers may cache them for a day.

## Errors

Errors have a stable `code` and a readable `message`:

```sh
curl https://api.blhp.app/v1/me \
  -H "Authorization: Bearer $SESSION_TOKEN"
```

```json
{ "error": { "code": "invalid_credential", "message": "Invalid or expired credential" } }
```

| Status | Codes | Meaning |
| --- | --- | --- |
| 400 | `invalid_input`, `invalid_code`, `invalid_attachment` | A field is wrong, or the code didn't match. |
| 401 | `invalid_credential` | The key or session is missing, wrong, revoked or expired. |
| 401 | `contact_required` | This needs a verified person: sign in by email first. |
| 403 | `forbidden`, `anonymous_disabled`, `verification_required`, `blocked`, `locked` | Not allowed: the wrong origin, a disabled sign-in, or the person or conversation is blocked. |
| 404 | `not_found` | It doesn't exist, or this credential can't see it. |
| 409 | `request_pending`, `conflict` | The same idempotent request is still running, or something changed meanwhile. |
| 410 | `expired`, `erased` | The report metadata or saved response is gone. |
| 413 | `too_large`, `upload_byte_quota` | Over a size or daily limit. |
| 415 | `expected_json`, `expected_multipart`, `unsupported_video` | The wrong content type. |
| 422 | `idempotency_mismatch` | The key was used for a different request. |
| 428 | `human_required` | A Turnstile token is required. |
| 429 | `rate_limited`, `idempotency_limit`, `code_limit` | Too many. Wait `Retry-After` seconds. |

## Server API

With a secret key and no `Origin`, the same conversation routes give the workspace's view, and a few more manage contacts. Use it from your backend to sync your users, open requests for them, reply from your own tools and handle deletions. AI agents should use [MCP](/docs/mcp) instead. Every server write takes an `Idempotency-Key` and is recorded in the workspace's audit log with the key's name.

### Contacts

`PUT /v1/contacts/by-external-id/:id` creates or updates the contact for one of your users, with the same [linking rules](#linking-existing-contacts) as starting a session:

```sh
curl -X PUT https://api.blhp.app/v1/contacts/by-external-id/user_9001 \
  -H "Authorization: Bearer $BELLHOP_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email": "sam@example.com", "email_verified": true, "name": "Sam Ortiz"}'
```

```json
{
  "id": "ct_770b8a27-f21c-4c9e-a6ef-f0b30159671c",
  "name": "Sam Ortiz",
  "email": "sam@example.com",
  "external_id": "user_9001",
  "unverified_email": null,
  "verified_via": "host",
  "locale": "en",
  "created_at": "2026-11-04T21:02:00.940Z",
  "last_seen_at": "2026-11-04T21:02:00.940Z",
  "anonymous": false
}
```

`GET /v1/contacts?q=` searches contacts, and `GET /v1/contacts/:id` or `/v1/contacts/by-external-id/:id` reads one. Anonymous visitors aren't contacts until they verify.

### The workspace view

`GET /v1/conversations` lists the workspace's requests, filtered with `status`, `contact_id` or `q` (the same search as the team's list). Conversations and items in this view also carry `contact_id`, `labels`, `hidden`, `internal` notes and staff-only events, so keep them away from end users. Attachment URLs in it need the secret key to fetch; they aren't shareable.

- **Open a request for someone:** `POST /v1/conversations` with `contact: { "external_id": "user_9001" }` (or `{ "id": "ct_…" }`). It's marked `created_via: "api"`.
- **Reply as a team member:** `POST /v1/conversations/:id/messages` with `as: { "member": "agent@yourcompany.com" }`, the email of someone who has joined the workspace. Add `"internal": true` for a team-only note.
- **Triage:** `PATCH /v1/conversations/:id` with any of `status`, `close_reason`, `assignee` (`{ "member": "<email>" }`, `{ "agent": "<agent id>" }` or `null`) and `labels` (names).
- **Ask to verify an email:** `POST /v1/conversations/:id/verifications` with `{ email }` sends that address a code only the requester can enter.

A reply from your own tools. Dana sees it from Alex, on your team:

```sh
curl -X POST https://api.blhp.app/v1/conversations/$CONVERSATION/messages \
  -H "Authorization: Bearer $BELLHOP_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-4821-reply-1" \
  -d '{"as": {"member": "alex@acme.example"}, "body": "Thanks Dana, I have refunded the $20."}'
```

```json
{
  "id": "1f2d3c4b-5a69-4788-9a0b-c1d2e3f4a5b6",
  "conversation_id": "67e9902b-2fe4-4e60-bd94-17745a010358",
  "author": { "type": "team", "id": "b46c1221-6f61-435f-890c-f46a7243cda7", "name": "Alex Kim", "avatar_url": null },
  "body": "Thanks Dana, I have refunded the $20.",
  "attachments": [],
  "created_at": "2026-11-04T21:02:00.512Z",
  "edited_at": null,
  "internal": false
}
```

Then close it:

```sh
curl -X PATCH https://api.blhp.app/v1/conversations/$CONVERSATION \
  -H "Authorization: Bearer $BELLHOP_SECRET_KEY" \
  -H "Content-Type: application/json" \
  -d '{"status": "closed", "close_reason": "completed"}'
```

```json
{
  "id": "67e9902b-2fe4-4e60-bd94-17745a010358",
  "number": 70,
  "subject": "My invoice for October is wrong: it says $120, it should be $100.",
  "status": "closed",
  "close_reason": "completed",
  "created_at": "2026-11-04T21:01:51.012Z",
  "updated_at": "2026-11-04T21:02:00.994Z",
  "contact_id": "ct_18ddac26-429d-4400-80e0-72c003ff0217",
  "unread": 0,
  "request_type": null,
  "fields": {},
  "effective_autonomy": "suggest",
  "labels": [],
  "assignee": null,
  "hidden": false,
  "last_item": {
    "id": "62ad41b5-4031-4977-ae59-4bff711d6463",
    "created_at": "2026-11-04T21:02:00.994Z",
    "internal": false,
    "hidden": false,
    "kind": "event",
    "actor": { "type": "team", "id": "workspace-team", "name": "Acme Support", "avatar_url": null },
    "event": { "type": "status_changed", "status": "closed", "close_reason": "completed" }
  },
  "verifications": []
}
```

### Erasure

`DELETE /v1/contacts/:id` erases a person: their name, emails and external id, their sessions (which stop at once), their notification subscriptions and the verification records on their requests. Their requests and files stay so the team's history makes sense, written by "Deleted user". Your user id is free again afterwards; vouching for it later creates a new, empty contact.

## Reference

Generated from [`/v1/openapi.json`](https://api.blhp.app/v1/openapi.json). Paths are relative to `https://api.blhp.app`, and "or" between credentials means either works.

{{table:api-reference}}

### Objects

{{table:api-schemas}}
