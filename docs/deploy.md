# Deploying Stations

Production is one Cloudflare Worker: it serves the built explorer from Static
Assets and mounts `createStationsApiHandler` at `/api/stations`, the same
contract as the local explorer. Catalogue data lives in a private R2 bucket and
provider API keys are Worker secrets mirrored from GitHub on every deploy.

| Piece | Owner | Notes |
|-------|-------|-------|
| Worker name, bindings, vars | [`wrangler.json`](../wrangler.json) | Infrastructure as code; dashboard edits are overwritten on deploy |
| Worker code | [`deploy/worker/`](../deploy/worker/index.ts) | Routing in `router.ts`, R2 access in `catalogue.ts`, secrets in `credentials.ts` |
| Explorer assets | `web/` (`index.html`, built `dist/`) | `pnpm build`; `web/.assetsignore` keeps sources out |
| Catalogue objects | [`scripts/export-deploy-catalogue.mjs`](../scripts/export-deploy-catalogue.mjs) | Three objects under `vars.CATALOGUE_PREFIX` |
| Secrets | GitHub Actions secrets | Synced by [`scripts/sync-worker-secrets.mjs`](../scripts/sync-worker-secrets.mjs) |
| Pipelines | [`.github/workflows/`](../.github/workflows/) | `ci.yml` verifies, `deploy.yml` ships `main` |

Node follows [`.nvmrc`](../.nvmrc); the Worker tests and deploy scripts import
TypeScript directly, which needs Node 24.

## Prerequisites

1. Cloudflare account on the **Workers Paid** plan. Parsing the hydrated
   catalogue takes ~75 ms of CPU per isolate, above the free plan's 10 ms limit.
2. A private R2 bucket; its name is `r2_buckets[].bucket_name` in `wrangler.json`.
3. An API token created from the **Edit Cloudflare Workers** template, scoped to
   this account, with **Workers R2 Storage: Edit** on the bucket so the
   catalogue upload works.
4. GitHub Actions secrets on the repository:

| Secret | Required | Used by |
|--------|----------|---------|
| `CLOUDFLARE_API_TOKEN` | yes | deploy, secret sync, catalogue upload |
| `CLOUDFLARE_ACCOUNT_ID` | yes | Wrangler account selection |
| `SYNOPTIC_API_KEY`, `SYNOPTIC_TOKEN`, `WU_API_KEY` | per network | mirrored to the Worker |
| `HOLFUY_API_KEY`, `TEMPEST_TOKEN`, `ECOWITT_APP_KEY`, `ECOWITT_API_KEY`, `AMBIENT_API_KEY`, `AMBIENT_APP_KEY` | per network | mirrored to the Worker |

Provider names are the keys of `PROVIDER_SECRET_FIELDS` in
[`deploy/worker/credentials.ts`](../deploy/worker/credentials.ts) and match
[`.env.example`](../.env.example). A missing key leaves that network's stations
`unavailable` with `reason: 'not_configured'`; nothing else fails.

## Deploy flow

Every push to `main` (or a manual **Deploy** run) does, in order:

1. `verify` — the reusable `ci.yml` job: `pnpm verify` plus a `wrangler deploy
   --dry-run` bundle check. Pull requests run the same job.
2. `deploy` — `pnpm build`, then `cloudflare/wrangler-action@v4` runs
   `wrangler deploy` with the token and account ID.
3. Secret sync — `node scripts/sync-worker-secrets.mjs` mirrors the provider
   secrets onto the Worker in one atomic `wrangler secret bulk`.

The job uses the GitHub environment `production` (created on first run; add
protection rules there if you want approvals) and a concurrency group so
deploys never overlap.

The Worker is reachable at `https://stations.<account-subdomain>.workers.dev`
until a custom domain is attached. The first deploy prints the URL in the
workflow log; it is also shown in the Cloudflare dashboard under the Worker.

## Secrets: GitHub is the only place you edit them

- **Add or rotate** a provider key: update the GitHub secret, then push to
  `main` or run the Deploy workflow manually. The sync step overwrites the
  Worker value.
- **Remove** a key: delete the GitHub secret and redeploy. The sync step removes
  it from the Worker as well (names in `credentials.ts` that are empty in
  GitHub but present on the Worker are deleted).
