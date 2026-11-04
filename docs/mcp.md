---
title: Agents over MCP
nav: Agents over MCP
description: Connect an agent to Bellhop with the Model Context Protocol: OAuth, the device flow and token agents, roles, what agents can see, and every tool.
---

# Agents over MCP

Agents read and work issues through one MCP server. An agent belongs to a person's account, acts in the workspaces they choose, and its posts carry an AI badge.

```sh
curl -X POST https://blhp.app/mcp \
  -H "Authorization: Bearer $BELLHOP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_issues", "arguments": {"app": "acme", "state": "open", "limit": 1}}}'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"issues\":[{\"id\":\"6b47ebb0-3421-4694-84b3-291b78042565\",\"number\":41,\"title\":\"Curl upload from the new key\",\"status\":\"open\",\"close_reason\":null,\"created_at\":\"2026-11-04T08:02:28.239Z\",\"updated_at\":\"2026-11-04T08:02:28.239Z\",\"comment_count\":0,\"votes\":0,\"viewer_voted\":false,\"pinned\":false,\"locked\":false,\"private\":false,\"hidden\":null,\"author\":{\"type\":\"guest\",\"id\":\"def39ae8ef11979748ed8741dd2b145a\",\"handle\":\"guest-def3\",\"name\":\"Dana (Desktop)\",\"tier\":null,\"display_name\":\"Dana (Desktop) (guest-def3)\"},\"assignee\":null,\"activity\":null,\"labels\":[{\"id\":\"a5e92ff4-9315-4b65-8e92-ded9f11f58ba\",\"name\":\"bug\",\"color\":\"d73a4a\",\"description\":\"Something isn’t working\"}],\"reporter_locale\":null,\"contact\":null,\"request_type\":null,\"fields\":{},\"verifications\":[]}],\"pinned\":[],\"counts\":{\"open\":10,\"closed\":8},\"next_cursor\":\"41\"}"
      }
    ]
  }
}
```

Most MCP clients do all of this for you. Give them the endpoint and they sign in with OAuth.

## The endpoint

`https://blhp.app/mcp` speaks MCP over Streamable HTTP. Send JSON-RPC 2.0 requests with `POST`; every answer is a single JSON response (no event stream). `GET` and `DELETE` get `405`. The server supports `initialize`, `ping`, `tools/list` and `tools/call`.

Tool results come back as `content` with one `text` item holding JSON, except `get_attachment`, which returns images as `image` content. Every tool except `list_apps` and `create_app` takes an optional `app` (a workspace slug). It's required when the agent can use more than one workspace.

## Connect with OAuth

Bellhop is both the OAuth authorization server and the protected resource. Clients need nothing configured beyond the endpoint URL.

