// The contract between the Worker (worker/) and the web app (src/). JSON over HTTP; times are ISO 8601 strings.
//
// Roles
// - guest: anyone, no account. Identified by an HttpOnly `bh_guest` cookie the Worker sets on first contact, so
//   one browser (one machine) is one guest. A guest picks a display name before their first post; it's kept per
//   browser and stamped on what they write.
//   Writing (uploads, new issues, comments) also needs the `bh_human` cookie, set by POST /api/human after Turnstile.
// - account: signed in with Google. Posts as their account on every app (no Turnstile), whether or not they're on
//   that app's team. Signing in claims everything this browser wrote as a guest: those posts move to the account
//   and open pages update live (`actor.updated`).
// - team: an account with a Role in the application. Each role includes the ones below it:
//     viewer  reads everything in the app (system info; later private issues and internal notes) and posts like any
//             account
//     member  + triage: status, labels on issues, assignee, relations, claim
//     admin   + workspace setup: name, description, icon, labels, templates, webhooks, agents and tokens, members up
//             to admin
//     owner   + owners and admins, ownership transfer, deleting the app; an app always keeps at least one owner
// - agent: belongs to an account, not a workspace. Either an OAuth connection (an MCP client signed in through
//   /oauth) or a token agent the account created (a static secret). Either way it lists the workspaces it may use
//   (only ones where the account has a role) with an AgentRole per app, or covers all of them ("all workspaces",
//   which includes ones the account creates or joins later) at one role, with per-app overrides or exclusions:
//     viewer (read only) < responder (+ comment, activity, votes) < member (+ triage) < admin (+ workspace setup).
//     An OAuth agent never exceeds the approving user's current role (an owner's agent is at most admin). Grants may
//     also allow creating workspaces: the approving user owns them and the agent gets admin. Agent posts carry the AI
//     badge.
//
// - contact: a requester in a help desk workspace (AppDetail.mode "helpdesk"). A per-workspace identity, never an
//   account: signed in on that workspace's host with an email code, or by a host-signed identity token (the host
//   app's own signed-in user, e.g. from Console or the chat widget). Signing in moves this browser's guest posts in
//   that workspace to the contact, and the contact's requests follow them to any device. Signed-in contacts post
//   without Turnstile. The workspace team and agents see a contact's email and external id; nobody else does.
//
// Routes (all under the Worker; everything else is the single-page app)
//   GET    /api/config                                   -> Config
//   GET    /api/me                                       -> Me
//   POST   /api/human              { token }             -> { ok: true }       Turnstile check, sets bh_human (1 hour)
//   PUT    /api/me/guest           { name }              -> Me                 guest + human; sets the display name
//   PUT    /api/me/locale          { locale: Locale | null } -> Me             anyone; null goes back to the browser's
//          language. Saved on the account, or for guests in a bh_locale cookie.
//   GET    /api/apps                                     -> App[]              signed in: workspaces I'm on
//   GET    /api/feed?state=open|closed&q=<text>&cursor=  -> FeedList           public: issues in public workspaces,
//                                                                             most recently active first (blhp.app home)
//   GET    /api/feed/apps                                -> FeedApp[]          public: the public workspaces
//   GET    /api/page?path=<path and query>               -> PagePayload        everything one page needs, for the
//          viewer, in one round trip (client navigation and prefetch). The Worker also embeds the same payload in
//          every page's HTML as <script id="bh-boot" type="application/json">, so the first paint needs no API calls;
//          those page responses are then private, no-store.
//   GET    /api/me/reports?state=open|closed&cursor=     -> FeedList           issues this browser (any guest id it
//          has used) or the signed-in account opened, across workspaces, newest activity first; includes their own
//          private issues, never hidden or deleted ones
//   List search (q) qualifiers, combinable with free text: is:open|closed|private|locked|pinned|hidden (hidden: team
//   only), status:open|in_progress|waiting|closed, reason:completed|not_planned|duplicate, label:<name> (repeatable,
//   all must match), no:label, no:assignee, assignee:@me|<handle>, author:@me|<handle>, has:metadata,
//   sort:<IssueSort>. Unknown qualifiers are treated as text. author:@me is this browser's guest id or the account.
//   Help desk (team only): is:held (has a held agent reply), is:awaiting-approval (has a pending approval),
//   type:<request type name>.
//   POST   /api/apps               NewApp                -> AppDetail          member; seeds default labels and templates
//   GET    /api/apps/:slug                               -> AppDetail          public
//   PATCH  /api/apps/:slug         { name?, description?, public?, visibility?, nudge_days?, mode?, helpdesk? }
//          -> AppDetail   admin; mode "helpdesk" makes new issues private and hides the workspace (see Help desk);
//          nudge_days (1-30, or null for off): email the reporter once when an issue has waited on them that many days.
//          Never closes anything.
//   POST   /api/apps/:slug/transfer { member_id }        -> AppSettings        owner; that member becomes an owner too
//   PUT    /api/apps/:slug/icon    body: raw image bytes, Content-Type png/jpeg/webp, ≤ 1 MB -> AppDetail  admin
//   DELETE /api/apps/:slug/icon                          -> AppDetail          admin; back to the Bellhop mark
//   GET    /icon/:slug/:version                          -> the app's icon (public, immutable; SVG is not accepted)
//   GET    /api/apps/:slug/settings                      -> AppSettings        member
//   PUT    /api/apps/:slug/webhook { url: string|null, events?: WebhookEventType[] } -> AppSettings   admin; events
//          defaults to DEFAULT_WEBHOOK_EVENTS (today's behaviour)
//   POST   /api/apps/:slug/webhook/deliveries/:id/redeliver -> { delivery_id }   admin; same payload, new delivery id
//   POST   /api/apps/:slug/webhook/rotate                -> AppSettings        admin; read the new secret via GET settings
//   POST   /api/apps/:slug/webhook/test                  -> { delivery_id }    admin; sends a `ping` event
//   GET    /api/apps/:slug/agents                        -> AppAgent[]         admin; every agent with access here
//   PATCH  /api/apps/:slug/agents/:id { role }           -> AppAgent           admin; capped at the approver's role
//   DELETE /api/apps/:slug/agents/:id                    -> { ok: true }       admin; removes this app from the agent
//                                                                             (an exclusion if it has all workspaces)
//   POST   /api/apps/:slug/members { email, role? }      -> AppSettings        admin; role defaults to "member". An
//          invitation: nobody joins until they accept it (accounts see it under /api/me/invitations; a new person
//          accepts after signing in). Pending invitees get no access, no email and no agent access there.
//   DELETE /api/apps/:slug/members/me                    -> { ok: true }       leave the workspace (not the last owner)
//   GET    /api/me/invitations                           -> Invitation[]       signed in
//   POST   /api/me/invitations/:id/accept                -> App                signed in; that invitation's email only
//   POST   /api/me/invitations/:id/decline               -> { ok: true }
//   PATCH  /api/apps/:slug/members/:id { role }          -> AppSettings        admin
//   DELETE /api/apps/:slug/members/:id                   -> AppSettings        admin
//          Granting, changing or removing admin/owner needs an owner; the last owner can't be removed or demoted.
//   POST   /api/apps/:slug/labels  LabelInput            -> Label              admin
//   PATCH  /api/apps/:slug/labels/:id LabelInput         -> Label              admin
//   DELETE /api/apps/:slug/labels/:id                    -> { ok: true }       admin
//   POST   /api/apps/:slug/templates TemplateInput       -> Template           admin
//   PATCH  /api/apps/:slug/templates/:id TemplateInput   -> Template           admin
//   DELETE /api/apps/:slug/templates/:id                 -> { ok: true }       admin
//   GET    /api/apps/:slug/issues?state=open|closed&label=<name>&q=<text>&sort=<IssueSort>&cursor=  -> IssueList
//          public; private
//          issues only for the team and their reporter; hidden issues only for the team (q "is:hidden" lists them)
//   POST   /api/apps/:slug/issues  NewIssue              -> Issue              guest + human, or member
//   GET    /api/apps/:slug/issues/:number                -> Issue              public (system_info only for the team)
//   PATCH  /api/apps/:slug/issues/:number IssuePatch     -> Issue              member; the author (guest + human, or
//          account) may edit title/body, close it (completed or not_planned) or reopen it, and set `private` when the
//          app lets reporters choose
//   DELETE /api/apps/:slug/issues/:number                -> { ok: true }       admin; permanent (comments, attachments,
//          events, relations). The number stays taken: GET then answers 410 with code "deleted".
//   POST   /api/apps/:slug/issues/:number/hide { reason: ModerationReason } -> Issue   member
//   DELETE /api/apps/:slug/issues/:number/hide           -> Issue              member; unhide
//   GET    /api/apps/:slug/issues/similar?title=<text>   -> IssueRef[]         public: up to 5 likely duplicates the
//          viewer may see, best first (for the new-issue page as people type)
//   GET    /api/apps/:slug/issues/:number/history        -> Revision[]         whoever can see the issue; title/body
//   POST   /api/apps/:slug/issues/:number/vote           -> { votes, viewer_voted }   guest + human, or account ("Me too")
//   DELETE /api/apps/:slug/issues/:number/vote           -> { votes, viewer_voted }
//   POST   /api/apps/:slug/issues/:number/transfer { app } -> Issue           member in both apps; moves it to `app`
//          (slug) with a new number. Labels carry over by name, the assignee only if on that team; relations drop.
//          The old URL then answers 404 with code "moved" and `moved_to`.
//   GET    /api/apps/:slug/mentionables                  -> Mentionable[]      team (viewer and up): @ autocomplete
//   PATCH  /api/apps/:slug/issues/:number/comments/:id { body } -> Comment     the author (guest + human, or account)
//   DELETE /api/apps/:slug/issues/:number/comments/:id   -> { ok: true }       the author, or member
//   POST   /api/apps/:slug/issues/:number/comments/:id/hide { reason } -> Comment   member
//   DELETE /api/apps/:slug/issues/:number/comments/:id/hide -> Comment         member
//   GET    /api/apps/:slug/issues/:number/comments/:id/history -> Revision[]   whoever can see the comment
//   POST   /api/apps/:slug/issues/:number/comments/:id/helpful -> { helpful, viewer_helpful }   guest + human, or
//          account; not the comment's author ("This helped")
//   DELETE /api/apps/:slug/issues/:number/comments/:id/helpful -> { helpful, viewer_helpful }
//   GET    /api/apps/:slug/tiers                         -> Tier[]             member
//   POST   /api/apps/:slug/tiers   TierInput             -> Tier               admin
//   PATCH  /api/apps/:slug/tiers/:id TierInput           -> Tier               admin
//   DELETE /api/apps/:slug/tiers/:id                     -> { ok: true }       admin; its people lose the tier
//   GET    /api/apps/:slug/people?tier=<id>&q=<text>     -> Person[]           member; people with a tier (or all
//                                                                             reporters when no tier is given)
//   PUT    /api/apps/:slug/people/tier { email?, actor_id?, tier_id: string | null } -> Person   member; by email for
//          accounts (applies when that email signs in, like invites) or by actor id for a guest or account. Never
//          for team members or agents.
// Report metadata: an app (e.g. a crash dialog) uploads logs and system specs first; the person then opens the
// returned URL, a new-issue page with that metadata attached, reviews or removes items, and writes what happened.
// The API never creates an issue. Unattached metadata expires after 7 days (its logs are deleted).
//   POST   /api/apps/:slug/metadata ReportMetadataInput  -> ReportMetadataCreated   Authorization: Bearer <report key>
//          (publishable, safe to ship in an app: it can only upload metadata; limited per key and per IP). JSON up to
//          10 MB in total; logs are text.
//   GET    /api/apps/:slug/metadata/:id                  -> ReportMetadata    anyone with the id until it's attached;
//          afterwards the team, agents and the reporter
//   DELETE /api/apps/:slug/metadata/:id/items { logs?: string[] (names), system?: string[] (keys), context?: string[] }
//          -> ReportMetadata   the person reviewing it before submitting (only while unattached)
//   GET    /api/apps/:slug/report-keys                   -> ReportKey[]        admin
//   POST   /api/apps/:slug/report-keys { name }          -> NewReportKey       admin; the key is shown once
//   DELETE /api/apps/:slug/report-keys/:id               -> { ok: true }       admin
//   Pages: https://<slug>.blhp.app/new?metadata=<id> (and /<slug>/new?metadata= in path mode) opens new issue with it
//   attached and its title suggested; https://blhp.app/new?metadata=<id> redirects to the right workspace.
//   GET    /api/apps/:slug/saved-replies                 -> SavedReply[]       team (viewer and up) and agents
//   POST   /api/apps/:slug/saved-replies SavedReplyInput -> SavedReply         member
//   PATCH  /api/apps/:slug/saved-replies/:id SavedReplyInput -> SavedReply     member
//   DELETE /api/apps/:slug/saved-replies/:id             -> { ok: true }       member
//   GET    /api/apps/:slug/audit?cursor=&actor=&action=  -> AuditPage          admin; newest first, kept 90 days
//   GET    /api/apps/:slug/analytics?days=7|30|90        -> Analytics          member
//   GET    /api/apps/:slug/export                        -> NDJSON download    admin; one JSON object per line: the
//          app, labels, templates, tiers, members, then each issue with its comments (notes included), events, votes
//          and attachment URLs. Never secrets (webhook secret, keys, tokens).
//   POST   /api/apps/:slug/import/github { repo: "owner/name", token, state?: "open"|"all" } -> ImportJob   admin;
//          copies issues, comments and labels in the background. The token is used for this job only and then
//          deleted. Authors become guest actors named "@login"; issues carry `imported`.
//   GET    /api/apps/:slug/import                        -> ImportJob | null   admin; the workspace's most recent import
//   GET    /api/apps/:slug/import/:id                    -> ImportJob          admin
//   GET    /oembed?url=<issue or workspace URL>&format=json -> oEmbed JSON     public issues and public workspaces only
//   GET    /api/apps/:slug/blocks                        -> Block[]            member
//   POST   /api/apps/:slug/blocks { actor_id, hide_content? } -> Block         member; a guest (per-app id) or account
//          that isn't on the team. Blocked actors get 403 code "blocked" on posting, editing and uploading here.
//          hide_content hides everything they wrote here (reason "spam").
//   DELETE /api/apps/:slug/blocks/:id                    -> { ok: true }       member; doesn't unhide content
//   POST   /api/apps/:slug/issues/:number/comments NewComment -> Comment        guest + human, or member
//   POST   /api/apps/:slug/issues/:number/relations { type, number } -> Issue   member
//   DELETE /api/apps/:slug/issues/:number/relations/:relation_id   -> Issue     member
//   POST   /api/apps/:slug/uploads?name=<file name>  body: raw bytes, Content-Type: the file's type -> Attachment
//                                                                             guest + human, or member. Images ≤ 10 MB,
//                                                                             video ≤ 100 MB, other files ≤ 25 MB
//   GET    /media/:attachment_id/:file_name              -> the file, with Range support (video seeking). Attachments
//          of public issues are public and edge-cacheable; of private or hidden issues, and of hidden comments, only
//          for whoever can see them (404 otherwise, never cached publicly).
//   GET    /api/live/apps/:slug                          WebSocket, list page: LiveEvent
//   GET    /api/live/apps/:slug/issues/:number           WebSocket, issue page: LiveEvent
//   GET    /api/live/feed                                WebSocket, home feed: LiveEvent (feed.issue, activity)
// Atom feeds, public and visibility-filtered like the list (no notes, private or hidden content), linked from pages:
//   GET    /feed.atom              a workspace's recently opened and updated issues (on its host)
//   GET    /issues/:number/feed.atom   an issue's public replies and status changes
// Search engines, answered by the Worker per host:
//   GET    /robots.txt    home and public workspaces: allow all, with a Sitemap line; private workspaces: Disallow: /
//   GET    /sitemap.xml   home: a sitemap index of the public workspaces; a public workspace: its issue URLs (lastmod)
//   Page requests (HTML) go through the Worker, which serves the SPA's index.html with a per-page <head> (title,
//   description, canonical, Open Graph/Twitter tags, theme-color, the workspace's icon) and the right status:
//   private workspaces get X-Robots-Tag: noindex, and an unknown workspace subdomain or issue answers 404.
// Link preview images (1200x630 PNG, cached forever per version):
//   GET    /og/home.png                                  the home card
//   GET    /og/app.png?v=<hash>                          a workspace card (on its host)
//   GET    /og/issues/:number.png?v=<hash>               an issue card; private, hidden or deleted issues get the
//                                                        workspace card
//   GET    /auth/google  ->  Google OAuth  ->  /auth/google/callback  (then redirect to ?next= or /)
//   GET    /auth/dev?email=<email>&next=<path>           only when DEV_LOGIN=1
//   POST   /auth/logout
//   POST   /auth/email/start       { email }             -> { ok: true }       human; sends a same-browser sign-in code,
//                                                                             or Google instructions for a linked account
//   POST   /auth/email/verify      { email, code }       -> { ok: true }       use /api/me to read the session. Valid email
//       codes create/sign in email-only accounts and send a new-sign-in notice. A verified Google sign-in links the
//       same email; thereafter only Google can sign in. Wrong, expired or other-browser codes return 400 invalid_code.
//   Sign-in and verification codes: 6 digits, valid 10 minutes, single use; 5 wrong tries end the code; rate limited
//   per address, per IP and per workspace (429). The same answer whether or not the address has an account.
//   POST   /mcp                                          MCP, Streamable HTTP, Authorization: Bearer <token>
//                                                         (an app's agent token, or an OAuth access token; see below)
//
// OAuth for agents (MCP clients). blhp.app is both the authorization server and the protected resource; OAuth 2.1
// public clients with PKCE (S256) only. A grant names the workspaces (apps) the agent may use; on each one it acts
// with at most the approving user's role there, and posts as an agent (AI badge) named by the client.
//   GET    /.well-known/oauth-protected-resource        RFC 9728 metadata for https://blhp.app/mcp
//   GET    /.well-known/oauth-authorization-server      RFC 8414 metadata (issuer https://blhp.app)
//          /mcp without a valid token -> 401, WWW-Authenticate: Bearer resource_metadata="<protected-resource URL>"
//   POST   /oauth/register         RFC 7591 dynamic registration { client_name, redirect_uris } -> { client_id, ... }
//   GET    /oauth/authorize        authorization code + PKCE; signs the user in if needed, then -> /oauth/consent?request=<id>
//   POST   /oauth/device           RFC 8628 { client_id } -> { device_code, user_code, verification_uri (/device),
//                                   verification_uri_complete, expires_in, interval }   ("polling" sign-in for headless agents)
//   POST   /oauth/token            grant_type authorization_code | refresh_token | urn:ietf:params:oauth:grant-type:device_code
//                                   -> { access_token (1 h), refresh_token (rotating), token_type: "Bearer", expires_in, scope }
//                                   device polling errors: authorization_pending, slow_down, access_denied, expired_token
//   POST   /oauth/revoke           RFC 7009
// Pages on blhp.app (the web app): /oauth/consent?request=<id> and /device (enter or confirm a user code).
//   GET    /api/oauth/requests/:id                      -> OAuthRequest       member (the signed-in user)
//   POST   /api/oauth/device/lookup { user_code }       -> { request_id }     signed in
//   POST   /api/oauth/requests/:id/approve OAuthApproval -> { redirect_to: string | null }  null for device requests
//   POST   /api/oauth/requests/:id/deny                 -> { redirect_to: string | null }
// Help desk (AppDetail.mode "helpdesk"). Every request (issue) is private: a requester sees only their own, and the
// workspace is never listed, indexed, in the feed, sitemaps, Atom or oEmbed. End-user surfaces never mention Bellhop
// (page titles, emails and their sender name, previews). The team and agents work requests like any issue.
//   POST   /api/apps/:slug/contact/start  { email }      -> { ok: true }       human; emails a sign-in code
//   POST   /api/apps/:slug/contact/verify { email, code } -> Me               signs this browser in as that contact
//   POST   /api/apps/:slug/identify       { token }      -> Me                 an IdentityToken from the host's server
//   GET    /identify?token=<jwt>&next=<path>             read-only sign-in confirmation on the workspace host
//   POST   /identify               form: token, next     same-origin consent, then 302 to a safe path. Neither link
//                                                         step claims guest posts; only the JSON identify route does.
//   POST   /api/apps/:slug/contact/sign-out              -> Me
//   GET    /api/apps/:slug/contacts?q=&cursor=           -> ContactPage        team (viewer and up) and agents
//   GET    /api/apps/:slug/contacts/:id                  -> ContactDetail      team and agents
//   GET    /api/apps/:slug/identity-keys                 -> IdentityKey[]      admin
//   POST   /api/apps/:slug/identity-keys { name }        -> NewIdentityKey     admin; the secret is only returned here
//   DELETE /api/apps/:slug/identity-keys/:id             -> { ok: true }       admin
//   Request types (help desk): what someone needs help with ("Billing", "Account access", "Bug"). Each has its own
//   form fields, may require a verified email, routes new requests to an assignee, and sets how much the assigned
//   agent may do alone (Autonomy). Requests without a type use the workspace defaults.
//   GET    /api/apps/:slug/request-types                 -> RequestType[]      anyone who can open requests (archived
//                                                                             ones for the team only)
//   POST   /api/apps/:slug/request-types RequestTypeInput -> RequestType      admin
//   PATCH  /api/apps/:slug/request-types/:id Partial<RequestTypeInput> & { archived?, position? } -> RequestType  admin
//   PUT    /api/apps/:slug/issues/:number/request-type { request_type_id: string | null, fields? } -> Issue   member;
//          changes a request's type (validates fields, keeps answers whose keys still exist) and re-applies routing
//   Autonomy (help desk; the request's effective Autonomy applies to agents):
//   - "suggest": an agent's public reply is held (Comment.held): only the team and agents see it. Reviewers may
//     receive review mail. End users never see or receive it until a member sends it.
//   POST   /api/apps/:slug/issues/:number/comments/:id/send { body? } -> Comment   member; publishes a held reply
//          (optionally edited first; it stays the agent's reply, with `sent_by`); DELETE .../comments/:id discards it
//   - Approvals are help-desk only, at any autonomy level. An agent asks before an action with consequences (refund, cancellation, account
//     change). The team approves or rejects; an approval then carries a signed token the action's own service
//     verifies before acting (EdDSA/Ed25519 JWT; public keys at GET https://api.blhp.app/v1/approvals/jwks.json?workspace=<expected-slug>,
//     one `kid` per workspace). "approve_actions" means the agent must not act without one (the agent's tools
//     enforce it by requiring the token); "autonomous" lets the agent act alone and ask only when it wants to.
//   POST   /api/apps/:slug/issues/:number/approvals/:id/decide { decision: "approve" | "reject", details_hash: string, note? } -> Approval
//          member; display details verbatim and echo the hash from that same snapshot. Mismatch: 409 details_changed.
//          One decision, recorded and audited; approval tokens are never shown in the web UI.
//   DELETE .../comments/:id?held=1   discard only while held; 409 reply_unavailable if already sent/discarded
//          A plain DELETE also discards a held reply. Once sent, deleting that published reply requires ?held=0.
//   POST   /v1/approvals/:id/consume (secret key)        -> Approval           optional online single-use check for
//          the action service: marks it "used" (409 if already used, 410 if expired or rejected)
//   GET    /api/apps/:slug/api-keys                      -> ApiKey[]           admin; public API v1 keys (shared/v1.ts)
//   POST   /api/apps/:slug/api-keys { name, kind, allowed_origins? } -> NewApiKey   admin; secret keys are returned only here
//   PATCH  /api/apps/:slug/api-keys/:id { name?, allowed_origins? } -> ApiKey  admin
//   DELETE /api/apps/:slug/api-keys/:id                  -> { ok: true }       admin
// Email verification, in any workspace: someone on a request (the requester, the team, or an agent at responder)
// asks to verify an address, e.g. "the email on your billing account". Bellhop emails it a code that only the
// requester can enter; the request then shows the address as verified to the team and agents. Agents never see codes.
//   POST   /api/apps/:slug/issues/:number/verifications { email }        -> Verification
//   POST   /api/apps/:slug/issues/:number/typing                         -> { ok: true }   help desk team; visible for 5 s
//   POST   /api/apps/:slug/issues/:number/verifications/:id/confirm { code } -> Verification   the requester
//
// Email (OpenSend, from mail.blhp.app). People get an email when someone else replies publicly or changes the
// status on an issue they follow; replies within ~3 minutes are batched into one email. Accounts follow issues they
// opened or replied to, and their @mentions and assignments (each switchable). Guests follow an issue by giving an
// email that they confirm once (a link), so nobody can sign someone else up. Every email can be answered: replying
// posts the reply in the thread as the same person (guest or account), with quoted text stripped. Internal notes are
// never emailed to outsiders; team members get mentions and assignments only.
//   GET    /api/me/notifications                        -> NotificationSettings   signed in
//   PATCH  /api/me/notifications Partial<NotificationSettings> -> NotificationSettings
//   GET    /api/apps/:slug/issues/:number/subscription  -> IssueSubscription  anyone who can see the issue
//   PUT    /api/apps/:slug/issues/:number/subscription { subscribed: boolean, email?: string } -> IssueSubscription
//          guests (+ human) send an email the first time; it stays pending until confirmed
//   GET    /email/confirm?t=<token>                     confirms a guest's email (a small page), then follows
//   GET|POST /email/unsubscribe?t=<token>[&all=1]       one-click unsubscribe (RFC 8058) from that issue, or all email
// Agents on the account (OAuth connections and token agents):
//   GET    /api/me/agents                               -> ConnectedAgent[]
//   POST   /api/me/agents AgentAccess & { name }         -> NewAgentToken      a token agent; the secret is only
//                                                                             returned here
//   PATCH  /api/me/agents/:id Partial<AgentAccess> & { name? } -> ConnectedAgent   `apps` replaces the overrides
//   POST   /api/me/agents/:id/rotate                    -> NewAgentToken      token agents: new secret, old one stops
//   DELETE /api/me/agents/:id                           -> { ok: true }       revokes it and all its tokens
//
// Errors: non-2xx responses carry ApiError. 401 = sign in, 403 = not allowed, 404, 409 (slug taken), 413 (too
// large), 428 = Turnstile needed (no or expired bh_human cookie), 429 = rate limited (code "rate_limited", with a
// Retry-After header): per IP and per workspace on posting, voting, uploads, Turnstile checks, live connections,
// OAuth endpoints and MCP calls. A guest posting without a
// display name (none saved and no guest_name sent) gets 400 with code "name_required".

