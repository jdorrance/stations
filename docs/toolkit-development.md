# Development

This guide owns adding station networks, crawling catalogues, running the local
explorer and verifying changes. Package roles are in [Packages](toolkit.md);
wire rules are in [Contracts](toolkit-contracts.md); the HTTP handler is in
[Serving](toolkit-serving.md).

## Add a station network

Start with [`@stations/providers`](../packages/providers/README.md). A network
implements [`StationNetworkProvider`](../packages/providers/src/types.ts):

1. **`discover(options)`** — return `CatalogueStation[]` inside the requested
   regions or bounds. Preserve upstream country and timezone when known; leave
   unknowns `null` rather than guessing from coarse bounding boxes.
2. **`toStationConfig(station, credentials)`** — return a `StationConfigInput`
   for `@azohra/meteo.station/server`. Use `defineStationAdapter` to normalize
   readings into SI units and validate timestamps with
   [`observation-values.ts`](../packages/providers/src/observation-values.ts).

New Zealand providers are split by ownership:
[`wmo-nz.ts`](../packages/providers/src/wmo-nz.ts),
[`hilltop.ts`](../packages/providers/src/hilltop.ts),
[`ecan.ts`](../packages/providers/src/ecan.ts),
[`zephyr.ts`](../packages/providers/src/zephyr.ts)
(barrel: [`newzealand.ts`](../packages/providers/src/newzealand.ts)).
Shared Ogimet SYNOP parsing is in
[`ogimet-synop.ts`](../packages/providers/src/ogimet-synop.ts).

Register the provider in [`registry.ts`](../packages/providers/src/registry.ts).
Add offline fixtures for normal readings, calm wind, malformed rows and missing
timestamps.

## Catalogue crawl

`pnpm catalogue:build` writes a seed catalogue (offline, seed vendors only) to
`data/catalogue/`.

`pnpm catalogue:crawl` runs [`scripts/crawl-na.mjs`](../scripts/crawl-na.mjs)
across configured providers, enriches stations with proximity to launches from
`../windgrams/forecasts/sites.json` and `../flyingsites/data/*.geojson.json`,
and writes public artifacts:

```sh
pnpm catalogue:crawl -- --regions=US,CA,MX,AM,NZ --resume
```

| Path | Contents |
| --- | --- |
| `.cache/stations-crawl/` | Private checkpoints with full `locator` metadata (`0600`). Never deploy. |
| `data/overrides/stations.json` | Curated short names, place, and fill-only elevation/region/position; applied after merge. Bulk US labels: `pnpm shortnames:generate` |
| `data/terrain/landforms.json` | DEM landform and `tpiM` per station; applied after merge |
| `data/catalogue/stations.json` | Full public catalogue |
| `data/catalogue/stations.geojson` | GeoJSON twin |
| `data/catalogue/stations.ndjson.gz` | Compressed NDJSON |
| `data/catalogue/launch-corridors.json` | Free-flight + near-launch subset |
| `data/catalogue/regions/*` | Per-country shards |
| `data/catalogue/vendors/*` | Per-vendor shards |
| `data/catalogue/manifest.json` | Counts, hashes, vendor run status |

Public files are sanitized through `toPublicCatalogueStation`. Counts and
hashes have one owner: `manifest.json`. Override semantics (11-character
`shortName` / `place`, fill-only elevation/region/position) are owned by
[Contracts](toolkit-contracts.md).

Optional API keys for live discovery and the explorer live in `.env`
([`.env.example`](../.env.example)).

## Local explorer

```sh
pnpm dev
```

[`scripts/serve-explorer.mjs`](../scripts/serve-explorer.mjs) mounts
`createStationsApiHandler` at `/api/stations` on the local catalogue (full
`stations.json` by default) and serves the map at http://localhost:4331 plus
the XCTrack nearest-wind widget at http://localhost:4331/xct. Setup, every URL
parameter, and a copy-to-clipboard URL are at http://localhost:4331/xct-use
(the same list is the header of [`web/xct.ts`](../web/xct.ts)). The widget loads a
nearby catalogue subset for metadata, then requests live readings by ID with
bounded refill; [`web/xct-feed.ts`](../web/xct-feed.ts) owns that request budget
and server-time anchors. It does not download the full catalogue.
Pass `--corridors` to serve the
launch-corridor shard instead.

Production runs the same handler in a Cloudflare Worker; see the
[deployment guide](deploy.md) for the Worker entry, catalogue upload and
secrets flow.

## Windy private plugin

The consumer app in [`plugins/windy`](../plugins/windy/src/plugin.svelte) adds
station observations to Windy's existing map. It uses the public Stations API;
provider credentials stay on the Worker. Its bounded request scheduler is owned
by [`data.ts`](../plugins/windy/src/data.ts), independently of the explorer.

Build the libraries, then set `STATIONS_API_BASE_URL` to the real HTTPS Worker
origin plus `/api/stations` and run `pnpm --filter @stations/windy-plugin start`.
Open [Windy developer mode](https://www.windy.com/developer-mode), trust the local
development certificate, and load `https://localhost:9999/plugin.js`. The API must
also be HTTPS and allow Windy's cross-origin requests; plain HTTP localhost is
not a suitable API base from an HTTPS Windy page.

`pnpm --filter @stations/windy-plugin build` produces `plugins/windy/dist/` and
requires that environment variable. `build:check` uses a non-routable test URL
for CI bundle checks, not a working pilot artifact. Check map markers, units,
partial failures, background/resume and close/reopen in Windy before sharing.
The arrows indicate the meteorological direction the wind comes **from**;
measurements remain current when Windy's forecast slider moves.

Private publication is a manual workflow in
[`windy-plugin.yml`](../.github/workflows/windy-plugin.yml), not part of Worker
deployment. It requires a Windy Plugins API key stored as `WINDY_API_KEY` in
GitHub secrets, along with `STATIONS_API_BASE_URL` for the real HTTPS API base.
Confirm the API URL and plugin identity before running it.
A private plugin is unlisted, not authenticated; sharing its installation URL
does not restrict access to the underlying API. Publication and live Windy
compatibility checks require the operator's account.

## Build and checks

Library code uses strict TypeScript. Package builds compile dependencies in
topological order, clean `dist/`, and record file hashes plus dependency
versions in `dist/build-inventory.json`.

The widget has a dedicated browser-only type check (`pnpm check:web`) in the
root gate. Script tests execute its entry point against deterministic location,
clock, HTTP, and DOM fixtures; browser/device checks still own layout and paint.

```sh
pnpm check          # types, boundaries, public API
pnpm test           # package + script tests
pnpm test:consumer  # packed libraries in a fresh project
pnpm verify         # check + test + consumer
```

Follow [AGENTS.md](../AGENTS.md): keep entry points small, give each fact one
owner, and validate structural edits with `pnpm verify`.
