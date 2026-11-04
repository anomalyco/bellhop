---
title: Running support agents
nav: Support agents
description: Run an AI agent on a help desk: pick up routed requests, reply within its autonomy, ask the team for signed approvals before acting, and verify emails.
---

# Running support agents

An agent on a help desk works its own requests. Request types route new requests to it. It answers in the requester's language, within the autonomy the team gave it, and asks a team member for a signed approval before it does anything with consequences, such as a refund. The agent connects over [MCP](/docs/mcp); everything below uses its tools.

Here it looks for open requests assigned to it:

```sh
curl -X POST https://blhp.app/mcp \
  -H "Authorization: Bearer $BELLHOP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_issues", "arguments": {"app": "acme", "query": "assignee:@me is:open"}}}'
```

Tool results are JSON in the text content. Decoded, and abridged to the fields this page uses:

```json
{
  "issues": [
    {
      "number": 14,
      "title": "Ich wurde im Oktober doppelt belastet.",
      "status": "open",
      "assignee": { "type": "agent", "id": "0f3e2d1c-6b5a-4c39-8e27-1d0c9b8a7f65", "name": "Billing agent" },
      "request_type": { "id": "rt_3b9d2f61-0c4e-4a7b-9d15-6e2f8a1c0b47", "name": "Billing" },
      "fields": { "billing_email": "dana@example.com", "invoice": "4821" },
      "effective_autonomy": "approve_actions",
      "reporter_locale": "de",
      "verifications": []
    }
  ],
  "next_cursor": null
}
```

## Finding work

Request types decide who gets a new request (**Settings → Request types**). Each type can route to an agent or a team member and sets the agent's autonomy; requests without a type use the workspace's default mode. The team can still reassign a request, and `set_request_type` (member) moves it to another type and applies that type's routing.

An agent learns about its work in one of two ways:

- **Webhooks.** `issue.opened` arrives with the new request: `issue.request_type`, `issue.fields` (every answer, including internal fields), `issue.effective_autonomy`, `issue.assignee`, `issue.reporter_locale` and the requester's `contact`. `issue.assigned` fires when routing or a person assigns it. See [Webhooks](/docs/webhooks).
- **Polling.** `list_issues` with a search query, like the example above.

`get_issue` returns the same fields with the whole timeline, and `list_request_types` describes each type's fields, routing and autonomy.

### Search qualifiers

`list_issues` takes `query`, which combines free text with these qualifiers:

| Qualifier | Finds |
| --- | --- |
| `assignee:@me`, `assignee:<handle>` | Requests assigned to this agent, or to someone else. |
| `no:assignee`, `no:label` | Unassigned or unlabeled requests. |
| `is:open`, `is:closed`, `status:in_progress`, `status:waiting` | Requests by state. |
| `type:<request type name>` | Requests of one type, such as `type:Billing`. |
| `is:held` | Requests with a held agent reply waiting for review. |
| `is:awaiting-approval` | Requests with a pending approval. |
| `is:escalated` (or `is:with-person`) | Requests handed to a person. |
| `is:waiting-for-person` | Escalated requests nobody has picked up yet: outside working hours, or nobody available. |
| `group:<name>` | Requests escalated to one group, such as `group:"Billing team"`. |
| `label:<name>`, `author:<handle>`, `has:metadata`, `reason:<close reason>` | The usual filters. |
| `sort:newest`, `sort:updated`, … | The order. |

`is:held`, `is:awaiting-approval`, `is:escalated`, `is:waiting-for-person`, `group:` and `type:` work for the team and agents only.

## Autonomy

Each request has an effective autonomy: its type's, or else the workspace default (**Settings → Help desk → Default agent mode**). `get_issue`, `list_issues` and webhooks include it as `effective_autonomy`.

| Mode | Public replies | Actions with consequences |
| --- | --- | --- |
| `suggest` | Held for a team member to send, edit or discard. | Ask for an approval first. |
| `approve_actions` | Sent right away. | Ask for an approval first. |
| `autonomous` | Sent right away. | May act alone; approvals are there when it wants a second opinion. |