export type IssueStatus = "open" | "in_progress" | "waiting" | "closed"
/** Only set when status is "closed". */
export type CloseReason = "completed" | "not_planned" | "duplicate"
/** Stored one way. `blocks` reads as "blocked by" from the other side; `duplicate_of` as "duplicates". */
export type RelationType = "duplicate_of" | "related" | "blocks"

/** Who wrote or did something. Guests have a handle like `guest-7f3a` and, once chosen, a display name. */
export type Actor =
  | { type: "guest"; id: string; handle: string; name: string | null; tier?: ActorTier | null }
  // A signed-in account (the type name predates non-team accounts). `role` is its current role in this app, filled
  // in on read; null or absent means signed in but not on the team.
  | { type: "member"; id: string; name: string; avatar_url: string | null; role?: Role | null; tier?: ActorTier | null }
  | { type: "agent"; id: string; name: string }

/** An actor's tier, filled in only for the team and agents (and in webhooks). */
export interface ActorTier {
  id: string
  name: string
  color: string
  agents_reply: boolean
}

export interface ApiError {
  /** `moved_to` comes with code "moved" (the issue was transferred). */
  error: { code: string; message: string; moved_to?: { slug: string; number: number; url: string } }
}

export interface Config {
  turnstile_site_key: string
  google_enabled: boolean
  email_sign_in: boolean
  dev_login: boolean
}

