---
title: Identity
nav: Identity
description: Sign your app's users in to your help desk and chat widget: identity keys, signing tokens in Node and Python, the sign-in link and email verification.
---

# Identity

When your app already knows who someone is, they shouldn't have to sign in again to get help. Your server signs a short-lived identity token for the signed-in user, and the help desk or the chat widget accepts it: they arrive as a verified contact, with their own requests, on any device.

A "Contact support" link in your app can do it in one step:

```ts
// On your server, when the signed-in user clicks "Contact support"
const token = signIdentity(user.id, user.name, user.emailVerified ? user.email : undefined)
redirect(`https://acme.blhp.app/identify?token=${token}&next=/new`)
```

They see a confirmation page ("Continue to Acme Support as Dana Lee?"), press Continue, and land on the new request form, signed in. `signIdentity` is under [Sign a token](#sign-a-token).

## Create an identity key

Workspace admins create keys in **Settings → Identity keys**, once help desk mode is on. Each key has:

- a **key ID** (`kid`), which goes in the token's header;
- a **secret**, `bh_id_…`, shown once. Keep it on your server and never put it in a browser or a mobile app.

Set them on your server, with the workspace slug:

```sh
IDENTITY_KEY_ID=…        # the key ID
IDENTITY_SECRET=bh_id_…  # the secret, shown once
WORKSPACE_SLUG=acme
```

Revoking a key rejects every token signed with it from then on. People it already signed in stay signed in until their session ends.

## Sign a token

An identity token is a JWT signed with HMAC-SHA256 using the whole secret, including `bh_id_` (don't decode it). Make one on your server for the signed-in user: `sub` is their id in your app, and pass the email only when your app has verified it.

### Node and TypeScript

Uses only `node:crypto`:

```ts
import { createHmac, randomUUID } from "node:crypto"