Internal notes, triage, verifications and replies from people are never held. While a request is [with a person](#handing-off-to-a-person), the agent's public replies are held whatever the mode.

### Held replies

Under `suggest`, a public `comment` doesn't reach the requester. It returns `held: true` with the comment:

```sh
curl -X POST https://blhp.app/mcp \
  -H "Authorization: Bearer $BELLHOP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": "comment", "arguments": {"app": "acme", "number": 15, "body": "Thanks! Could you try reloading the page?"}}}'
```

```json
{
  "held": true,
  "comment": {
    "id": "5c1e9a7d-3f2b-4d80-b6a4-9e0d7c2b1a38",
    "body": "Thanks! Could you try reloading the page?",
    "created_at": "2026-11-04T21:37:10.600Z",
    "updated_at": "2026-11-04T21:37:10.600Z",
    "author": { "type": "agent", "id": "0f3e2d1c-6b5a-4c39-8e27-1d0c9b8a7f65", "name": "Billing agent" },
    "hidden": null,
    "edited_at": null,
    "internal": false,
    "mentions": [],
    "via": "mcp",
    "helpful": 0,
    "viewer_helpful": false,
    "held": { "at": "2026-11-04T21:37:10.600Z" },
    "sent_by": null,
    "by_issue_author": false,
    "attachments": [],
    "viewer_is_author": true
  }
}
```

The team sees the draft in the request, finds such requests with `is:held`, and gets a `reply.held` webhook. A member sends it as written or edited, and it stays the agent's reply, with `sent_by` naming who sent it; or they discard it. Only one of them wins: if two people send or discard the same reply at once, the second gets `409 {{approvals.replyCode}}`. The requester never sees a held reply, and isn't emailed about it, until it's sent.

## Approvals

An approval is a team member's yes to one specific action, which your own service checks before it acts. It works the same in every mode. Under `suggest` and `approve_actions`, your agent shouldn't act without one, and your action tools enforce that by requiring the token. Approvals, like held replies, exist only in help desk workspaces; elsewhere the tools answer `403 helpdesk_only`.

> **The `summary` is only a description. The `details` are what's signed.** The team approves the details exactly as the card shows them, the token carries them as `det`, and your action service must compare `det` with the parameters it's really about to use. Never act on anything the summary says that the details don't.

1. The agent asks with `request_approval`.
2. A team member approves or rejects it in the request.
3. The agent polls `get_approval`, or reacts to the `approval.decided` webhook.
4. Once approved, `get_approval` gives the agent a signed token.
5. The agent calls its own action tool with the token.
6. The action service verifies the token against the public keys, consumes it, and acts.

### 1. Ask

`action` is a machine name you choose. `details` are the exact parameters your service will check: strings, numbers or booleans, at most {{approvals.maxKeys}} keys, each string at most {{approvals.maxString}} characters, {{approvals.maxBytes}} in all. `summary` is a sentence for the team; it isn't signed.

```sh
curl -X POST https://blhp.app/mcp \
  -H "Authorization: Bearer $BELLHOP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "request_approval", "arguments": {"app": "acme", "number": 14, "action": "refund", "summary": "Refund €20.00 for invoice 4821 (duplicate charge)", "details": {"invoice": "4821", "amount": 2000, "currency": "eur"}}}}'
```

```json
{
  "id": "7d3c1a52-4e0b-4f6d-9a21-5b8c0e9f3a14",
  "issue_number": 14,
  "action": "refund",
  "summary": "Refund €20.00 for invoice 4821 (duplicate charge)",
  "details": { "amount": 2000, "currency": "eur", "invoice": "4821" },
  "details_hash": "FF1GfpynlYnUPgPb51-ZQ3pngAS_i9OPC0YPy_X9K7g",
  "state": "pending",
  "requested_by": { "type": "agent", "id": "0f3e2d1c-6b5a-4c39-8e27-1d0c9b8a7f65", "name": "Billing agent" },
  "decided_by": null,
  "decided_at": null,
  "note": null,
  "expires_at": "2026-11-11T21:37:05.000Z",
  "created_at": "2026-11-04T21:37:05.939Z"
}
```

A pending approval expires after {{approvals.pending}}. The agent needs at least the responder role.

### 2. The team decides

The request shows the approval as a card to the team only: the summary, and the details verbatim, with **Approve**, **Reject** and an optional note. Members (not viewers) can decide, once; the decision is recorded in the audit log. A decision covers exactly the details on the card: it's sent with their hash (the approval's `details_hash`: base64url SHA-256 of the details as JSON with sorted keys and no whitespace), and if they don't match, it's refused with `409 {{approvals.changedCode}}`. Reviewers get an email when an agent asks for an approval or holds a reply; it's on by default for admins and the request's assignee. A webhook gets `approval.requested`.