/** The interface languages Bellhop ships. */
export type Locale = "en" | "es" | "pt-BR" | "fr" | "de" | "ja" | "zh-CN" | "ko"
export const LOCALES: Locale[] = ["en", "es", "pt-BR", "fr", "de", "ja", "zh-CN", "ko"]

export interface Me {
  /** The language to show: the saved choice, else the best match for the browser's Accept-Language, else "en". */
  locale: Locale
  /** True when locale is a saved choice rather than detected. */
  locale_saved: boolean
  user: { id: string; email: string; name: string; avatar_url: string | null } | null
  /** `name` is the display name this browser chose (null until set); the same across apps. */
  guest: { id: string; handle: string; name: string | null }
  /** True while the bh_human cookie is valid; otherwise run Turnstile and POST /api/human before writing. */
  human: boolean
  /** The contact this browser is signed in as on this help desk's host; null elsewhere and when signed out. */
  contact: Pick<Contact, "id" | "name" | "email" | "external_id" | "verified_via"> | null
}

export interface App {
  id: string
  /** URL slug: lowercase letters, digits and hyphens, 2–40 chars; reserved: api, auth, media, mcp, new, settings. */
  slug: string
  name: string
  description: string
  created_at: string
  /** The app's own icon (favicon and top-left logo on its pages), or null for the Bellhop mark. Versioned URL. */
  icon_url: string | null
  /** The viewer's role in this application; null for guests and accounts not on the team. */
  role: Role | null
  /**
   * Public workspaces are listed in the blhp.app feed and indexed by search engines. Private ones still work for
   * anyone with the link, but are never listed, in the feed, in sitemaps or indexed.
   */
  public: boolean
}

