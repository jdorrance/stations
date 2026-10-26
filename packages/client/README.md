# @stations/client

Query published station catalogues, poll active map viewports and subscribe to
station feeds in a browser or Node app.

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

`createStationsClient` provides both nullable convenience methods (`loadFeed`,
`loadCatalogue`, `loadCurrent`) and detailed result methods (`loadFeedResult`,
`loadCatalogueResult`, `loadCurrentResult`) that distinguish HTTP status errors,
network failures, invalid documents, timeouts and caller cancellations.

`createViewportStationStore` manages map viewport polling: it coalesces
identical in-flight bounds, cancels superseded viewport requests, retains the
previous `dataBounds` and `feed` with `stale: true` when a refresh fails, and
converts live feeds into GeoJSON `FeatureCollection` objects.

`createCatalogueIndex` wraps a `StationCatalogueDocument` in an in-memory
spatial index supporting bounding-box, radius, country, vendor, category and
launch-corridor queries, as well as alias resolution.

The [public exports](src/index.ts) also re-export the polling stores from
`@azohra/meteo.station/client`.
