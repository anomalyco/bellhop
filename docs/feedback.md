---
title: Feedback API
nav: Feedback
description: Send in-app feedback with one HTTP call: message, screenshots, app and device details, an email or anonymous. Fields, limits, errors and a form checklist.
---

# Feedback API

Your app's feedback form posts straight into Bellhop. Each submission becomes a private issue that only your team and its agents can see, with the screenshots attached and the app and device details alongside. You build the form; this page has everything it needs, including a [checklist](#building-a-feedback-form) for the coding agents that build one.

```sh
curl -X POST https://api.blhp.app/v1/feedback \
  -H "Authorization: Bearer $BELLHOP_REPORT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"category": "bug", "subject": "Export button does nothing", "message": "Tapping Export on the Recordings screen does nothing. No error.", "email": "dana@example.com", "app": {"name": "Hex", "version": "1.4.2", "build": "56"}, "device": {"platform": "ios", "os": "iOS 26.1", "model": "iPhone17,1", "locale": "en-US"}, "install_id": "3f6c1e9a-2b7d-4e58-9a31-0c8d5f7b2e14", "metadata": {"screen": "Recordings"}}'
```

The response is `201 Created`:

```json
{ "number": 128, "received_at": "2026-11-22T18:04:11.532Z", "email": "pending" }
```

`number` is the issue number your team sees. That's the whole integration: there's no SDK to install.

## Set up

Feedback goes to an app in an org. An org groups your apps and gives your team one inbox across them.

