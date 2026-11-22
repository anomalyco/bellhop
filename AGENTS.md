<!-- tallow -->

# Bellhop

Support sites for products at `https://<slug>.blhp.app`: issue reports, an embeddable support chat, a help desk API, agents over MCP, webhooks and feeds. Developer docs live in `docs/` and are served by the Worker.

## Layout

- `worker/`: the Worker (Hono). `worker/index.ts` is the entry; the `Room` Durable Object, queue consumers (`bellhop-webhooks`, `bellhop-mail`) and API routes live here.
- `src/`: the React app, the widget and the SDK.
- `shared/`: types shared by the Worker and the app (`shared/api.ts`, `shared/v1.ts`).
- `og/`: the separate `bellhop-og` Worker for share images. It has its own `package.json`.
- `migrations/`: D1 schema. Add a new migration; never edit one that has been applied.
- `scripts/smoke.mjs`: the Playwright smoke test the deploy runs against a candidate version and live traffic.

## Commands

- `bun run dev`: local dev on `127.0.0.1:5287`.
- `bun run db:migrate`: apply migrations to the local D1.
- `bun run check`: typecheck and build. CI (`.github/workflows/check.yml`) runs it on every pull request and push to `dev`.

## Branches and deploys

- `dev` is the default branch. Land work through squash-merged pull requests once `check` passes.
- `production` is the release branch: `git push origin dev:production`. It only fast-forwards.
- `.github/workflows/deploy.yml` deploys production on push to `production`: D1 migrations, upload at 0%, smoke test, promote, live smoke test, roll back on failure. The Cloudflare token is minted per run from the token issuer (role `github/bellhop-production`). Don't deploy production by hand.
- Steps that run repository code (build, smoke tests) never get the Cloudflare token. Keep it that way when editing the workflow.
- Changes under `.github/` need Dax's review.