### 3. Wait for the decision

Poll `get_approval` with the id, or wait for the `approval.decided` webhook, whose `approval` says `approved` or `rejected`. Webhooks never contain the token.

### 4. Get the token

Once it's approved, `get_approval` adds `token`, for the agent that asked and nobody else:

```sh
curl -X POST https://blhp.app/mcp \
  -H "Authorization: Bearer $BELLHOP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "get_approval", "arguments": {"app": "acme", "id": "7d3c1a52-4e0b-4f6d-9a21-5b8c0e9f3a14"}}}'
```

```json
{
  "id": "7d3c1a52-4e0b-4f6d-9a21-5b8c0e9f3a14",
  "issue_number": 14,
  "action": "refund",
  "summary": "Refund €20.00 for invoice 4821 (duplicate charge)",
  "details": { "amount": 2000, "currency": "eur", "invoice": "4821" },
  "details_hash": "FF1GfpynlYnUPgPb51-ZQ3pngAS_i9OPC0YPy_X9K7g",
  "state": "approved",
  "requested_by": { "type": "agent", "id": "0f3e2d1c-6b5a-4c39-8e27-1d0c9b8a7f65", "name": "Billing agent" },
  "decided_by": { "type": "member", "id": "a6b2c9d4-1e7f-4a35-8c60-2d9e4f1b7a03", "name": "Alex Kim", "avatar_url": null, "role": "member" },
  "decided_at": "2026-11-04T21:37:05.953Z",
  "note": "Duplicate confirmed in Stripe.",
  "expires_at": "2026-11-04T22:07:05.000Z",
  "created_at": "2026-11-04T21:37:05.939Z",
  "token": "APPROVAL_TOKEN_EXAMPLE"
}
```

The token is valid for {{approvals.token}} after the decision; `expires_at` says when. Once it's used or expired, `get_approval` returns the approval without a token.

### 5. Call your action

Pass the token to the tool that does the work, next to its real parameters, for example `refund({ invoice: "4821", amount: 2000, currency: "eur", request: 14, approval_token })`. The tool is yours: an MCP tool on your own server, or an endpoint the agent calls.

### 6. Verify, consume, act

The token is a JWT signed with Ed25519 (`alg: "EdDSA"`), one key per workspace. Each workspace's public keys are at `{{approvals.jwks}}`. This Node function checks the token against the action you're about to take. It uses only `node:crypto`, caches the keys in memory and fetches them again once if it meets an unknown key id:

```js
import { createPublicKey, verify } from 'node:crypto';

const fail = (why) => { throw new Error(`Approval token rejected: ${why}`); };
const canonical = (o) => JSON.stringify(Object.entries(o ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const jwksCache = new Map();
async function keys(url, refresh = false) {
  if (refresh || !jwksCache.has(url)) {
    const response = await fetch(url, { redirect: 'error' });
    if (!response.ok) fail(`couldn't load the signing keys (${response.status})`);
    jwksCache.set(url, (await response.json()).keys ?? []);
  }
  return jwksCache.get(url);
}

// Every expected value comes from your service (the action it's about to take), never from the token.
export async function verifyApproval(jwt, { aud, act, det, req },
  jwksURL = `https://api.blhp.app/v1/approvals/jwks.json?workspace=${encodeURIComponent(aud)}`) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) fail('not a JWT');
  const [h, p, s] = parts;
  const json = (part) => { try { return JSON.parse(Buffer.from(part, 'base64url')); } catch { fail('malformed'); } };
  const header = json(h);
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT') fail('unexpected header');
  if (typeof header.kid !== 'string') fail('no key id');
  const find = (list) => list.find((k) => k.kid === header.kid && k.kty === 'OKP' && k.crv === 'Ed25519');
  const key = find(await keys(jwksURL)) ?? find(await keys(jwksURL, true)) ?? fail('unknown signing key');
  const signed = verify(null, Buffer.from(`${h}.${p}`), createPublicKey({ key, format: 'jwk' }), Buffer.from(s, 'base64url'));
  if (!signed) fail('bad signature');
  const c = json(p), now = Math.floor(Date.now() / 1000);
  if (c.iss !== 'https://blhp.app') fail('wrong issuer');
  if (c.aud !== aud) fail('wrong workspace');
  if (c.act !== act) fail('wrong action');
  if (canonical(c.det) !== canonical(det)) fail('details differ from this action');
  if (c.req !== req) fail('wrong request');
  if (typeof c.sub !== 'string' || !c.sub || c.sub !== c.jti) fail('bad id');
  if (!Number.isSafeInteger(c.iat) || !Number.isSafeInteger(c.exp)) fail('bad times');
  if (c.iat > now + 60 || now >= c.exp || c.exp - c.iat > 1800) fail('expired or not yet valid');
  return c; // Valid, but not yet single use: consume c.jti before acting.
}
```

| Claim | Meaning |
| --- | --- |
| `iss` | Always `https://blhp.app`. |
| `aud` | The workspace slug. |
| `act` | The approved action, such as `refund`. |
| `det` | The approved details, exactly as requested. |
| `req` | The request number. |
| `sub`, `jti` | The approval id. |
| `by` | Who approved it: `{ id, name }`. |
| `iat`, `exp` | The decision time, and {{approvals.token}} later. |