export interface NewApp {
  name: string
  slug: string
  description?: string
  /** Defaults to false (private). */
  public?: boolean
}

/** One page's data. `route` mirrors the page the path resolves to on this host. */
export interface PagePayload {
  /** Server time, so relative times render the same as on the server. */
  now: string
  me: Me
  config: Config
  /** The workspace this page belongs to (null on the home domain). */
  app: AppDetail | null
  route:
    | { kind: "feed"; list: FeedList; apps: FeedApp[] }
    | { kind: "list"; list: IssueList }
    | { kind: "issue"; issue: Issue }
    | { kind: "new"; metadata: ReportMetadata | null }
    | { kind: "other" }
    | { kind: "not_found" }
}

/** A public workspace, for the home feed. */
export interface FeedApp {
  slug: string
  name: string
  description: string
  icon_url: string | null
  open_count: number
}

/** An issue in the home feed, with the workspace it belongs to. */
export interface FeedIssue extends IssueSummary {
  app: { slug: string; name: string; icon_url: string | null }
}

export interface FeedList {
  issues: FeedIssue[]
  counts: { open: number; closed: number }
  next_cursor: string | null
}

export interface AppDetail extends App {
  /** Admins only. Operator-set in D1 (no API write); permits using the workspace name alone as its mail sender. */
  readonly trusted?: boolean
  labels: Label[]
  templates: Template[]
  /** What the viewer can see: includes private issues only for the team. */
  counts: { open: number; closed: number }
  visibility: AppVisibility
  /** Days before a waiting-on-reporter issue sends its reporter one reminder; null when off. */
  nudge_days: number | null
  mode: AppMode
  helpdesk: HelpdeskSettings
}

/** A public issue tracker (the default), or a private, white-label help desk. */
export type AppMode = "tracker" | "helpdesk"

/** One field on a request type's form. Answers are stored on the request as `fields[key]` (strings). */
export interface RequestField {
  /** Stable machine key: lowercase letters, digits and underscores. */
  key: string
  label: string
  kind: "text" | "textarea" | "email" | "url" | "number" | "select"
  required: boolean
  /** For "select". */
  options?: string[]
  help?: string
  /** For requester-visible email fields: ask the requester to verify this address on submission. Never combined with internal. */
  verify?: boolean
  /** Team and agents only (e.g. an internal account id the host fills through the API); hidden from the form. */
  internal?: boolean
}

/**
 * How much the agent assigned to a request may do on its own:
 * - "suggest": its public replies are held as drafts (Comment.held) that a team member sends, edits or discards
 * - "approve_actions": replies go out; actions with consequences (refunds, cancellations, account changes) need a
 *   team member's approval first (request_approval -> Approval)
 * - "autonomous": replies and actions go out without review (approvals stay available when the agent wants one)
 */
export type Autonomy = "suggest" | "approve_actions" | "autonomous"

/** Who new requests of a type go to. Groups with round-robin come later. */
export type RouteTarget = { agent: string } | { member: string } | null

export interface RequestType {
  id: string
  name: string
  description: string
  fields: RequestField[]
  /** The requester must be a verified contact to submit this type (on top of the workspace setting). */
  require_verification: boolean
  /** Team and agents only (null for requesters). */
  route: RouteTarget | null
  /** Team and agents only. */
  autonomy: Autonomy | null
  position: number
  archived: boolean
}