export function signIdentity(sub: string, name: string, verifiedEmail?: string) {
  const { IDENTITY_KEY_ID: kid, IDENTITY_SECRET: secret, WORKSPACE_SLUG: aud } = process.env
  if (!kid || !secret || !aud) throw new Error("Missing identity configuration")
  const iat = Math.floor(Date.now() / 1000)
  const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString("base64url")
  const header = encode({ alg: "HS256", kid })
  const claims = encode({ sub, name, aud, iat, exp: iat + 120, jti: randomUUID(),
    ...(verifiedEmail && { email: verifiedEmail, email_verified: true }) })
  const input = `${header}.${claims}`
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`
}
```

### Python

Uses only the standard library:

```python
import base64, hashlib, hmac, json, os, time, uuid

def sign_identity(sub, name, verified_email=None):
    def b64(data):
        return base64.urlsafe_b64encode(data).rstrip(b"=")
    def encode(obj):
        return b64(json.dumps(obj, separators=(",", ":")).encode())
    iat = int(time.time())
    header = {"alg": "HS256", "kid": os.environ["IDENTITY_KEY_ID"]}
    claims = {"sub": sub, "name": name, "aud": os.environ["WORKSPACE_SLUG"],
              "iat": iat, "exp": iat + 120, "jti": str(uuid.uuid4())}
    if verified_email:
        claims.update(email=verified_email, email_verified=True)
    data = encode(header) + b"." + encode(claims)
    mac = hmac.new(os.environ["IDENTITY_SECRET"].encode(), data, hashlib.sha256)
    return (data + b"." + b64(mac.digest())).decode("ascii")
```

### Claims

| Claim | Required | Meaning |
| --- | --- | --- |
| `sub` | yes | Your user id, up to 255 characters. It becomes the contact's `external_id`. |
| `aud` | yes | The workspace slug. |
| `iat`, `exp` | yes | Issued and expiry times, in seconds. `exp` is at most 10 minutes after `iat`; 2 minutes is plenty. |
| `jti` | yes | A unique id. Each token works once. |
| `name` | no | Their display name, up to 120 characters. |
| `email` | no | Their email address. |
| `email_verified` | no | `true` when your app has verified `email`. Without it, the email is display-only and never used to match or reach anyone. |
| `link_existing` | no | `true` to link them to requests they sent earlier by email. See below. |

The header is `{ "alg": "HS256", "kid": "<key ID>" }`.

### Linking requests sent earlier by email

Someone may have emailed support, or signed in on the help desk with an email code, before your app signed them in. By default, a verified email in your token does **not** connect them to that earlier contact and its private requests: a token from your app is trusted for who the user is in your app, not for everything that address has done before. They get a new contact, and their address shows as unverified until you decide.

Add `link_existing: true`, next to `email_verified: true`, only when this user should see the requests they made earlier by email:

```ts
const claims = encode({ sub, name, aud, iat, exp: iat + 120, jti: randomUUID(),
  email: verifiedEmail, email_verified: true, link_existing: true })
```

It links only to a contact that isn't linked to one of your users yet, and a `sub` you've signed in before always keeps its own contact, so two contacts are never merged.

## Use the token

### The sign-in link

Send people to the help desk with the token in a link:

```
https://acme.blhp.app/identify?token=<token>&next=/new
```

The link opens a confirmation page, "Continue to Acme Support as Dana Lee?", which says so when someone else is already signed in in that browser. Opening the link signs nobody in, so a link that's forwarded, previewed by a chat app or prefetched can't sign anyone in either. Pressing **Continue** posts the token from the page, signs this browser in for {{identity.session}}, and goes to `next`: a path on the help desk such as `/new`, `/requests` or `/requests/12`. Anything else goes to the home page. If the token has expired or was used, the page says so; send them back to your app for a new link.

Make the token when they click, not when you render the page, so it's fresh: it lasts as long as `exp` allows, and works once.

### From the help desk page

Code running on the help desk site itself can post the token instead:

```js
await fetch("/api/apps/acme/identify", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ token }),
})
```

It works only from the help desk's own origin. This way, requests this browser sent before signing in move to the contact too.

### In the chat widget and the API

Pass the token to the [chat widget](/docs/widget#identifying-users) as `identityToken`, or exchange it for an [API session](/docs/api#end-user-sessions) with a publishable key:

```sh
curl -X POST https://api.blhp.app/v1/sessions \
  -H "Authorization: Bearer $BELLHOP_PUBLISHABLE_KEY" \
  -H "Origin: https://app.example.com" \
  -H "Content-Type: application/json" \
  -d "{\"identity_token\": \"$IDENTITY_TOKEN\"}"
```

```json
{
  "token": "bh_us_EXAMPLE_SESSION_TOKEN",
  "expires_at": "2026-11-05T21:30:12.000Z",
  "user": {
    "id": "ct_5a1e0d47-7b0e-4c55-9f43-1f3c6f1b8e21",
    "name": "Dana Lee",
    "email": "dana@example.com",
    "external_id": "user_8412",
    "verified_via": "host",
    "locale": "en",
    "anonymous": false
  }
}
```

If your server can call the API, it can skip the token and start the session with a secret key directly: `POST /v1/sessions` with `{ "user": { … } }` takes the same fields, including `link_existing`.

## Email verification

Not everyone comes from your app. On the help desk site, people can also sign in with a 6-digit code sent to their email, and they become a contact verified by email. Codes last 10 minutes, work once, allow 5 tries and only in the browser that asked for them.

Separately, the team can ask a requester to prove an address on a request, such as "the email on your billing account". It's useful before changing an account. Team members do it from the request, agents with `request_verification` over [MCP](/docs/mcp), and your backend with `POST /v1/conversations/:id/verifications`. Bellhop emails that address a code that only the requester can enter, on the request or in the chat widget. The team and agents see the result, never the code:

- the request's `verifications` list shows it as `pending`, then `verified`, `failed` or `expired`;
- a `verification.completed` [webhook](/docs/webhooks) fires with the result in `verification`;
- `get_issue` and `get_contact` over MCP include it.

A contact's `verified_via` says how they were verified: `host` (your app vouched for them) or `email` (they entered a code).
