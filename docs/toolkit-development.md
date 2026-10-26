# Developing the toolkit

The [package guide](toolkit.md) describes the libraries and their entry points.
This guide covers adding station networks, crawling catalogues, building
packages and running the local explorer.

## Add a station network

Start with [`@stations/providers`](../packages/providers/README.md). A network
provider implements [`StationNetworkProvider`](../packages/providers/src/types.ts):

1. `discover(options)` returns `CatalogueStation[]` within the requested regions
   or bounds. Preserve upstream country and timezone metadata when known; leave
   unknown fields `null` rather than guessing from coarse bounding boxes.
2. `toStationConfig(station, credentials)` returns a
   `StationConfigInput` for `@azohra/meteo.station/server`. Use
   `defineStationAdapter` to normalize upstream readings into SI units (`m/s`,
   `°C`, `hPa`, `mm`) and validate observation timestamps with the helpers in
   [`observation-values.ts`](../packages/providers/src/observation-values.ts).

Register the provider in [`registry.ts`](../packages/providers/src/registry.ts)
and add offline fixtures covering normal readings, calm wind, malformed rows and
missing timestamps.

## Crawling and building the catalogue

`pnpm catalogue:build` writes the seed catalogue to `data/catalogue/`.

`pnpm catalogue:crawl` runs [`scripts/crawl-na.mjs`](../scripts/crawl-na.mjs)
across the configured providers, enriches stations with proximity to launches in
`../windgrams/forecasts/sites.json` and `../flyingsites/data/*.geojson.json`,
and writes public artifacts to `data/catalogue/`:

```sh
pnpm catalogue:crawl --regions=US,CA,MX,AM --resume
```

- Private checkpoints with full `locator` metadata are written to
  `.cache/stations-crawl/` (mode `0600`) and are never placed inside the public
  output directory.
- Public output (`stations.json`, `stations.geojson`, `stations.ndjson.gz`,
  `launch-corridors.json`, `regions/*`, `vendors/*` and `manifest.json`) is
  sanitized through `toPublicCatalogueStation`.

## Local explorer

Run `pnpm dev` to start the local HTTP server (`scripts/serve-explorer.mjs`).
It mounts `createStationsApiHandler` at `/api/stations` using the local
catalogue and serves the interactive map and station inspector at
http://localhost:4331.

## Build and checks

Library code uses strict TypeScript. Package builds compile dependencies in
topological order, clean `dist/` and record file hashes and dependency versions
in `dist/build-inventory.json`.

```sh
pnpm check
pnpm test
pnpm test:consumer
pnpm verify
```