export interface RequestTypeInput {
  name: string
  description?: string
  fields?: RequestField[]
  require_verification?: boolean
  route?: RouteTarget
  autonomy?: Autonomy
}

export interface HelpdeskSettings {
  /** Requesters must be a verified contact (email code or host identity) before submitting. Default true. */
  require_verified_email: boolean
  /** Public API v1: publishable keys may start anonymous end-user sessions (Turnstile-checked). Default false. */
  allow_anonymous: boolean
  /** Autonomy for requests without a type, or whose type doesn't set one. Default "suggest". */
  default_autonomy: Autonomy
}

/** How a contact proved who they are: an email code, or the host app's signed identity token. */
export type ContactVerification = "email" | "host"

/** A requester in a help desk workspace. Visible only to that workspace's team and agents. */
export interface Contact {
  id: string
  name: string | null
  /** A verified email: from a sign-in code, or an identity token with email_verified. */
  email: string | null
  /** Display only. An email asserted by the host without verification; never used to link contacts or deliver mail. */
  unverified_email: string | null
  /** The host app's user id, from an identity token's `sub`. */
  external_id: string | null
  verified_via: ContactVerification | null
  created_at: string
  last_seen_at: string | null
}

export interface ContactDetail extends Contact {
  requests: IssueSummary[]
}

export interface ContactPage {
  contacts: Contact[]
  next_cursor: string | null
}

/** A secret the host app's server signs identity tokens with. Never shipped to browsers.
 * Revocation rejects future handoffs; it does not end sessions already issued. */
export interface IdentityKey {
  id: string
  name: string
  /** e.g. "bh_id_…3f9a". */
  preview: string
  created_at: string
  last_used_at: string | null
}

export interface NewIdentityKey extends IdentityKey {
  secret: string
}

/**
 * The claims of an identity token: a JWT signed HS256 with an IdentityKey's secret, header `kid` = the key id. Made
 * on the host app's server for its signed-in user. Single use (jti); exp at most 10 minutes after iat.
 */
export interface IdentityToken {
  /** The host app's user id; becomes Contact.external_id. */
  sub: string
  /** The workspace slug. */
  aud: string
  email?: string
  /** The host has verified `email`, so the contact counts as verified by email too. */
  email_verified?: boolean
  /** Explicitly link a verified mailbox to its existing email-only contact and private requests. Default false. */
  link_existing?: boolean
  name?: string
  iat: number
  exp: number
  jti: string
}

/** An email address someone on a request asked to verify. */
export interface Verification {
  id: string
  email: string
  state: "pending" | "verified" | "expired" | "failed"
  requested_by: Actor
  created_at: string
  verified_at: string | null
}

export interface ImportJob {
  id: string
  source: "github"
  repo: string
  state: "queued" | "running" | "done" | "failed"
  imported: { issues: number; comments: number; labels: number }
  /** A short reason when it failed (never the token). */
  error: string | null
  created_at: string
  finished_at: string | null
}

/** Whether new issues are public, and whether reporters may choose. The team can always change an issue's privacy. */
export interface AppVisibility {
  default: "public" | "private"
  reporter_can_choose: boolean
}

/** Why a moderator hid an issue or comment. */
export type ModerationReason = "spam" | "abuse" | "off_topic"

export interface Moderation {
  reason: ModerationReason
  /** Redacted for viewers outside the workspace team. */
  by: Actor | null
  at: string
}

export interface NotificationSettings {
  /** The account's address (from Google). */
  email: string
  /** Follow issues I open (on by default). */
  opened: boolean
  /** Follow issues I reply to (on by default). */
  replied: boolean
  /** Email me when I'm @mentioned (team only; on by default). */
  mentions: boolean
  /** Email me when an issue is assigned to me (team only; on by default). */
  assigned: boolean
  /** Email me when an agent asks for an approval or holds a reply in a help desk I'm on (team only; on by default
   *  for admins and the request's assignee). */
  approvals: boolean
}

export interface IssueSubscription {
  subscribed: boolean
  /** Where emails go; a guest's address is shown masked (e.g. "d***@example.com"). */
  email: string | null
  /** A guest's address waiting for its confirmation link. */
  pending: boolean
  /** Why the viewer follows it; null when not subscribed. */
  reason: "opened" | "replied" | "mentioned" | "assigned" | "manual" | null
}

/**
 * A tier the team gives people (e.g. VIP, Pro, Beta). Only the team and agents ever see tiers. When someone with a
 * tier opens an issue, `rules` apply; agents see the tier (Actor.tier) over MCP and webhooks and handle it.
 */
export interface Tier {
  id: string
  name: string
  /** Hex, like label colors. */
  color: string
  description: string
  rules: TierRules
  /** People with this tier. */
  count: number
  position: number
}

export interface TierRules {
  /** Label ids added to every issue they open. */
  label_ids: string[]
  /** A team member assigned to every issue they open, or null. */
  assignee_id: string | null
  /** Their new issues are private (whatever the app's default). */
  private: boolean
  /** False: agents can't post public replies on their issues (internal notes only); a human answers. */
  agents_reply: boolean
}

export interface TierInput {
  name: string
  color?: string
  description?: string
  rules?: Partial<TierRules>
  position?: number
}

/** Someone outside the team who has a tier (or, in the unfiltered list, has reported here). */
export interface Person {
  /** Null for an email assignment that hasn't signed in yet. */
  actor: Actor | null
  email: string | null
  tier: { id: string; name: string; color: string } | null
  issue_count: number
  last_seen_at: string | null
}

/** What an app uploads before a report is written. */
export interface ReportMetadataInput {
  /** A suggested issue title, e.g. the error's first line. */
  title?: string
  /** The error message or a short description of what failed. */
  message?: string
  /** The app sending it, e.g. { name: "OpenCode Desktop", version: "1.4.2" }. */
  source?: { name: string; version?: string }
  /** System specs, shown like system info ("OS", "CPU", "GPU", "Memory"). */
  system?: SystemInfo
  /** Free-form context, e.g. { session: "ses_…", model: "…" }. */
  context?: Record<string, string>
  /** Log files as text. */
  logs?: { name: string; content: string }[]
  /** A stable signature of the failure (e.g. a hash of the stack); used to suggest matching open issues. */
  fingerprint?: string
}

export interface ReportMetadataCreated {
  /** "md_…" */
  id: string
  /** The new-issue page with this metadata attached; open it in the person's browser. */
  url: string
  expires_at: string
}

export interface ReportMetadata {
  id: string
  title: string | null
  message: string | null
  source: { name: string; version?: string } | null
  system: SystemInfo
  context: Record<string, string>
  /** The logs as attachments (kind "file"), readable by whoever may read this metadata. */
  logs: Attachment[]
  fingerprint: string | null
  created_at: string
  /** Null once attached. */
  expires_at: string | null
  /** Where it was attached, if it was. */
  attached_to: { number: number; comment_id: string | null } | null
  /** Open issues the viewer may see with the same fingerprint, most recent first. */
  matches: IssueRef[]
}

/** A publishable key that can only upload report metadata to one workspace. */
export interface ReportKey {
  id: string
  name: string
  /** e.g. "bh_pub_7f3a…" */
  preview: string
  created_at: string
  last_used_at: string | null
}

export interface NewReportKey extends ReportKey {
  key: string
}

/** A blocked guest or account in one app. */
export interface Block {
  id: string
  actor: Actor
  by: Actor
  created_at: string
}

/** Someone who can be @mentioned in an app: team members and agents with access. */
export interface Mentionable {
  type: "member" | "agent"
  id: string
  name: string
  /** What follows the @: [a-z0-9-], unique in the app, stable while the name doesn't change (e.g. "ryan", "opencode"). */
  handle: string
  avatar_url: string | null
  /** Agents only: how it connects, and the account it belongs to (tells same-name agents apart). */
  agent_kind?: "oauth" | "token"
  owner_name?: string
}

/** A resolved @handle in a body. Only posts by the team and agents create mentions; guests' @text stays text. */
export interface Mention {
  handle: string
  actor: Actor
}

export type IssueSort = "newest" | "oldest" | "votes" | "updated" | "comments"