**A valid signature doesn't make a token single use.** For the {{approvals.token}} it's valid, the same token verifies every time. So before you act, consume it with your workspace's secret key, from your server (or record its `jti` somewhere that refuses duplicates), and use the `jti` as the action's idempotency key:

```sh
curl -X POST https://api.blhp.app/v1/approvals/$APPROVAL_ID/consume \
  -H "Authorization: Bearer $BELLHOP_SECRET_KEY"
```

```json
{
  "id": "7d3c1a52-4e0b-4f6d-9a21-5b8c0e9f3a14",
  "issue_number": 14,
  "action": "refund",
  "summary": "Refund €20.00 for invoice 4821 (duplicate charge)",
  "details": { "amount": 2000, "currency": "eur", "invoice": "4821" },
  "details_hash": "FF1GfpynlYnUPgPb51-ZQ3pngAS_i9OPC0YPy_X9K7g",
  "state": "used",
  "requested_by": { "type": "agent", "id": "0f3e2d1c-6b5a-4c39-8e27-1d0c9b8a7f65", "name": "Billing agent" },
  "decided_by": { "type": "member", "id": "a6b2c9d4-1e7f-4a35-8c60-2d9e4f1b7a03", "name": "Alex Kim", "avatar_url": null, "role": "member" },
  "decided_at": "2026-11-04T21:37:05.953Z",
  "note": "Duplicate confirmed in Stripe.",
  "expires_at": "2026-11-04T22:07:05.000Z",
  "created_at": "2026-11-04T21:37:05.939Z"
}
```

Consuming works once. A second try gets `{{approvals.usedStatus}}`:

```sh
curl -X POST https://api.blhp.app/v1/approvals/$APPROVAL_ID/consume \
  -H "Authorization: Bearer $BELLHOP_SECRET_KEY"
```

```json
{ "error": { "code": "{{approvals.code}}", "message": "Approval is not available for use" } }
```

| Status | Means |
| --- | --- |
| `{{approvals.usedStatus}} {{approvals.code}}` | It was already used. Don't act. |
| `{{approvals.goneStatus}} {{approvals.code}}` | It's pending, rejected or expired. Don't act. |
| `404 not_found` | It belongs to another workspace, or doesn't exist. |

Put together, the rule for every action service:

1. **Verify against the real action.** Pass `verifyApproval` the parameters you're about to use, not the ones in the token: the action, the details, the request number, your workspace slug. A token approved for €20 must not refund €200, whatever the summary says.
2. **Consume the `jti` before acting.** Only a successful consume means this token hasn't been used. If it fails, stop.
3. **Use the `jti` as the action's idempotency key.** If the action is retried after a crash, your payment provider or database sees the same key and doesn't do it twice.

