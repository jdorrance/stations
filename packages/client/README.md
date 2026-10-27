# @stations/client

Query published station catalogues, poll map viewports and subscribe to live
feeds in a browser or Node app. Talks only to your Stations HTTP API — never to
upstream networks.

```ts
import { createStationsClient, createViewportStationStore } from '@stations/client';

const client = createStationsClient({ baseUrl: '/api/stations' });
const index = await client.loadCatalogueIndex();

const viewport = createViewportStationStore({
  client,
  categories: ['freeflight', 'mountain'],
  catalogueByUid: index?.byUidMap,
});

const stop = viewport.subscribe(() => {
  const { geojson, feed, stale, error } = viewport.getSnapshot();
  if (geojson) console.log(geojson.features.length, stale, error);
});

await viewport.setViewport([-123.0, 47.0, -121.0, 49.0]);
stop();
```

## What it owns

- **`createStationsClient`** — HTTP client for `/catalogue`, `/feed` and
  `/current`. Nullable helpers (`loadFeed`, …) and detailed results
  (`loadFeedResult`, …) that distinguish HTTP, network, parse, timeout and
  abort errors.
- **`createCatalogueIndex`** — in-memory spatial index over a catalogue
  document (bounds, radius, country, vendor, category, launch, aliases).
- **`createViewportStationStore`** — coalesces identical in-flight bounds,
  cancels superseded polls, keeps the last feed as `stale: true` on failure,
  and exposes GeoJSON for the map.

Also re-exports polling stores from `@azohra/meteo.station/client`
([public exports](src/index.ts)).

## Next layer

- [Plugin recipe and HTTP routes](../../docs/toolkit-serving.md#plugin-recipe)
- [Wire semantics](../../docs/toolkit-contracts.md)
- [`@stations/providers` handler](../providers/README.md)