/** An earlier version of an issue's title/body or a comment's body (newest first; the current one isn't included). */
export interface Revision {
  id: string
  actor: Actor
  title: string | null
  body: string
  created_at: string
}

export interface AppSettings {
  /** Redacted (null URL, empty secret/events/deliveries) in mutation responses. Only an explicit admin settings read reveals credentials. */
  webhook: { url: string | null; secret: string; events: WebhookEventType[]; deliveries: WebhookDelivery[] }
  members: Member[]
  /** Absolute URL of the MCP endpoint, for the OpenCode config snippet. */
  mcp_url: string
}

/** An invitation to join a workspace, waiting for the invited account to accept or decline. */
export interface Invitation {
  id: string
  app: { slug: string; name: string; icon_url: string | null }
  role: Role
  invited_by: { name: string; avatar_url: string | null }
  created_at: string
}

export interface Member {
  id: string
  email: string
  name: string | null
  avatar_url: string | null
  role: Role
  /** False until the invited person accepts the invitation. */
  joined: boolean
}

/** A token agent just created or rotated: the full secret is shown once. */
export interface NewAgentToken extends ConnectedAgent {
  token: string
}

export interface WebhookDelivery {
  id: string
  event: WebhookEventType
  status: "pending" | "delivered" | "failed"
  response_status: number | null
  attempts: number
  created_at: string
}

/** A team role in one application; see the Roles notes at the top. */
export type Role = "owner" | "admin" | "member" | "viewer"
/** What an agent may do in one application; see the Roles notes at the top. */
export type AgentRole = "admin" | "member" | "responder" | "viewer"

/** An agent with access to this application (settings, admins only); it belongs to `approved_by`'s account. */
export interface AppAgent {
  /** The agent's id. */
  id: string
  kind: "oauth" | "token"
  client_name: string
  approved_by: { name: string; avatar_url: string | null }
  role: AgentRole
  /** The most this agent can be here: the approving user's current role, capped at admin. */
  max_role: AgentRole
  created_at: string
  last_used_at: string | null
}

/** A reply the team (and agents) reuse, e.g. "Needs logs". Markdown; {reporter} becomes the reporter's name. */
export interface SavedReply {
  id: string
  name: string
  body: string
  created_by: Actor
  updated_at: string
}

export interface SavedReplyInput {
  name: string
  body: string
}

/**
 * How the workspace is doing over a period (issues opened in it, unless noted). Times are medians in seconds; null
 * when there's no data. "Agent-resolved": closed as completed with an agent's public reply, no human team reply and
 * no reopen. Internal notes never count as responses.
 */
export interface Analytics {
  days: number
  opened: number
  closed: number
  /** First public response by the team or an agent. */
  first_response: { median: number | null; p90: number | null; by_agent_share: number | null }
  /** Opened to closed (completed or not planned). */
  resolution: { median: number | null; p90: number | null }
  agent_resolved_share: number | null
  reopened_share: number | null
  /** "This helped" marks on team and agent replies, per reply. */
  helpful_per_reply: { agent: number | null; human: number | null }
  /** Open now, waiting on the team (no public team or agent reply after the reporter's latest post). */
  waiting_on_team: number
  /** One entry per day, oldest first. */
  daily: { date: string; opened: number; closed: number; first_response_median: number | null }[]
  by_tier: { tier: string; opened: number; first_response_median: number | null }[]
  by_label: { label: string; opened: number }[]
}

/** What someone (a person or an agent) did in a workspace. */
export interface AuditEntry {
  id: string
  actor: Actor
  /** e.g. "member.invited", "member.role_changed", "agent.access_changed", "webhook.updated", "label.deleted",
   *  "issue.deleted", "issue.hidden", "comment.hidden", "actor.blocked", "tier.assigned", "app.updated",
   *  "report_key.created", "issue.transferred". */
  action: string
  /** What it acted on, for display: { type: "issue", number: 12 }, { type: "member", email } etc. */
  target: Record<string, unknown> | null
  /** Before/after or other details, never secrets. */
  data: Record<string, unknown>
  created_at: string
}

export interface AuditPage {
  entries: AuditEntry[]
  next_cursor: string | null
}

export interface Label {
  id: string
  name: string
  /** Hex without '#', e.g. "d73a4a". */
  color: string
  description: string
}

export interface LabelInput {
  name?: string
  color?: string
  description?: string
}

/** Issue templates. `title` and `body` prefill the new-issue form; `label_ids` are applied on submit. */
export interface Template {
  id: string
  name: string
  description: string
  title: string
  body: string
  label_ids: string[]
  /** Offer the "Attach system info" toggle, on by default. */
  ask_system_info: boolean
  position: number
}

export interface TemplateInput {
  name?: string
  description?: string
  title?: string
  body?: string
  label_ids?: string[]
  ask_system_info?: boolean
  position?: number
}

export interface Attachment {
  id: string
  name: string
  mime: string
  size: number
  kind: "image" | "video" | "file"
  /** Path under /media. Markdown in bodies references it as ![name](url); the web app renders video URLs as players. */
  url: string
}

/** Collected in the browser with the reporter's consent. Keys are human-readable ("OS", "Browser", "Screen", "GPU"). */
export type SystemInfo = Record<string, string>

/** The agent's live presence on an issue: the typing dots plus an optional short status line. */
export interface Activity {
  actor: Actor
  text: string | null
  expires_at: string
}

export interface IssueRef {
  id: string
  number: number
  title: string
  status: IssueStatus
  close_reason: CloseReason | null
}

export interface IssueSummary extends IssueRef {
  /** Help desk MCP list/search projections; ordinary discovery summaries omit form answers. */
  request_type?: { id: string; name: string } | null
  fields?: Record<string, string>
  effective_autonomy?: Autonomy
  labels: Label[]
  author: Actor
  assignee: Actor | null
  comment_count: number
  created_at: string
  updated_at: string
  /** Set while an agent or member shows activity (typing/status). */
  activity: Activity | null
  /** Visible only to the team, agents and the reporter. */
  private: boolean
  /** Set when a moderator hid it; only the team and agents see hidden issues. */
  hidden: Moderation | null
  /** "Me too" votes: distinct voters on this issue and on issues marked duplicate_of it. */
  votes: number
  viewer_voted: boolean
  /** Only the team and agents can comment on a locked issue (votes still work). */
  locked: boolean
  /** Pinned issues lead the list (at most 3 per app). */
  pinned: boolean
}

export interface Relation {
  id: string
  type: RelationType
  /** outgoing: this issue → other (e.g. this duplicates other); incoming: other → this. */
  direction: "outgoing" | "incoming"
  issue: IssueRef
}

export interface Issue extends IssueSummary {
  /** Help desk team/agent reads only. Suggest holds agent replies; action services enforce signed approvals. */
  effective_autonomy?: Autonomy
  body: string
  attachments: Attachment[]
  relations: Relation[]
  /** null when none was attached; "hidden" when attached but the viewer isn't a member. */
  system_info: SystemInfo | "hidden" | null
  template_id: string | null
  /** True when the viewer wrote this issue (guest cookie or member). */
  viewer_is_author: boolean
  /** When the title or body last changed after posting; GET .../history has the earlier versions. */
  edited_at: string | null
  /** Set for issues copied from elsewhere. */
  imported: { source: "github"; url: string; number: number } | null
  /** The reporter's interface language when they opened it (agents can reply in it); null for older issues. */
  reporter_locale: Locale | null
  /** Help desk requests: the requester's contact, for the team and agents (null otherwise). */
  contact: Contact | null
  /** Email verifications on this request, for the requester, the team and agents (empty for anyone else). */
  verifications: Verification[]
  /** Help desk: the request's type (null when none), and the answers to its fields (internal fields for the team and
   *  agents only). */
  request_type: { id: string; name: string } | null
  fields: Record<string, string>
  /** Report metadata attached to the issue or its comments; empty for viewers outside the team other than the reporter. */
  metadata: ReportMetadata[]
  /** @mentions in the body. */
  mentions: Mention[]
  timeline: TimelineItem[]
}

export interface IssueList {
  issues: IssueSummary[]
  /** The app's pinned issues the viewer may see; on the first page only (no cursor), whatever the filters. */
  pinned: IssueSummary[]
  counts: { open: number; closed: number }
  next_cursor: string | null
}

