---
title: Feeds, embeds and previews
nav: Feeds and embeds
description: Follow a public workspace or one issue as an Atom feed, embed issues with oEmbed, and use Bellhop's link-preview images. No authentication needed.
---

# Feeds, embeds and previews

Public workspaces publish their issues as Atom feeds, answer oEmbed requests and have a preview image for every page. None of it needs a key, and none of it ever includes private, hidden or internal content.

```sh
curl https://acme.blhp.app/feed.atom
```

```xml
<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>https://acme.blhp.app/feed.atom</id><title>Acme issues</title><updated>2026-11-04T03:16:19.489Z</updated><author><name>Bellhop</name></author><link rel="alternate" href="https://acme.blhp.app/"/><link rel="self" type="application/atom+xml" href="https://acme.blhp.app/feed.atom"/><entry><id>tag:blhp.app,2026:issue/ffac947e-37c2-4952-9934-1c668496ba37</id><title>Guest author feed check</title><updated>2026-11-04T03:16:19.489Z</updated><link rel="alternate" href="https://acme.blhp.app/issues/2"/>…</entry></feed>
```

## Atom feeds

| Feed | URL | Entries |
| --- | --- | --- |
| A workspace | `https://<slug>.blhp.app/feed.atom` | Its 50 most recently updated issues, with title, author and the start of the description. |
| One issue | `https://<slug>.blhp.app/issues/<number>/feed.atom` | Its 50 latest public replies and status changes. |

Workspace and issue pages link their feed with `<link rel="alternate" type="application/atom+xml">`, so feed readers find it from the page URL. Public workspaces' feeds can be cached for a minute (`s-maxage=60`).

Entries are plain text: titles, author names and summaries of up to 320 characters, never the full description. Email addresses are never shown as author names.

## oEmbed

`GET https://blhp.app/oembed?url=<url>&format=json`

`url` is an issue (`https://<slug>.blhp.app/issues/<number>`) or a workspace (`https://<slug>.blhp.app/`). The answer is an oEmbed `link` with the preview image as its thumbnail:

```sh
curl "https://blhp.app/oembed?url=https%3A%2F%2Facme.blhp.app%2Fissues%2F2&format=json"
```

```json
{
  "version": "1.0",
  "type": "link",
  "title": "Guest author feed check",
  "author_name": "Renamed reporter",
  "provider_name": "Bellhop",
  "provider_url": "https://blhp.app",
  "thumbnail_url": "https://acme.blhp.app/og/issues/2.png",
  "thumbnail_width": 1200,
  "thumbnail_height": 630
}
```

Only `format=json` is supported. Bellhop never fetches the URL you pass; it reads it and looks up the issue itself. Anything that isn't a public issue in a listed workspace gets `404`. Listed pages advertise the endpoint with `<link rel="alternate" type="application/json+oembed">`.

## Preview images

Every workspace and issue page has a 1200×630 PNG card in its `og:image` and `twitter:image` tags:

| Card | URL |
| --- | --- |
| Bellhop | `https://blhp.app/og/home.png` |
| A workspace | `https://<slug>.blhp.app/og/app.png?v=<version>` |
| An issue | `https://<slug>.blhp.app/og/issues/<number>.png?v=<version>` |
| A docs page | `https://blhp.app/og/docs/<page>.png?v=<version>` |

An issue card shows its title, number, status and labels, and who answered if an agent did. `v` changes whenever anything on the card changes, so each version can be cached forever. Use the URLs from the page's tags rather than building them: the version is part of the URL.

## What's included

Feeds, oEmbed and cards only ever show what anyone could see on the public page:

- **Private issues**, **hidden issues and comments** and **internal notes** never appear. A private, hidden or deleted issue's card is the workspace card.
- **Unlisted workspaces** (not public) don't answer oEmbed and aren't in sitemaps. Their feeds and cards still work for anyone who has the workspace's link, like the workspace itself. Their feeds are marked `noindex` and aren't cached publicly.
- Nothing depends on cookies or who's asking: a team member and a stranger get the same feed.