```js
import { verifyApproval } from './verify-approval.mjs';

export async function refund({ invoice, amount, currency, request, approval_token }) {
  const claims = await verifyApproval(approval_token, {
    aud: 'acme', act: 'refund', det: { invoice, amount, currency }, req: request,
  });
  const used = await fetch(`https://api.blhp.app/v1/approvals/${claims.jti}/consume`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.BELLHOP_SECRET_KEY}` },
  });
  if (!used.ok) throw new Error(`Approval not usable (${used.status})`);
  return payments.refund({ invoice, amount, currency }, { idempotencyKey: claims.jti });
}
```

## Handing off to a person

When an agent can't finish a request, or shouldn't (an angry customer, a legal question, an account it can't verify), it hands the request to a person with `escalate` and a `reason` for the team:

```sh
curl -X POST https://blhp.app/mcp \
  -H "Authorization: Bearer $BELLHOP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 6, "method": "tools/call", "params": {"name": "escalate", "arguments": {"app": "acme", "number": 16, "reason": "Wants their account deleted; needs a person to confirm ownership.", "group": "Billing team"}}}'
```

It returns the request, as `get_issue` does. Abridged:

```json
{
  "number": 16,
  "status": "open",
  "assignee": { "type": "member", "id": "a6b2c9d4-1e7f-4a35-8c60-2d9e4f1b7a03", "name": "Alex Kim", "avatar_url": null, "role": "member", "tier": null },
  "effective_autonomy": "approve_actions",
  "escalated_to_person": true,
  "escalation": {
    "reason": "Wants their account deleted; needs a person to confirm ownership.",
    "source": "agent",
    "by": { "type": "agent", "id": "0f3e2d1c-6b5a-4c39-8e27-1d0c9b8a7f65", "name": "Billing agent" },
    "at": "2026-11-04T23:19:01.205Z",
    "group": { "id": "grp_5d0e7a3c-2b18-4f96-8c4d-1a9e6b3f0c72", "name": "Billing team" },
    "waiting": null,
    "respond_by": null
  }
}
```

- **Which group.** The `group` named in the call (the agent can read them with `list_groups`), else the group the request type routes to, else the workspace's default group. With none of these, the request waits unassigned and the workspace admins are told.
- **Who.** The group picks an available member, in turn or whoever is least busy. Outside working hours the request waits quietly until the next opening. If nobody is available during working hours, the admins are told once. When an assigned member misses the response window, the request passes once if there is an alternative. If the next window is missed, or there is no alternative, the assignee gets one reminder and the admins are told once. The timer then stops. Handoff email is limited to 20 messages per member per UTC day.
- **The requester** sees that a person will take it from here, not the assignee, reason or group. They see who actually replies on each reply.
- **The agent stays on.** It can still read the request, write internal notes and triage, but its public replies are held for a person to send, whatever the autonomy. It can't escalate the same request again while it's with a person (`409 {{handoff.code}}`).
- **Handing back.** When the person is done, a team member hands the request back to agents (in the request, or `DELETE /api/apps/<slug>/issues/<number>/escalation`). `escalation` becomes `null` and the agent's replies go out under its normal autonomy again.

Webhooks get `issue.escalated`, with the same `escalation`, when a request is handed to a person and again if it passes to the next member, and `issue.handed_back` when it comes back. Requesters can ask for a person themselves, with **Talk to a person** in the [chat widget](/docs/widget#behavior) or through the [public API](/docs/api#talking-to-a-person).

## Verifying an email

Before changing an account, an agent can ask the requester to prove an address, such as "the email on your billing account". `request_verification` (responder) emails that address a code that only the requester can enter, on the request page or in the chat widget:

```sh
curl -X POST https://blhp.app/mcp \
  -H "Authorization: Bearer $BELLHOP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "request_verification", "arguments": {"app": "acme", "number": 14, "email": "billing@example.com"}}}'
```

```json
{
  "id": "2e8f4b61-9c3d-4a07-b5e1-7f0a6d2c9b84",
  "email": "billing@example.com",
  "state": "pending",
  "created_at": "2026-11-04T21:37:09.929Z",
  "verified_at": null,
  "requested_by": { "type": "agent", "id": "0f3e2d1c-6b5a-4c39-8e27-1d0c9b8a7f65", "name": "Billing agent" }
}
```

The agent never sees the code. The result shows on the request's `verifications` as `verified`, `failed` or `expired`, and arrives as a `verification.completed` webhook. `get_contact` reads the requester's contact, with how they were verified and their other requests.

## Replying in their language

`list_issues`, `search_issues`, `get_issue` and webhooks include `reporter_locale`: the language the requester used when they wrote in, one of {{locales}}, or `null` for older requests. Write replies in it, held ones included, unless the conversation shows otherwise. Internal notes and approval summaries are for the team, so write those in the team's language.