export interface NewIssue {
  title: string
  body: string
  template_id?: string
  /** Uploads from POST /uploads by the same guest/member, not yet attached. */
  attachment_ids?: string[]
  system_info?: SystemInfo
  /** Guests only: sets the display name (1–40 characters) before posting, same as PUT /api/me/guest. */
  guest_name?: string
  /** Only honoured when the app lets reporters choose (or for the team); otherwise the app's default applies. */
  private?: boolean
  /** Uploaded report metadata to attach (its logs and specs stay visible to the team, agents and the reporter only). */
  metadata_id?: string
  /** Help desk: the request type and the answers to its (non-internal) fields; validated against the type. */
  request_type_id?: string
  fields?: Record<string, string>
}

export interface IssuePatch {
  title?: string
  body?: string
  status?: IssueStatus
  /** Required when status is "closed"; defaults to "completed". */
  close_reason?: CloseReason
  label_ids?: string[]
  /** Member id, or null to clear. */
  assignee_id?: string | null
  private?: boolean
  /** Member. */
  locked?: boolean
  /** Member; 409 code "pin_limit" past 3. */
  pinned?: boolean
}

export interface NewComment {
  body: string
  /** Uploaded report metadata to attach to this comment (e.g. the same crash again, or more logs). */
  metadata_id?: string
  /** Team only: an internal note, seen by the team and agents, never by guests or the reporter. */
  internal?: boolean
  attachment_ids?: string[]
  /** Guests only: sets the display name (1–40 characters) before posting, same as PUT /api/me/guest. */
  guest_name?: string
}

export interface Comment {
  id: string
  author: Actor
  body: string
  attachments: Attachment[]
  /** True when this comment was written by the issue's author (GitHub's "Author" tag). */
  by_issue_author: boolean
  created_at: string
  updated_at: string
  /** When the body last changed after posting; GET .../history has the earlier versions. */
  edited_at: string | null
  /** Set when a moderator hid it. Outside the team, a hidden comment comes with an empty body and no attachments. */
  hidden: Moderation | null
  /** True when the viewer wrote it (may edit and delete it). */
  viewer_is_author: boolean
  /** An internal note: only the team and agents ever receive it (API, live, search, counts, feeds). */
  internal: boolean
  /** How it was written: on the site, by replying to an email, or by an agent over MCP. */
  via: "web" | "email" | "mcp"
  /** "This helped" marks. */
  helpful: number
  viewer_helpful: boolean
  mentions: Mention[]
  /** A held agent reply (autonomy "suggest"): team and agents only, not emailed, until a member sends it. */
  held: { at: string } | null
  /** Member who sent a held reply. Team only; always null for requesters. */
  sent_by: Actor | null
}

/** An agent's request to take an action with consequences, decided by a team member. */
export interface Approval {
  id: string
  issue_number: number
  /** Machine name of the action, e.g. "refund", "cancel_subscription", "change_email". */
  action: string
  /** Advisory only. `details` is what's signed and what the member must check. */
  summary: string
  /** Structured parameters the action service checks against the token (e.g. { amount: 2000, currency: "usd" }). */
  details: Record<string, string | number | boolean>
  /** Unpadded base64url SHA-256 of flat JSON: keys sorted by UTF-16 code unit, JSON.stringify strings/scalars, no whitespace. */
  details_hash: string
  state: "pending" | "approved" | "rejected" | "expired" | "used"
  requested_by: Actor
  decided_by: Actor | null
  decided_at: string | null
  note: string | null
  /** Pending approvals expire after 7 days; an approval's token is valid for 30 minutes after the decision. */
  expires_at: string
  created_at: string
}

/**
 * Claims of an approval token (JWT, alg EdDSA, header kid = the workspace's signing key id). Only the requesting
 * agent receives it (MCP get_approval), once approved. The action service verifies the signature with the JWKS,
 * checks aud, act, det against what it is about to do, exp, and (optionally) consumes it online.
 */
export interface ApprovalToken {
  iss: "https://blhp.app"
  /** The workspace slug. */
  aud: string
  /** The approval id (also the jti). */
  sub: string
  jti: string
  act: string
  det: Record<string, string | number | boolean>
  /** The request number. */
  req: number
  /** Who approved: { id, name } of the member. */
  by: { id: string; name: string }
  iat: number
  exp: number
}

export type IssueEventType =
  | "approval.requested" // team only; data.approval never contains a token
  | "approval.decided"
  | "routed" // team-only: request_type, target, outcome and the assignee resolved at write time
  | "verified" // data: { verification_id }; requester/team only, no email or code in the event
  | "nudged" // team-only: the waiting reporter was sent a reminder
  | "status_changed" // data: { from: IssueStatus, to: IssueStatus, close_reason: CloseReason | null }
  // Events a tier rule caused (labels and assignee on a tiered person's new issue) carry data.rule
  // { tier_id, tier_name } and are team-only timeline items, so the tier never shows to outsiders.
  | "labeled" // data: { label: Label, rule? }
  | "unlabeled" // data: { label: Label }
  | "claimed" // data: {}  (actor took the issue; it becomes the assignee)
  | "assigned" // data: { assignee: Actor | null, rule? }
  | "related" // data: { relation: Relation }
  | "unrelated" // data: { relation: Relation }
  | "renamed" // data: { from: string, to: string }
  | "hidden" // data: { reason: ModerationReason }   (team-only timeline item)
  | "unhidden" // data: {}                           (team-only timeline item)
  | "made_private" // data: {}
  | "made_public" // data: {}
  | "locked" // data: {}
  | "unlocked" // data: {}
  | "pinned" // data: {}
  | "unpinned" // data: {}
  | "transferred" // data: { from: { slug: string, number: number } }

export interface IssueEvent {
  id: string
  type: IssueEventType
  actor: Actor
  data: Record<string, unknown>
  created_at: string
}

export type TimelineItem =
  | { kind: "comment"; comment: Comment }
  | { kind: "event"; event: IssueEvent }

/** Server → client messages on the live WebSockets. Clients send nothing but pings ("ping" → "pong"). */
export type LiveEvent =
  | { type: "hello"; viewers: number; activity: Activity | null }
  | { type: "viewers"; count: number }
  | { type: "issue.created"; issue: IssueSummary } // list room
  | { type: "issue.updated"; issue: IssueSummary } // list and issue rooms
  | { type: "timeline.added"; issue_id: string; item: TimelineItem } // issue room
  | { type: "activity"; issue_id: string; activity: Activity | null } // list and issue rooms
  // An actor changed identity: a guest renamed, or a guest's posts moved to their account on sign-in. Sent to the
  // app room and every issue room where `previous_id` appears; clients replace that actor everywhere they show it.
  | { type: "actor.updated"; previous_id: string; actor: Actor }
  // Edited, hidden or unhidden. Each socket gets the view its viewer is allowed (e.g. no body when hidden).
  | { type: "comment.updated"; issue_id: string; comment: Comment }
  | { type: "comment.deleted"; issue_id: string; comment_id: string } // issue room
  | { type: "issue.deleted"; issue_id: string; number: number } // list and issue rooms
  | { type: "issue.moved"; issue_id: string; to: { slug: string; number: number; url: string } } // source app's rooms
// Rooms filter per socket: private issues and hidden issues/comments only reach sockets whose viewer may see them
// (the team; for private issues also the reporter); internal notes only reach team sockets, and counts
// (comment_count) are per viewer. `viewer_*` fields in live payloads describe that socket's viewer.
  | { type: "feed.issue"; issue: FeedIssue } // feed room: an issue in a public workspace was opened or changed

// Webhooks. POST to the application's URL with JSON WebhookPayload and headers:
//   Bellhop-Event: <type>          Bellhop-Delivery: <delivery id>
//   Bellhop-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>" with the webhook secret>
// Retried with backoff on non-2xx or timeout (10 s). Comments written by an agent token are not sent, so an agent
// never wakes itself.
// mention.created: once per newly @mentioned team member or agent per write (posting or editing), never for
// self-mentions; an agent mentioned by another agent does get it (that's how one hands work to another).
// Internal notes are delivered too, with comment.internal true.
// Granular events are opt-in; issue.updated still fires for every change (with `changes`) for whoever subscribes.
export type WebhookEventType =
  | "ping"
  | "issue.opened"
  | "issue.updated"
  | "issue.closed" // status became closed (close_reason in issue)
  | "issue.reopened"
  | "issue.labeled" // label in `label`
  | "issue.unlabeled"
  | "issue.assigned" // assignee in issue.assignee (null when cleared)
  | "issue.deleted"
  | "issue.moved" // moved_to in `moved_to`
  | "comment.created"
  | "comment.edited"
  | "comment.deleted"
  | "mention.created"
  | "verification.completed" // verification in `verification` (verified, or failed/expired)
  | "reply.held" // an agent reply was held for review (comment in `comment`)
  | "approval.requested" // approval in `approval`
  | "approval.decided" // approval in `approval` (approved or rejected; never the token)

