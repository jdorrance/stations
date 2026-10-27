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
pnpm catalogue:crawl -- --regions=US,CA,MX,AM --resume
```

| Path | Contents |
| --- | --- |
| `.cache/stations-crawl/` | Private checkpoints with full `locator` metadata (`0600`). Never deploy. |
| `data/catalogue/stations.json` | Full public catalogue |
| `data/catalogue/stations.geojson` | GeoJSON twin |
| `data/catalogue/stations.ndjson.gz` | Compressed NDJSON |
| `data/catalogue/launch-corridors.json` | Free-flight + near-launch subset |
| `data/catalogue/regions/*` | Per-country shards |
| `data/catalogue/vendors/*` | Per-vendor shards |
| `data/catalogue/manifest.json` | Counts, hashes, vendor run status |

Public files are sanitized through `toPublicCatalogueStation`. Counts and
hashes have one owner: `manifest.json`.

Optional API keys for live discovery and the explorer live in `.env`
([`.env.example`](../.env.example)).

## Local explorer

```sh
pnpm dev
```

[`scripts/serve-explorer.mjs`](../scripts/serve-explorer.mjs) mounts
`createStationsApiHandler` at `/api/stations` on the local catalogue (full
`stations.json` by default) and serves the map at http://localhost:4331.
Pass `--corridors` to serve the launch-corridor shard instead.

Production runs the same handler in a Cloudflare Worker; see the
[deployment guide](deploy.md) for the Worker entry, catalogue upload and
secrets flow.

## Build and checks

Library code uses strict TypeScript. Package builds compile dependencies in
topological order, clean `dist/`, and record file hashes plus dependency
versions in `dist/build-inventory.json`.

```sh
pnpm check          # types, boundaries, public API
pnpm test           # package + script tests
pnpm test:consumer  # packed libraries in a fresh project
pnpm verify         # check + test + consumer
```

Follow [AGENTS.md](../AGENTS.md): keep entry points small, give each fact one
owner, and validate structural edits with `pnpm verify`.