1. **Create an org** on [blhp.app](https://blhp.app), or `POST /api/orgs` with `{ "name", "slug" }` while signed in.
2. **Add an app** to it. A new feedback app is private and unlisted, and comes with the labels `bug`, `idea` and `question`. Over the API, `POST /api/orgs/{org}/apps` with `{ "name", "slug" }` returns the app and its first report key, once, in `report_key`.
3. **Copy the report key.** It looks like `bh_pub_` followed by 64 hex characters. Admins can create more, and revoke them, in the app's **Settings → Report keys**.

A report key is publishable: it can only send feedback and [report metadata](/docs/reports) to its own app. It can't read issues or change anything, so it's safe to ship inside an iOS or macOS app or a web page. If one is abused, revoke it and ship a new one; a revoked key gets `401 invalid_report_key`.

### Allow feedback on the key

Each report key says whether it may send feedback. New keys may. Keys created before feedback existed may not until an admin turns it on, in **Settings → Report keys** or with the API (signed in as an admin of the app):

```sh
curl -X PATCH https://blhp.app/api/apps/hex/report-keys/$REPORT_KEY_ID \
  -H "Cookie: $BELLHOP_SESSION_COOKIE" \
  -H "Content-Type: application/json" \
  -d '{"feedback": true}'
```

It returns the key, without its secret. A key that doesn't allow feedback gets `403 feedback_disabled` from the feedback endpoint; it can still upload report metadata.

## Send feedback

`POST https://api.blhp.app/v1/feedback`

The key says which app the feedback is for. The same request also works at `POST https://blhp.app/api/apps/{slug}/feedback`, with the app's slug in the path.

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer bh_pub_…` |
| `Content-Type` | `application/json`, or `multipart/form-data` |

The endpoint answers browsers from any origin (CORS `*`), like report metadata, so a web app can call it directly.

### JSON

Send a [`FeedbackInput`](#fields) object. Screenshots go in `screenshots` as base64:

```sh
curl -X POST https://api.blhp.app/v1/feedback \
  -H "Authorization: Bearer $BELLHOP_REPORT_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"category\": \"bug\", \"message\": \"The waveform freezes after a minute.\", \"anonymous\": true, \"app\": {\"name\": \"Hex\", \"version\": \"1.4.2\"}, \"device\": {\"platform\": \"ios\", \"os\": \"iOS 26.1\", \"model\": \"iPhone17,1\"}, \"screenshots\": [{\"name\": \"screen.png\", \"content_type\": \"image/png\", \"data\": \"$(base64 < screen.png | tr -d '\n')\"}]}"
```

```json
{ "number": 129, "received_at": "2026-11-22T18:05:40.107Z", "email": "none" }
```

### Multipart

Base64 makes screenshots a third bigger, so apps that can build a multipart body should. Send the same object, without `screenshots`, as a part named `payload`, and each image as a part named `screenshot`:

```sh
curl -X POST https://api.blhp.app/v1/feedback \
  -H "Authorization: Bearer $BELLHOP_REPORT_KEY" \
  -F 'payload={"category": "idea", "subject": "Keyboard shortcut for search", "message": "I would love Cmd+K to jump to search.", "app": {"name": "OpenCode", "version": "0.9.3", "build": "212"}, "device": {"platform": "macos", "os": "macOS 15.4", "model": "Mac15,3", "locale": "en-GB"}, "metadata": {"screen": "Sessions"}};type=application/json' \
  -F "screenshot=@screen.jpg;type=image/jpeg"
```

```json
{ "number": 130, "received_at": "2026-11-22T18:06:02.881Z", "email": "none" }
```

Up to {{feedback.maxScreenshots}} `screenshot` parts are accepted.

## Fields

Only `message` is required.

| Field | Type | Limit | What it's for |
| --- | --- | --- | --- |
| `message` | string | {{feedback.message}} | What happened, or what they'd like. |
| `subject` | string | {{feedback.subject}} | A short summary. When it's missing, the start of the message is used. |
| `category` | string | {{feedback.category}} | The form's category, matched to a label by name: `bug`, `idea` or `question` on a new app. Unknown names add no label. |
| `email` | string | | Where to send replies. See [Email](#email). Ignored when anonymous. |
| `anonymous` | boolean | | See [Anonymous feedback](#anonymous-feedback). |
| `user` | `{ id?, name? }` | `name`: {{feedback.userName}} | Your signed-in user, shown to the team as given (not verified). Ignored when anonymous. See [Public issues](#public-issues). |
| `app` | `{ name?, version?, build? }` | | e.g. `{ "name": "Hex", "version": "1.4.2", "build": "56" }`. |
| `device` | `{ platform?, os?, model?, locale? }` | | e.g. `{ "platform": "ios", "os": "iOS 26.1", "model": "iPhone17,1", "locale": "en-US" }`. Use `ios`, `macos` or `web` for `platform`. |
| `install_id` | string | | A random id your app makes once per installation, so the team sees reports from the same install together. Never a hardware or advertising id. Ignored when anonymous. |
| `metadata` | object of strings | {{feedback.metadata}} | Details your form adds, such as the screen or the server instance. See [Metadata](#metadata). |
| `screenshots` | array of `{ name?, content_type, data }` | {{feedback.screenshots}} | JSON only: base64 images. Multipart sends `screenshot` parts instead. |
| `logs` | array of `{ name, content }` | | Text logs, attached for the team. Ignored when anonymous. |

### Images

Screenshots must be PNG, JPEG or WebP. Bellhop reads each image's real header, whatever `content_type` or the file name says, and keeps it only if:

- it's a complete PNG, JPEG or WebP image (anything else is `415 unsupported_media_type`);
- it's at most {{images.side}} px on each side and {{images.megapixels}} megapixels (larger is `413 too_large`);
- nothing follows the end of the image (a file with data appended is `415 unsupported_media_type`).

The stored file is named after the type it really is: a JPEG sent as `screen.png` is kept as a `.jpg`.

### Metadata

`metadata` is whatever key/value details your form wants to send: `{ "screen": "Settings", "instance": "eu-1", "plan": "pro" }`. The team sees it on the issue and can search the inbox for it with `meta:screen=Settings`. Values are strings; send numbers and flags as text.

### Anonymous feedback

With `"anonymous": true`, Bellhop stores no email, user, install id or logs, even if you send them. The message, screenshots, app and device details and metadata are kept. **Metadata is kept**, so don't put anything identifying in it (an account id, an email, a name) when the person chose to stay anonymous. Anonymous feedback can't be answered.

### Public issues

Feedback issues are private. If your team makes one public, the reporter is shown as "Anonymous" from then on, whatever `user.name` said. The team still sees the name your app sent in the issue's feedback details.

## Response

`201 Created` with:

| Field | What it means |
| --- | --- |
| `number` | The issue number in the app. |
| `received_at` | When Bellhop received it. |
| `email` | `pending`: an email was given (and it isn't anonymous). Nothing has been sent yet; see [Email](#email). `none`: no email was given, or it was anonymous. |

`email` is deliberately neutral: it never says whether the address was already confirmed or has opted out of email, so the response can't be used to probe an address.

## Email

The person who sends feedback only ever hears back by email. There's no page for them to visit and nothing to sign in to.

- **Nothing is sent when they submit.** The address waits, and the response says `pending`.
- **When your team (or an agent) first replies in public**, Bellhop sends the address one neutral email, "{workspace} replied to your feedback", without the reply itself. It has a button to confirm the address; opening the link alone confirms nothing, so link scanners can't confirm it.
- **Confirming** turns on email for every feedback that address sent to the app, and sends the replies so far. After that, each public reply arrives by email (very long ones are shortened, with a note), and the person can answer by replying; the answer lands in the issue.
- **One confirmation at a time** per app and address, and at most {{feedback.confirmations}} a day.
- **The same install, the same address:** once an address is confirmed for feedback from an install, later feedback from that install with the same address gets replies straight away, with no new confirmation. Feedback from a different install with that address gets its own confirmation.
- Internal notes and everything else on the issue stay with the team, and nothing else is ever sent to an address that hasn't been confirmed.

## Limits

{{table:feedback-limits}}

Over a rate limit you get `429` with a `Retry-After` header in seconds. "Per client" counts each report key and client IP address together, so one busy client can't use up a key's daily allowance.

## Retries

Send an `Idempotency-Key` header (any unique string up to 200 characters; a random UUID made when the person presses Send is ideal) and retry with the same key and the same feedback: for multipart, the same `payload` part and screenshot files. The first answer comes back for 24 hours and no second issue is made; client errors are replayed for 5 minutes.

```sh
curl -X POST https://api.blhp.app/v1/feedback \
  -H "Authorization: Bearer $BELLHOP_REPORT_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: hex-feedback-send-0001" \
  -d '{"message": "Sync stopped after the update.", "install_id": "3f6c1e9a-2b7d-4e58-9a31-0c8d5f7b2e14"}'
```

```json
{ "number": 131, "received_at": "2026-11-22T18:07:15.204Z", "email": "none" }
```

Sending exactly that again returns the same `number`.

- Keys are scoped to the report key and, when you send one, the `install_id`, so two installs can't collide on the same key.
- The same key with different feedback is `422 idempotency_mismatch`.
- A retry while the first attempt is still running is `409 request_pending` with `Retry-After`. If that attempt never finishes, its key is freed after {{feedback.pendingSeconds}} seconds.

## Errors

Every error is JSON with a stable `code`:

```sh
curl -X POST https://api.blhp.app/v1/feedback \
  -H "Authorization: Bearer bh_pub_0000000000000000000000000000000000000000000000000000000000000000" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'
```

```json
{ "error": { "code": "invalid_report_key", "message": "Invalid workspace report key" } }
```

{{table:feedback-errors}}

## Building a feedback form

For developers and coding agents building an app's form. Each point is platform-neutral: do it in the app's own UI toolkit.

1. **Ask for a message**, and optionally a subject and a category (`bug`, `idea`, `question`). Keep the form short.
2. **Attach a picture of your own app**, taken just before the form opens: render your app's window into an image (on Apple platforms, the key window). Never capture the whole screen: that needs a screen-recording permission and can include other apps. On the web, offer a file picker and paste instead. Let the person remove it and add up to {{feedback.maxScreenshots}} images.
3. **Shrink images before sending**: JPEG at about 80% quality, downscaled so the longest side is at most 2048 px (the hard limit is {{images.side}} px a side and {{images.megapixels}} megapixels). Re-encode picked photos too: HEIC isn't accepted, and each file must be a complete image with nothing appended.
4. **Make an install id once**: a random UUID stored in the app's own storage (UserDefaults, localStorage) the first time it's needed. Never a hardware id, `identifierForVendor` or an advertising id.
5. **Send app and device details**: the app's name, version and build; `platform` (`ios`, `macos` or `web`), the OS name and version, the model identifier (`iPhone17,1`, `Mac15,3`) and the locale.
6. **Offer an optional email with a "Send anonymously" toggle.** When it's on, hide the email field and say what is still sent: the message, images, app and device details. Don't send identifying metadata when it's on. If you send `user.name`, keep it to {{feedback.userName}}.
7. **Add metadata** the team will want to filter by: the current screen, the server instance, the plan.
8. **Send multipart** where the platform can (JSON with base64 otherwise), and show progress.
9. **Retry network failures** with the same payload and the same `Idempotency-Key`, a few times with backoff. Don't retry `4xx` responses, except `409 request_pending` and `429`, after `Retry-After` seconds.
10. **Handle errors kindly**: `413` (too large: ask them to remove or shrink an image), `415` (not a complete PNG, JPEG or WebP image), `429` (try again later), and offline. A `403 feedback_disabled` means the key isn't allowed to send feedback: that's a setup problem for the app's team, not the person, so log it and say feedback is unavailable.
11. **Say what happens next**: a thank-you. When `email` is `pending`, say they'll get an email if the team replies and will need to confirm their address once. Don't promise an email now: none is sent at submission.
12. **Keep the report key in the app's build configuration.** It's publishable, but keeping it out of source makes it easy to rotate.

## Triage

Everything arrives in the org's inbox at `https://blhp.app/o/{org}`, newest activity first, across all its apps. The inbox search takes the usual [qualifiers](/docs/agents#search-qualifiers) plus `app:<slug>`, `platform:ios`, `version:1.4.2`, `has:screenshot`, `has:email`, `source:feedback` and `meta:<key>=<value>`.

Agents work it over [MCP](/docs/mcp):

- `list_orgs` lists the agent's orgs and their apps.
- `list_feedback` lists feedback across every app the agent can use, or one org or app, newest activity first, with a summary per row (platform, app version, screenshot count, whether there's an email). It takes the same `query` as the inbox.
- `get_issue` returns the issue with its `feedback` details (app, device, install id, metadata, the email and whether it's confirmed, other feedback from the same install) and, by default, up to 5 screenshots as images the agent can see.
- `comment` replies. The first public reply sends the reporter the confirmation email; replies reach them by email once they've confirmed.

## Reference

{{table:feedback-reference}}
