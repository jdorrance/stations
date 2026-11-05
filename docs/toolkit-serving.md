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

`/catalogue?profile=live` returns the lean wind-only document: only stations
whose vendor has a live feed arm, with catalogue-only fields (`launchContext`,
terrain, `aliases`) dropped and `locator` empty. It is still a schema-valid
`StationCatalogueDocument`, so it parses through the same client code.

## Routes

All routes accept `GET` and `HEAD`. Selection query params are shared:

| Param | Meaning |
| --- | --- |
| `ids` | Comma-separated station UIDs (aliases resolve to the canonical UID) |
| `station` | Single UID (required for `/current`, `/live`, `/history`, `/climatology`) |
| `bbox` | `west,south,east,north` |
| `near` | `lat,lon,radiusKm` |
| `country` | CSV of `US` / `CA` / `MX` / `AM` / `NZ` |
| `vendor` | CSV of vendor ids |
| `category` | CSV of `freeflight` / `mountain` / `synoptic` / `marine` / `pws` |
| `place` | CSV of `airport` / `mountain` (physical siting; unknown stations excluded) |
| `landform` | CSV of `summit` / `ridge` / `slope` / `valley` / `flat` |
| `launch` | Nearest-launch slug |
| `limit` | Max stations returned |
| `format` | `geojson` on `/catalogue` and `/feed` |
| `profile` | `live` on `/catalogue` returns the lean wind-only document (see below) |
| `hours` | History window on `/feed` (validated against `maxHistoryHours`) |
| `history` | `0` on `/feed` loads current readings only and returns `history: null`. `1` or absent keeps the history window |

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

Current and full-feed loads cache normalized **per-station snapshots** in
`environment.cache`, with a bounded in-process hot cache. Current-only feeds,
`/current` and GeoJSON reuse the same observations; full feeds use separate
history-window keys. Keys include credentials (hashed), station configuration,
catalogue revision and normalized load mode/window. Feed order and aliases remain
request-defined.

Configure the handler with `cachePolicy`:

```ts
const handler = createStationsApiHandler({
  catalogue,
  environment: { cache: workerCache },
  cachePolicy: {
    freshSeconds: 30,
    maxAgeSeconds: 300,
    sonicFreshSeconds: 15,
    sonicMaxAgeSeconds: 120,
    cacheTimeoutMs: 100,
  },
});

export default {
  fetch(request, env, ctx) {
    return handler(request, { waitUntil: task => ctx.waitUntil(task) });
  },
};
```

The values shown are the defaults. `maxAgeSeconds` is the **total** retention
since the last successful load, including the fresh window. Fast-poll stations
(`recommendedPollSeconds <= 30`) use the sonic settings; omitted sonic settings
are capped by the corresponding standard setting. Set both fresh and maximum
age to zero to disable snapshots. Cache I/O is bounded by `cacheTimeoutMs`;
errors and timeouts fall through to the source.

Fresh snapshots return immediately. Retained snapshots return immediately and
schedule one bounded refresh per key when the host supplies `waitUntil`. The
host owns that work; the handler never awaits another request's I/O. Without a
background-task host, stale reads refresh in the foreground. Failed refreshes
retain the previous successful snapshot until its original hard expiry; they
never replace it with an unavailable result or extend its lifetime. Background
failures wait one fresh interval before retrying (at least one second).

Raw upstream payload caches still follow vendor-specific TTLs. Snapshot refresh
may reuse those payloads; policy does not bypass provider quotas. History,
archive and live-stream obligations remain independent.

Live responses use `Cache-Control: no-store` and a new `servedAt` envelope on
every assembly, preserving upstream `observedAt`. ETags validate observations,
not assembly time. `X-Station-Cache` reports `hit` (fresh snapshot), `fill`
(stored by this request), `stale` (retained while a refresh runs), or `miss`
(nothing reusable). The browser client adds HTTP `Age` to `servedAt` when an
external cache replays an envelope.
Cache age is separate from [measurement freshness](toolkit-contracts.md#freshness).

The repository Worker additionally caches public catalogue streams and short
exact `/current` or `ids` + `history=0` JSON responses before catalogue hydration.
It serves the stored envelope unchanged and reports residence in `Age`. Storage
requires a snapshot for every selected station, and the TTL ends at the soonest
snapshot expiry. The namespace
includes deployment identity, credentials and policy. A new isolate can serve
an entry from the same deployment before learning an out-of-band R2 revision,
for at most the configured short response TTL. Hits schedule catalogue checks;
known revision changes invalidate those entries. Deployment timing overrides
live in [Deploy](deploy.md#cache-configuration).

Cloudflare Cache API entries are local to a data center and may be evicted;
soft/hard expiry is implemented explicitly. This is not a global refresh lock.
The local explorer uses an in-memory cache. Unfiltered public catalogues stream
from R2 (the live profile is pre-gzipped); hosts without R2 memoize encoded bytes.

## Batching and subrequests

- `/feed` is capped (`maxFeedStations`, default 25) so one poll cannot explode
  Worker subrequest budgets.
- When a feed contains two or more uncached **AWC** or **Synoptic** stations,
  the handler issues one batched upstream request and splits the result into
  per-station raw cache entries. Other vendor groups proceed independently.
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
