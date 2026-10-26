# Stations

Lightweight weather station aggregator and spatial feed toolkit built on [`@azohra/meteo.station`](https://github.com/azohra/meteo) and [`@azohra/meteo.core`](https://github.com/azohra/meteo).

Designed to discover, index, and normalize weather stations worldwide — starting with **North America (`US`, `CA`, `MX`)** and **Armenia (`AM`)** — and serve them through one wire contract for:

- **Custom maps** (MapLibre GL, Leaflet, Windgrams regional maps)
- **Windy plugins** (bounding-box & radius GeoJSON + live `StationFeed` stores)
- **Dashboards** (drop-in compatibility with `@azohra/meteo.station/react` and `@azohra/meteo.station/elements`)

## Packages

- [`@stations/geography`](packages/geography/README.md) — Positions, bounding boxes, polygon containment, `US` / `CA` / `MX` / `AM` regional coverages, and a zero-dependency grid `SpatialIndex`.
- [`@stations/contracts`](packages/contracts/README.md) — Validated `CatalogueStation` and `StationCatalogueDocument` schemas, GeoJSON `FeatureCollection` converters (`catalogueToGeoJson`, `feedToGeoJson`), and re-exported `@azohra/meteo.station` wire contracts.
- [`@stations/providers`](packages/providers/README.md) — Server-side station discovery and live observation adapters across `windnerd`, `tempest`, `ecowitt`, `campbell`, `openwindmap` (Pioupiou), `holfuy`, and `awc` (NOAA Aviation Weather Center METAR), plus the mountable `createStationsApiHandler`.
- [`@stations/client`](packages/client/README.md) — Browser-safe spatial catalogue index (`createCatalogueIndex`), HTTP client (`createStationsClient`), viewport GeoJSON/feed store (`createViewportStationStore`), and `@azohra/meteo.station/client` stores.

## Quick start

```sh
pnpm install
pnpm check
pnpm test
pnpm test:consumer
pnpm catalogue:build
```

`pnpm catalogue:build` writes the aggregated station catalogue and GeoJSON files to `data/catalogue/` (`stations.json`, `stations.geojson`, and per-country slices under `data/catalogue/regions/`). Pass `--remote` to merge live upstream network discovery with the curated seed catalogue.

## Usage

### 1. Mount the API handler (Cloudflare Workers, Node, Deno, Bun)

```ts
import { createStationsApiHandler, discoverStations } from '@stations/providers';

const catalogue = await discoverStations({ regions: ['US', 'CA', 'MX', 'AM'] });

export const handleRequest = createStationsApiHandler({
  catalogue,
  basePath: '/api/stations',
  credentials: {
    tempestToken: process.env.TEMPEST_TOKEN,
    ecowittApplicationKey: process.env.ECOWITT_APP_KEY,
    ecowittApiKey: process.env.ECOWITT_API_KEY,
  },
});
```

Routes served:
- `GET /api/stations/catalogue?bbox=w,s,e,n&country=US,CA,MX,AM&vendor=windnerd,openwindmap,holfuy,awc&format=json|geojson`
- `GET /api/stations/catalogue?near=lat,lon,radiusKm&limit=20`
- `GET /api/stations/feed?bbox=w,s,e,n&format=json|geojson` (or `?ids=uid1,uid2`)
- `GET /api/stations/current?station=<uid>`
- `GET /api/stations/live?station=<uid>` (SSE stream)
- `GET /api/stations/history?station=<uid>&from=<iso>&to=<iso>&period=<min>`

### 2. Custom Maps & Windy Plugins (`@stations/client`)

```ts
import { createStationsClient, createViewportStationStore } from '@stations/client';

const client = createStationsClient({ baseUrl: '/api/stations' });
const index = await client.loadCatalogueIndex();

const viewport = createViewportStationStore({
  client,
  catalogueByUid: index?.byUidMap,
});

viewport.subscribe(() => {
  const { geojson, feed } = viewport.getSnapshot();
  if (geojson) {
    // Update MapLibre GeoJSON source or Windy plugin markers
  }
});

// Call whenever the map viewport moves:
await viewport.setViewport([-123.0, 47.0, -121.0, 49.0]);
```

### 3. Dashboards (`@azohra/meteo.station/react` or `/elements`)

Every `/feed` and `/current` response is a valid `@azohra/meteo.station` wire document, so `<StationFeedProvider>`, `<StationCard>`, `<WindHistoryChart>`, and `<meteo-station-card>` work directly against `/api/stations`.
