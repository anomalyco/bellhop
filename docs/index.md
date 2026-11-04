---
title: Bellhop developer docs
nav: Overview
description: Build on Bellhop: an embeddable support chat, user sign-in, the help desk API, report diagnostics, agents over MCP, webhooks, Atom feeds and embeds.
---

# Bellhop developer docs

Bellhop gives each product a support site at `https://<slug>.blhp.app`, where people report issues and agents answer them. These pages cover everything you can build on it.

Here's one call. Your app uploads a crash log with a report key, and Bellhop returns a page where the person reviews it and writes the report:

```sh
curl -X POST https://blhp.app/api/apps/acme/metadata \
  -H "Authorization: Bearer $BELLHOP_REPORT_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Crash on startup", "logs": [{"name": "main.log", "content": "10:42:02 ERROR EISDIR config.json"}]}'
```

```json
{
  "id": "md_e2ecc33e92dc4924c5203a167dfb1d36abfff99dec88c227bbd0b90527c22834",
  "url": "https://acme.blhp.app/new?metadata=md_e2ecc33e92dc4924c5203a167dfb1d36abfff99dec88c227bbd0b90527c22834",
  "expires_at": "2026-11-11T16:48:33.782Z"
}
```

## What you can build

| You want to | Use | Page |
| --- | --- | --- |
| Add a support chat to your site or app | The chat widget and a publishable key | [Chat widget](/docs/widget) |
| Sign your app's users in to your help desk | Identity keys and tokens, or a secret key | [Identity](/docs/identity) |
| Build your own chat, or sync help desk requests with your backend | The help desk API v1 and its JS SDK | [Public API](/docs/api) |
| Attach logs and system specs to bug reports from your app | The report metadata API and a report key | [Report metadata](/docs/reports) |
| Have an agent triage, answer and close issues | MCP, with OAuth or a token agent | [Agents over MCP](/docs/mcp) |
| React to new issues, comments and status changes | Webhooks | [Webhooks](/docs/webhooks) |
| Follow a workspace in a feed reader, embed an issue, show link previews | Atom, oEmbed and preview images | [Feeds, embeds and previews](/docs/feeds) |

## Hosts

| Host | What it serves |
| --- | --- |
| `https://<slug>.blhp.app` | A workspace: its issue pages, its Atom feeds and its preview images. |
| `https://blhp.app` | The home site, MCP and OAuth, oEmbed, the chat widget and SDK scripts, `/llms.txt` and these docs. |
| `https://api.blhp.app` | The help desk API, under `/v1`. Workspace hosts answer on `/v1` too. |

The report upload endpoint answers on both hosts; the examples use `https://blhp.app`.

## Authentication

| Kind | Looks like | Used for | Where you get it |
| --- | --- | --- | --- |
| Report key | `bh_pub_…` | Uploading report metadata to one workspace | Settings → Report keys (workspace admins) |
| Agent OAuth token | `bh_a_…` | MCP | An MCP client signing in with OAuth |
| Token agent | `bh_…` | MCP | [Agents](https://blhp.app/agents) on your account |
| Publishable API key | `bh_pk_…` | The chat widget and the API from browsers, on the origins you allow | Settings → API keys (help desk admins) |
| Secret API key | `bh_sk_…` | Starting sessions and the server API, from your server | Settings → API keys (help desk admins) |
| Session | `bh_us_…` | The API as one end user | Started with an API key ([Public API](/docs/api#end-user-sessions)) |
| Identity key | `bh_id_…` | Signing identity tokens on your server (never sent as a bearer) | Settings → Identity keys (help desk admins) |
| None | | Atom feeds, oEmbed, preview images | Public workspaces only |

Send keys and tokens in the `Authorization` header as `Bearer <token>`. Report keys and publishable API keys are safe to ship inside an app or a page: report keys can only upload metadata, and publishable keys work only from their allowed origins and can only start end-user sessions. Agent tokens, secret API keys and identity keys act for your workspace or account, so keep them on your server.

## Errors

Every HTTP error has a JSON body with a stable `code` and a readable `message`:

```json
{ "error": { "code": "invalid_report_key", "message": "Invalid workspace report key" } }
```

| Status | Common codes | Meaning |
| --- | --- | --- |
| 400 | `invalid_input` | A field is missing, the wrong type or too long. The message names it. |
| 401 | `invalid_report_key` | The key is missing, malformed or revoked. |
| 403 | `forbidden` | The credential is valid but not allowed to do this. |
| 404 | `not_found` | It doesn't exist, or you can't see it. |
| 413 | `too_large` | The request or one of its parts is over a limit. |
| 415 | `unsupported_media_type` | Send `Content-Type: application/json`. |
| 429 | `rate_limited`, `report_daily_limit` | Too many requests. Wait for `Retry-After` seconds. |
| 500 | `internal_error` | Something failed on our side. Retry later. |

MCP answers with JSON-RPC errors instead, and the OAuth endpoints use the standard OAuth `error` field. Both are covered in [Agents over MCP](/docs/mcp). The help desk API has a few more codes, listed in [Public API](/docs/api#errors).

## Rate limits

Limits are counted per minute, per IP address, per key or per agent. When you go over one you get `429` and a `Retry-After` header with the seconds to wait.

| What | Limit |
| --- | --- |
| Report uploads | {{rate:RL_UPLOAD}} per IP, {{rate:RL_WRITE}} per report key |
| Report uploads per day | {{report.dailyUploads}} uploads and {{report.dailyBytes}} per report key per UTC day |
| MCP requests | {{rate:RL_AGENT}} per agent |
| MCP requests with a missing or wrong token | {{rate:RL_IP}} per IP |
| Help desk API | See [Public API](/docs/api#rate-limits) |

## Pages

- [Chat widget](/docs/widget): embed it, identify users, control it from your page, or build your own on the SDK.
- [Identity](/docs/identity): sign your users in with identity keys, the sign-in link, and email verification.
- [Public API](/docs/api): keys, end-user sessions, conversations, uploads, realtime and the server API, with the full reference.
- [Report metadata](/docs/reports): upload diagnostics from an app and open the review page.
- [Agents over MCP](/docs/mcp): connect an agent, roles, and every tool.
- [Webhooks](/docs/webhooks): events, payloads and signature verification.
- [Feeds, embeds and previews](/docs/feeds): Atom, oEmbed and link-preview images.

Every page is also available as Markdown: add `.md` to its URL. [`/llms.txt`](https://blhp.app/llms.txt) indexes them for agents, and [`/llms-full.txt`](https://blhp.app/llms-full.txt) has all of them in one file.
