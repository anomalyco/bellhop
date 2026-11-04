---
title: Chat widget
nav: Chat widget
description: Add a white-label support chat to your site with one script tag: identify signed-in users, theme it, control it, or build your own on the JS SDK.
---

# Chat widget

The chat widget puts a support button in the corner of your site. People start a conversation, see replies arrive live, attach files and come back to earlier conversations, without leaving the page. Your team answers in the help desk like any other request. The widget never mentions Bellhop: it shows your workspace's name and icon.

Paste this before `</body>`, with a publishable key from **Settings → API keys**:

```html
<script
  src="https://blhp.app/widget/v1.js"
  data-key="bh_pk_…"
  async
></script>
```

**Settings → Chat widget** has the same snippet with your key filled in. The key must allow your site's origin, such as `https://app.example.com`.

## Identifying users

The widget works best when your page tells it who is signed in. They arrive verified, see their own conversations on every device, and nobody has to type a code. There are two ways.

### A session from your server

Your server starts a session with a secret key (see [end-user sessions](/docs/api#end-user-sessions)) and hands the token to the page:

```ts
// On your server, for the signed-in user (the secret key never reaches a browser)
const res = await fetch("https://api.blhp.app/v1/sessions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.BELLHOP_SECRET_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    user: { id: user.id, email: user.email, email_verified: true, name: user.name },
  }),
})
const { token } = await res.json()
```

```html
<script>
  Bellhop.init({ key: "bh_pk_…", sessionToken: "<the token from your server>" })
</script>
```

Start a session for each page load, or for each browser, rather than caching one per user: the widget refreshes the token to keep long-lived pages signed in, and a refreshed token replaces the old one. On the next page load with the same token, it picks up where the refreshed one left off.

### An identity token

Or sign a short-lived token on your server with an identity key, without calling Bellhop, and pass it as `identityToken`. [Identity](/docs/identity) has the signing code for Node and Python.

```html
<script>
  Bellhop.init({ key: "bh_pk_…", identityToken: "<the token from your server>" })
</script>
```

If someone signs in or out while the page is open, call `Bellhop.identify(token)` with a new session or identity token, or `Bellhop.logout()`.

### Visitors who aren't signed in

On your site, the widget can't offer email codes or anonymous chats. Both need a human check (Turnstile) that runs only on the workspace's own site, `https://<slug>.blhp.app`. So when nobody is identified, the widget says "Sign in to app.example.com to contact support", and logs a hint in the browser console for you. Identify your signed-in users, or link visitors to your help desk site, where they can sign in by email.

## Options

`Bellhop.init(options)` takes:

| Option | Values | Default |
| --- | --- | --- |
| `key` | Your publishable key (`bh_pk_…`). Required. | |
| `sessionToken` | A session token your server started (`bh_us_…`). | |
| `identityToken` | An identity token your server signed. | |
| `locale` | One of {{locales}}. | The browser's language, or the user's saved one |
| `theme` | `"light"`, `"dark"` or `"auto"` (follows the visitor's setting) | `"light"` |
| `position` | `"right"` or `"left"` | `"right"` |

The script tag takes `data-key`, `data-locale`, `data-theme` and `data-position` too. With `data-key` and no `init` call, the widget starts on its own for visitors.

## Methods and events

The snippet queues calls until the widget loads, so you can call these straight away:

| Call | Does |
| --- | --- |
| `Bellhop.open()`, `close()`, `toggle()` | Show or hide the chat. |
| `Bellhop.newConversation({ subject?, message?, metadataId? })` | Open a new conversation, optionally with a subject and a draft message. `metadataId` attaches [report metadata](/docs/reports) such as logs. |
| `Bellhop.identify(token)` | Switch to another signed-in user (a session or identity token). |
| `Bellhop.logout()` | Sign out of the chat and forget the stored session. |
| `Bellhop.on(event, fn)` | Listen for `"unread"` (the number of unread replies), `"open"` or `"close"`. |

For example, a "Contact support" button and an unread count in your own menu:

```html
<button id="help">Contact support</button>
<span id="help-unread" hidden></span>
<script>
  document.getElementById("help").onclick = () =>
    Bellhop.newConversation({ subject: "Problem with my invoice" })
  Bellhop.on("unread", (n) => {
    const badge = document.getElementById("help-unread")
    badge.textContent = n
    badge.hidden = n === 0
  })
</script>
```

If the script loads before your own code, add the queue yourself so early calls aren't lost:

```html
<script>
  !function(w){var b=w.Bellhop=w.Bellhop||{q:[]};["init","identify","open","close","toggle","newConversation","on","logout"].forEach(function(m){b[m]=b[m]||function(){b.q.push([m,[].slice.call(arguments)])}})}(window)
</script>
```

## Request types

If your workspace sorts requests by type (**Settings → Request types**), a new conversation starts with "What do you need help with?" and the types to choose from, plus "Something else". The chosen type's fields then appear above the message box:

- text, long text, email, link, number and choice fields, with required ones marked and their help text below;
- answers are checked before sending, and a problem the server finds lands on its field, with the message kept;
- an email field set to verify says "We'll send a code to confirm it", and the code card appears in the conversation after sending;
- for a type that needs a verified email, a visitor who isn't signed in confirms their email first, then fills in the form;
- internal fields, which your team or server fills in, never show.

Arrow keys move through the types, and Enter picks one. Without request types, the chat starts with the message box as before.

## Theming and languages

The widget lives in its own shadow root, so your page's CSS doesn't change it and its CSS doesn't leak into your page. It takes the workspace's name and icon from **Settings**, `theme` sets light, dark or automatic, and `position` picks the corner. On phones it opens full screen.

It's translated into {{locales}}. Without `locale`, it uses the signed-in user's saved language, or else the browser's.

## Behavior

- Conversations open at the newest messages; older ones load as you scroll up.
- Replies, typing and an agent's activity ("Looking up your invoice…") arrive live. Without a socket, it polls.
- A message that fails to send stays in the thread with a Retry button, and is never sent twice.
- Files: images up to {{v1.uploadImage}}, videos up to {{v1.uploadVideo}}, other files up to {{v1.uploadFile}}.
- Long-lived pages stay signed in: the session is refreshed before it expires, for up to {{v1.sessionCap}}.
- The loader at `/widget/v1.js` is cached only briefly, and recovers by itself if a deploy replaced the version it points to.

## Build your own on the SDK

The widget is built only on the JS SDK, so you can build your own chat UI, or use the API from Node, with the same calls. Import it as an ES module:

```ts
import { createClient, BellhopError, uploadErrorKind } from "https://blhp.app/sdk/v1.js"

const client = createClient({ key: "bh_pk_…" })
const workspace = await client.workspace() // name, icon_url, which sign-ins this origin offers

// A token your server started; save rotated tokens so a reload picks up the newest one
const session = client.fromSessionToken(tokenFromYourServer, undefined, {
  onRefresh: (s) => localStorage.setItem("support-session", s.token),
})

const billing = workspace.request_types.find((t) => t.name === "Billing") // or let the person pick
const conversation = await session.createConversation({
  message: { body: "Hi! My invoice is wrong." },
  ...(billing && { request_type: billing.id, fields: { invoice: "4821" } }),
})
const latest = await session.latest(conversation.id, 30) // the newest 30, oldest first
const earlier = latest.next_cursor ? await session.older(conversation.id, { cursor: latest.next_cursor }) : null

// Live updates (a socket, or polling where sockets aren't available)
const live = session.subscribe((event) => {
  if (event.type === "item.created") render(event.item)
})

// Files
try {
  const file = await session.upload(input.files[0])
  await session.sendMessage(conversation.id, { body: "Here's the receipt.", attachments: [file.id] })
} catch (e) {
  if (uploadErrorKind(e) === "too_large") alert("That file is too big.")
  else throw e
}
```

From your server, the same SDK starts sessions with a secret key:

```ts
import { createClient } from "https://blhp.app/sdk/v1.js"

const server = createClient({ key: process.env.BELLHOP_SECRET_KEY })
const { token } = await server.createSession({ id: user.id, email: user.email, email_verified: true, name: user.name })
```

A custom chat can offer "Talk to a person" with `` session.request({ method: "POST", path: `/conversations/${id}/escalate`, body: { reason } }) ``: the conversation's `with_person` then turns `true` (see [Talking to a person](/docs/api#talking-to-a-person)). The built-in widget doesn't have that button yet.

Errors are `BellhopError`s with the API's `status` and `code`. Every call is described in the [API reference](/docs/api#reference).
