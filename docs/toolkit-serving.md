# Serving stations

This guide owns the public HTTP surface, credential handling, caching and
batching. Package entry points are in [Packages](toolkit.md); wire semantics are
in [Contracts](toolkit-contracts.md).

## Handler

`createStationsApiHandler` from `@stations/providers` mounts the API on a
standard `Request` → `Response` function (Node, Cloudflare Workers, or any
fetch-compatible runtime):

```ts
import { createProviderFetch, createStationsApiHandler } from '@stations/providers';

const handler = createStationsApiHandler({
  catalogue,                         // StationCatalogueDocument or async loader
  basePath: '/api/stations',
  credentials: { /* server-only keys */ },
  environment: {
    fetch: createProviderFetch({ maxConcurrent: 6 }),
    cache: workerCache,              // optional; see Caching
  },
  maxFeedStations: 25,               // default
  corsOrigin: '*',                   // default
});
```

Ship a baked public catalogue (`data/catalogue/stations.json` or a regional /
corridor shard). Crawl checkpoints under `.cache/stations-crawl/` are
build-time only and must not be deployed.

## Routes

All routes accept `GET` and `HEAD`. Selection query params are shared:

| Param | Meaning |
| --- | --- |
| `ids` | Comma-separated station UIDs (aliases resolve to the canonical UID) |
| `station` | Single UID (required for `/current`, `/live`, `/history`, `/climatology`) |
| `bbox` | `west,south,east,north` |
| `near` | `lat,lon,radiusKm` |
| `country` | CSV of `US` / `CA` / `MX` / `AM` |
| `vendor` | CSV of vendor ids |
| `category` | CSV of `freeflight` / `mountain` / `synoptic` / `marine` / `pws` |
| `launch` | Nearest-launch slug |
| `limit` | Max stations returned |
| `format` | `geojson` on `/catalogue` and `/feed` |
| `hours` | History window on `/feed` (validated against `maxHistoryHours`) |

| Route | Response | Notes |
| --- | --- | --- |
| `/catalogue` | Public catalogue JSON or GeoJSON | Locators stripped; `ETag` + `304` on the unfiltered document |
| `/feed` | `@azohra/meteo.station` `StationFeed` or GeoJSON | Capped by `maxFeedStations` (default 25) |
| `/current` | Single-station current reading | |
| `/live` | Live stream when the vendor supports it | |
| `/history` | Archive window when available | |
| `/climatology` | Climatology when available | |

Invalid filters fail closed with `400`. Missing routes return `404`.

## Credentials stay on the server

Plugins never receive upstream API keys or private adapter locators.

1. Inject secrets into the Worker / process env at deploy time.
2. Pass them as `credentials` into the handler.
3. `/catalogue` strips every `locator` field before responding.
4. Live routes look up the private locator by UID, call upstream with the
   server key, and return a sanitized reading.

Missing credentials for a vendor degrade only those stations to
`unavailable` / `reason: 'not_configured'`; the rest of a feed still succeeds.
Credentialed cache keys are scoped by a hash of the secret so one key cannot
reuse another key’s upstream response.

Client authentication against *your* API (API keys, JWTs, per-plugin quotas) is
not built into the handler. Add that in front if you need it.

## Caching

Three layers, each with one job:

| Layer | What | Typical TTL |
| --- | --- | --- |
| HTTP | `Cache-Control` on responses; `ETag` / `304` on full `/catalogue` | Catalogue 300s; feed ~30–60s |
| Upstream (`environment.cache`) | Raw upstream payloads keyed per station (and credential scope) | ~30–60s for observations; longer for directories |
| Client | Hold the catalogue in memory; viewport store coalesces identical polls | App-controlled |

On Cloudflare, wire `environment.cache` to the Cache API or KV. The local
explorer uses an in-memory cache. Full-catalogue JSON is memoized inside the
isolate as a pre-encoded buffer after the first request.

## Batching and subrequests

- `/feed` is capped (`maxFeedStations`, default 25) so one poll cannot explode
  Worker subrequest budgets.
- When a feed contains two or more uncached **AWC** or **Synoptic** stations,
  the handler issues one batched upstream request and splits the result into
  per-station cache entries before adapters run.
- Synoptic `/v2/auth` token exchange is coalesced across concurrent cold loads.
- Other vendors still fan out one request each, rate-limited by
  [`createProviderFetch`](../packages/providers/docs/transport.md).

## Plugin recipe

1. `GET /catalogue` once (or daily). Prefer `If-None-Match` after the first load.
2. Build a client index with `createCatalogueIndex` (or use
   `createViewportStationStore`).
3. Poll `GET /feed?bbox=…&limit=25` (or `ids=…`) every 30–60 seconds for the
   visible map.
4. Render GeoJSON from the feed or from `catalogueIndex.toGeoJson(stations)`.

The plugin base URL is your Worker. It does not call Synoptic, Weather
Underground, WeatherLink or Holfuy directly.

## Deploy sketch (Cloudflare Worker)

This repository's own Worker, catalogue upload and secrets pipeline are
documented in [deploy.md](deploy.md). Any other host follows the same shape:

1. Build packages (`pnpm build:packages`).
2. Crawl or copy a public catalogue artifact into the Worker bundle or R2/KV.
3. Set secrets (`SYNOPTIC_API_KEY`, `WU_API_KEY`, `HOLFUY_API_KEY`, …).
4. Export `createStationsApiHandler({ catalogue, credentials, environment })`
   as the Worker `fetch` handler.
5. Point the explorer or plugin `baseUrl` at the Worker origin + `/api/stations`.

Rate limits from `createProviderFetch` are **in-process**. Multiple isolates
need separate coordination if you share a tight upstream quota; see
[transport](../packages/providers/docs/transport.md).