/** What a webhook gets until its events are changed (the behaviour before events were selectable). */
export const DEFAULT_WEBHOOK_EVENTS: WebhookEventType[] = ["issue.opened", "issue.updated", "comment.created", "mention.created"]

export interface WebhookPayload {
  id: string
  type: WebhookEventType
  created_at: string
  app: { id: string; slug: string; name: string }
  /** Absent for ping. */
  /** New webhook snapshots include the reporter's language; stored pre-locale deliveries may omit it. */
  issue?: IssueSummary & {
    url: string
    reporter_locale?: Locale | null
    request_type?: Issue["request_type"]
    fields?: Issue["fields"]
    effective_autonomy?: Autonomy
  }
  comment?: Comment
  actor?: Actor
  /** For issue.updated: which fields changed. */
  changes?: string[]
  /** For mention.created: who was mentioned (the comment, or the issue body when there is no comment). */
  mentioned?: Actor
  /** For issue.labeled / issue.unlabeled. */
  label?: Label
  /** For issue.moved: where it went. */
  moved_to?: { slug: string; number: number; url: string }
  /** Set when this delivery is a manual redelivery of an earlier one. */
  redelivery_of?: string
  /** For issue.opened / comment.created: report metadata attached to that post (team-facing). */
  metadata?: ReportMetadata[]
  /** Help desk requests: the requester's contact. */
  contact?: Contact
  /** For verification.completed. */
  verification?: Verification
  /** For approval.requested / approval.decided (never the token). */
  approval?: Approval
  mcp_url: string
}

// MCP tools (POST /mcp). An app token is scoped to its app; an OAuth token to the apps in its grant. Every issue tool
// takes an optional `app` (slug), required when the token covers more than one app. Names and inputs:
//   list_apps      {}                            the apps this agent can use now (all_workspaces included), with
//                                                  its effective AgentRole in each
//   create_app     { name, slug, description? }  grants allowed to create workspaces; the approving user owns it, the
//                                                  agent joins it as admin
//   Tool roles: read tools viewer; comment and set_activity responder; triage tools member; workspace setup admin.
//   list_issues    { state?: "open"|"closed", label?: string, query?: string, sort?: IssueSort, limit?: number }
//   get_issue      { number }                    full issue: body, timeline, attachments, relations, system info
//   search_issues  { query, limit? }             full-text over titles, bodies and comments; finds duplicates
//   get_attachment { id }                        images as MCP image content; video and files as an absolute URL
//   get_metadata   { id }                        report metadata: specs, context, log attachments, fingerprint, matches
//   list_saved_replies {}                        saved replies; use one by posting its body via comment
//   get_analytics  { days? }                     the workspace's Analytics (member)
//   get_contact    { id? | email? | external_id? }  a help desk contact with their requests (get_issue and
//                                                  list_issues carry the requester's contact and verifications)
//   request_verification { number, email }       responder; emails that address a code only the requester can
//                                                  enter; the result arrives on the issue and as verification.completed
//   list_request_types {}                         the help desk's request types with fields, routing and autonomy
//                                                  (get_issue carries request_type, fields and the effective autonomy)
//   set_request_type { number, request_type, fields? }  member; re-route a request (applies the type's routing)
//   comment (help desk)                           under "suggest", a public reply returns { held: true } and waits for a
//                                                  member; internal notes and triage are unaffected
//   request_approval { number, action, summary, details? }  responder -> Approval (pending); the team is notified
//   get_approval   { id }                        the Approval; once approved, also { token } (requesting agent only)
//   list_labels    {}
//   comment        { number, body, internal? }   posts with the AI badge; clears the agent's activity; internal
//                                                  makes it a team-only note; @handle mentions (list_mentionables)
//   list_mentionables {}                         team members and agents with their @handles
//   transfer_issue { number, to_app }            member in both apps
//   edit_comment   { comment_id, body }          the agent's own comments
//   list_tiers     {}                            tiers with their rules
//   set_tier       { email?, actor_id?, tier: string|null (name) }   member
//                  Issue and comment authors carry `tier` in get_issue, list_issues and webhooks. When the reporter's
//                  tier has agents_reply false, `comment` without internal fails with code "humans_only".
//   moderate       { number, comment_id?, action: "hide"|"unhide", reason? }   member; hides or unhides the issue,
//                                                  or one comment; reason required for hide
//   update_issue   { number, status?, close_reason?, labels?: string[] (names), title?, private?, locked?, pinned? }
//   relate_issues  { number, other_number, type: RelationType }
//   claim_issue    { number }                    assigns the agent, adds a "claimed" event
//   set_activity   { number, text?: string|null, clear?: boolean }   typing dots + short status; expires after 60 s
//   Workspace setup (same roles as the REST routes: owner for the app itself and webhooks; member for labels and
//   templates). Labels and templates are named by name, matched case-insensitively.
//   get_app        {}                            name, description, icon, counts, labels, templates
//   update_app     { name?, description? }       admin
//   get_webhook    {}                            URL, whether a secret is set, recent deliveries
//   set_webhook    { url: string|null, events?: WebhookEventType[] }   https only; null removes it
//   redeliver_webhook { delivery_id }
//   rotate_webhook_secret {}                     returns the new secret once
//   test_webhook   {}                            sends a ping, returns the delivery id
//   create_label   { name, color?, description? }
//   update_label   { name, new_name?, color?, description? }
//   delete_label   { name }                      removes it from issues too
//   list_templates {}
//   create_template { name, description?, title?, body?, labels?: string[] (names), ask_system_info?, position? }
//   update_template { name, new_name?, description?, title?, body?, labels?, ask_system_info?, position? }
//   delete_template { name }
//   list_members   {}
//   invite_member  { email, role? }              admin; admin/owner roles need the approving user to be an owner
//   set_member_role { email, role }              same caps; the last owner stays
//   remove_member  { email }

/** The consent page's request: who is asking and which of the user's apps they can grant. */
export interface OAuthRequest {
  id: string
  kind: "authorization_code" | "device"
  client_name: string
  /** For authorization_code: the host the user will be sent back to. */
  redirect_host: string | null
  /** The user's apps, with their role; an agent may be given up to that role (owner -> admin). */
  apps: { id: string; slug: string; name: string; icon_url: string | null; role: Role }[]
  expires_at: string
}

/**
 * Which workspaces an agent may use. Its role in an app is the override for that app if there is one, else
 * `all_workspaces` (when set and the account has a role there); either way capped by the account's current role
 * there (owner/admin -> admin, member -> member, viewer -> responder). A `null` override role excludes that app.
 */
export interface AgentAccess {
  /** Every workspace the account has a role in, now and later, at this role; null for only the listed apps. */
  all_workspaces: AgentRole | null
  /** Per-app roles (or exclusions with null). Only apps where the account has a role. */
  apps: { id: string; role: AgentRole | null }[]
  /** May create workspaces over MCP; the account owns them and the agent gets admin there. */
  create_workspaces: boolean
}

/** The consent page's answer. At least one app, all workspaces, or create_workspaces. */
export type OAuthApproval = AgentAccess

/** An agent on the user's account: an OAuth connection or a token agent. */
export interface ConnectedAgent {
  id: string
  kind: "oauth" | "token"
  /** The agent's name on its posts (the OAuth client name, or the token agent's name). */
  client_name: string
  /** Token agents: the first characters of the secret, e.g. "bh_7f3a…". */
  preview: string | null
  all_workspaces: AgentRole | null
  /** Every app it can use now, with its effective role; `override` is true when that app has its own entry. */
  apps: { id: string; slug: string; name: string; role: AgentRole; override: boolean }[]
  /** Apps excluded from all_workspaces. */
  excluded: { id: string; slug: string; name: string }[]
  create_workspaces: boolean
  created_at: string
  last_used_at: string | null
}