- Do not set the same names in the Cloudflare dashboard; they are overwritten on
  the next deploy. Do not add provider keys to `wrangler.json` `vars`.
- Rotate the deploy token by replacing `CLOUDFLARE_API_TOKEN` in GitHub only.

## Catalogue objects

The Worker reads three objects from the bucket, keyed by
`vars.CATALOGUE_PREFIX` (`catalogue/stations` → `catalogue/stations.hydrated.json`,
`.public.json`, `.public.geojson`):

- **hydrated** — full catalogue with private adapter `locator` fields, loaded
  into memory for feeds and filtered queries. Never sent to clients.
- **public JSON / GeoJSON** — sanitized documents streamed verbatim for the
  unfiltered `GET /api/stations/catalogue` (optionally `?format=geojson`), so
  the Worker never materialises them.

Publish them from a checkout that has the public catalogue in `data/catalogue/`
and the private crawl checkpoints in `.cache/stations-crawl/`:

```sh
pnpm deploy:catalogue --upload
```

This writes the artifacts to `.cache/stations-deploy/` (mode `0600`), checks
that locators are present and stripped where they must be, enforces the
40 MiB hydrated limit, and uploads with `wrangler r2 object put --remote`.
Authentication uses `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the
environment or `.env`, or an existing `wrangler login` session.

Running isolates re-check the hydrated object's etag every five minutes and
reload only when it changed; public objects are served with their R2 etag and
`Cache-Control: public, max-age=300`. No redeploy is needed after an upload.

The Worker validates only the document envelope of the hydrated object. Its
stations are trusted because the export script derives them from the already
validated catalogue; keep the bucket private and upload only through the script.

To refresh the catalogue itself, run `pnpm catalogue:crawl` locally and upload
again. A scheduled crawl workflow is a planned follow-up; it needs the sibling
`windgrams` and `flyingsites` checkouts that `crawl-na.mjs` reads launches from.

## Local Worker

`pnpm dev` remains the day-to-day explorer. To exercise the Worker itself with
the local R2 emulation:

```sh
pnpm deploy:catalogue --local   # seed wrangler's local R2 state
pnpm dev:worker                 # pnpm build && wrangler dev
```

Wrangler loads Worker secrets for local development from `.dev.vars` (ignored by
git) and otherwise falls back to `.env`, so the keys you use for `pnpm dev` work
here too. `pnpm check:worker` regenerates `deploy/worker/worker-configuration.d.ts`
from `wrangler.json` and type-checks the Worker; rerun it after changing bindings.

## First deploy checklist

1. Prerequisites above are in place; GitHub secrets exist.
2. `pnpm deploy:catalogue --upload` from a checkout with crawl checkpoints.
3. Push to `main` and watch the Deploy workflow finish both jobs.
4. Smoke test on the `workers.dev` URL:
   - `GET /` renders the explorer with styles (`GET /dist/styles.css` is
     `200`; `GET /app.ts` and `GET /styles.css` are `404`).
   - `GET /api/stations/catalogue` returns JSON with an `ETag`; repeating the
     request with `If-None-Match: <etag>` returns `304`.
   - `GET /api/stations/catalogue?format=geojson` returns a `FeatureCollection`.
   - `GET /api/stations/feed?bbox=-123,47,-121,49` returns readings, and a
     station of a network you hold a key for reports `status: "ok"` rather
     than `not_configured`.
5. In Workers Logs, confirm the first `/feed` of an isolate stays well under one
   second of CPU and no `exceededMemory` errors appear.

## Custom domain (later)

1. The zone must be on Cloudflare.
2. Add to `wrangler.json`:
   `"routes": [{ "pattern": "stations.example.com", "custom_domain": true }]`
   and set `vars.CORS_ORIGIN` to `https://stations.example.com`.
3. Push to `main`; the deploy creates the DNS record and certificate.

## Limits that shape this design

- Full catalogue: ~43k stations, 24 MiB hydrated JSON, ~28 MB parsed in the
  isolate (limit 128 MB). The export script refuses hydrated files above
  40 MiB; beyond that, shard the catalogue by region.
- Unfiltered catalogue bytes never come from the handler in the Worker; building
  them would roughly triple memory use.
- Rate limits in the provider transport are per isolate. `maxFeedStations` (30)
  and the shared `createProviderFetch` (6 concurrent, 100 ms spacing) bound
  upstream fan-out per request.
