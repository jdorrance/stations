# Packages

Stations ships four packages. Each owns a distinct responsibility; start with
the README for the package you need, then follow its links for types and deeper
guides.

| Package | Owns | Runs in |
| --- | --- | --- |
| [`@stations/geography`](../packages/geography/README.md) | Positions, bounds, regional envelopes, spatial index | Browser, Node, Workers |
| [`@stations/contracts`](../packages/contracts/README.md) | Catalogue records, dedup, launch context, GeoJSON/NDJSON, observation schemas | Browser, Node, Workers |
| [`@stations/providers`](../packages/providers/README.md) | Upstream discovery, live adapters, HTTP handler | Node 20+, edge Workers |
| [`@stations/client`](../packages/client/README.md) | Catalogue queries, viewport polling, reactive stores | Browser, Node |

Wire units, absence and freshness live in
[Contracts](toolkit-contracts.md). HTTP serving, credentials and caching live in
[Serving](toolkit-serving.md). Adding networks and crawling live in
[Development](toolkit-development.md).

## Typical compositions

**Map / Windy plugin / dashboard (browser)** — load a published catalogue once,
index it locally, poll a viewport feed. The local explorer also serves an
XCTrack nearest-wind page at `/xct`, with setup at `/xct-use` (see [Development](toolkit-development.md#local-explorer)):

```ts
import { createStationsClient, createViewportStationStore } from '@stations/client';

const client = createStationsClient({ baseUrl: 'https://stations.example/api/stations' });
const index = await client.loadCatalogueIndex();
const viewport = createViewportStationStore({
  client,
  catalogueByUid: index?.byUidMap,
  categories: ['freeflight', 'mountain'],
});
await viewport.setViewport([-123, 47, -121, 49]);
```

**API Worker / Node server** — mount a baked catalogue and keep upstream keys on
the server:

```ts
import { createStationsApiHandler } from '@stations/providers';
import catalogue from './stations.json' with { type: 'json' };

export default {
  fetch: createStationsApiHandler({
    catalogue,
    basePath: '/api/stations',
    credentials: {
      synopticApiKey: env.SYNOPTIC_API_KEY,
      wuApiKey: env.WU_API_KEY,
      holfuyApiKey: env.HOLFUY_API_KEY,
    },
  }),
};
```

Application concerns (map rendering, unit preferences, auth of *your* clients)
stay with the consumer. `pnpm test:consumer` compiles and runs integration
fixtures against packed archives in a separate project.