1. A request to `/mcp` without a valid token gets `401` with `WWW-Authenticate: Bearer resource_metadata="https://blhp.app/.well-known/oauth-protected-resource"`.
2. The client reads [`/.well-known/oauth-protected-resource`](https://blhp.app/.well-known/oauth-protected-resource) (RFC 9728), then [`/.well-known/oauth-authorization-server`](https://blhp.app/.well-known/oauth-authorization-server) (RFC 8414).
3. It registers itself at `POST /oauth/register` (RFC 7591). Only public clients are supported (`token_endpoint_auth_method: "none"`).
4. It sends the person to `/oauth/authorize` with the authorization code flow and PKCE. `code_challenge_method` must be `S256`. The optional `scope` is `mcp`, and the optional `resource` must be `https://blhp.app/mcp`.
5. The person signs in and chooses what the agent gets: which workspaces and at what role (or all of them), and whether it may create workspaces.
6. The client exchanges the code at `POST /oauth/token`.

Access tokens look like `bh_a_…` and last one hour. Refresh tokens last 60 days and rotate: every refresh returns a new one, and the old one stops working. Using a spent refresh token again revokes the agent, in case it was stolen. Revoke with `POST /oauth/revoke` (RFC 7009), or remove the agent on the [Agents](https://blhp.app/agents) page.

Redirect URIs must be HTTPS, a custom scheme, or `http` on `localhost` or `127.0.0.1`. They're matched exactly.

### Headless agents: the device flow

Agents with no browser, like CI jobs or servers, use the device flow (RFC 8628). Register a client that allows the device grant:

```sh
curl -X POST https://blhp.app/oauth/register \
  -H "Content-Type: application/json" \
  -d '{"client_name": "Acme CI agent", "grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"]}'
```

```json
{
  "client_id": "18a64449-8664-4446-b7d5-bf965fe59b9e",
  "client_id_issued_at": 1793811113,
  "client_name": "Acme CI agent",
  "redirect_uris": [],
  "grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
  "response_types": [],
  "token_endpoint_auth_method": "none"
}
```

Then ask for a code:

```sh
curl -X POST https://blhp.app/oauth/device -d client_id=18a64449-8664-4446-b7d5-bf965fe59b9e
```

```json
{
  "device_code": "4610fecd36f106d7f4affcf3e63ec940fb21d06aa956948fa94b98b4907008e6",
  "user_code": "5HH3-XBM8",
  "verification_uri": "https://blhp.app/device",
  "verification_uri_complete": "https://blhp.app/device?code=5HH3-XBM8",
  "expires_in": 600,
  "interval": 5
}
```

Show the person `user_code` and `verification_uri`. They open it, sign in, enter the code and approve. Meanwhile, poll every `interval` seconds:

```sh
curl -X POST https://blhp.app/oauth/token \
  -d grant_type=urn:ietf:params:oauth:grant-type:device_code \
  -d device_code=4610fecd36f106d7f4affcf3e63ec940fb21d06aa956948fa94b98b4907008e6 \
  -d client_id=18a64449-8664-4446-b7d5-bf965fe59b9e
```

```json
{ "error": "authorization_pending", "error_description": "Waiting for user authorization" }
```

Keep polling on `authorization_pending`. On `slow_down`, add 5 seconds to your interval. `access_denied` means they declined, and `expired_token` means the 10 minutes ran out. Once they approve, the same request returns `access_token`, `refresh_token`, `token_type: "Bearer"`, `expires_in` and `scope`.

The OAuth endpoints answer errors in the OAuth format (`error` and `error_description`), not Bellhop's usual `{ "error": { "code" } }` shape.

## Connect with a token agent

For scripts and servers you control, a static token is simpler. On [Agents](https://blhp.app/agents), choose **New token agent**, name it, and pick its workspaces and roles. The secret looks like `bh_` followed by 64 hex characters and is shown once. You can rotate it (the old one stops working at once) or revoke the agent there.

Send it like any bearer token: `Authorization: Bearer bh_…`.

## Client setup

### OpenCode

Add the server and sign in with OAuth:

```sh
opencode mcp add bellhop --global --url https://blhp.app/mcp
```

Then run `/mcps` in OpenCode, select `bellhop` and sign in. To use a token agent instead, turn OAuth off and send the token from an environment variable:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "bellhop": {
        "type": "remote",
        "url": "https://blhp.app/mcp",
        "oauth": false,
        "headers": { "Authorization": "Bearer {env:BELLHOP_TOKEN}" },
      },
    },
  },
}
```

### Claude Code

```sh
claude mcp add --transport http bellhop https://blhp.app/mcp
```

Run `/mcp` in Claude Code to sign in. With a token agent, pass the header instead:

```sh
claude mcp add --transport http bellhop https://blhp.app/mcp --header "Authorization: Bearer $BELLHOP_TOKEN"
```

## Roles

An agent has a role in each workspace it can use:

| Agent role | Can |
| --- | --- |
| `viewer` | Read: issues, comments, internal notes, attachments, report metadata, labels, templates, saved replies, tiers. |
| `responder` | Everything a viewer can, plus comment, leave internal notes, edit its own comments and show activity. |
| `member` | Everything a responder can, plus triage: status, labels, assignment, relations, moderation, moving issues, tiers and analytics. |
| `admin` | Everything a member can, plus workspace setup: details, labels, templates, webhook and members. |

An agent never goes above the person who approved it. Their current role in that workspace sets the most the agent can have, and the agent loses access when they do:

| Their role | Most the agent can have |
| --- | --- |
| Owner or admin | `admin` |
| Member | `member` |
| Viewer | `responder` |

Instead of listing workspaces, a grant can cover **all workspaces** at one role. That includes workspaces the person joins or creates later, and each one can still be given its own role or left out. A grant can also allow creating workspaces with `create_app`. The person owns the new workspace and the agent is its admin.

Workspace admins see every agent with access in **Settings → Agents** and can lower an agent's role there or remove it from the workspace.

## What agents see

Agents see a workspace the way its team does:

- private issues, and hidden issues and comments (with `hidden` set to the moderation details);
- internal notes, the team-only comments with `internal: true`;
- system info and attached report metadata, including the logs, which `get_attachment` reads as text;
- reporter tiers on authors, for routing.

An agent's comments are public replies unless it sends `internal: true`. If a reporter's tier doesn't allow agent replies, a public `comment` fails with the code `humans_only`; leave an internal note and a person will answer. Comments an agent writes don't trigger `comment.created` or `comment.edited` webhooks, so an agent never wakes itself, but people it @mentions still get `mention.created`.

`list_issues`, `search_issues` and `get_issue` include `reporter_locale`, the reporter's interface language when they opened the issue: one of {{locales}}, or `null` for older issues. Reply in it unless the conversation shows otherwise.

### Help desks

In a workspace in help desk mode, every issue is a private request from a contact, and agents get a few more things:

- `get_issue` and `list_issues` carry the requester's `contact` (their verified email, your app's `external_id` for them, and how they verified) and the request's email `verifications`.
- `get_contact` reads a contact by `id`, `email` or `external_id`, with their other requests.
- `request_verification` (responder) asks the requester to prove an address, such as the email on their billing account. Bellhop emails it a code that only the requester can enter; the agent sees the result on the issue and in a `verification.completed` [webhook](/docs/webhooks), never the code.
- `list_request_types` reads the request types ("Billing", "Account access") with their form fields, routing and autonomy, and `get_issue` includes the request's `request_type`, its `fields` and the effective autonomy. `set_request_type` (member) moves a request to another type and applies that type's routing.

People reach a help desk through its site, the [chat widget](/docs/widget) or the [public API](/docs/api), and replies from agents reach them there.

## Tools

This reference is generated from the same definitions `tools/list` returns, grouped by the least role an agent needs in the workspace. Arguments marked \* are required, and they're strings unless a type is given. The optional `app` argument isn't listed (see [The endpoint](#the-endpoint)).

{{table:mcp-tools}}

## Errors and limits

Problems with the request itself come back as JSON-RPC errors:

| HTTP | JSON-RPC code | Meaning |
| --- | --- | --- |
| 401 | `-32001` | The token is missing, malformed, expired or revoked. |
| 403 | `-32003` | The agent's role is too low, the workspace isn't in its grant, or `data.code` is `humans_only`. |
| 400 | `-32600` | Not a valid JSON-RPC request. |
| 200 | `-32601` | Unknown method. |
| 200 | `-32602` | Invalid params, such as a missing tool name. |
| 400 | `-32700` | The body isn't JSON. |
| 429 | `-32029` | Over the rate limit. Wait `Retry-After` seconds. A `tools/call` over the limit gets a tool result instead, with `isError: true` and `structuredContent.error.code` set to `rate_limited`. |

When a tool runs but fails, for example on a bad argument or a missing issue, the result has `isError: true` and the message in its text.

| Limit | Value |
| --- | --- |
| Requests per agent | {{rate:RL_AGENT}} |
| Requests with a missing or wrong token | {{rate:RL_IP}} per IP |
| Comments per author | {{mcp.commentsPerHour}} per hour; over it, the tool answers `429` with `Retry-After: 3600` |
