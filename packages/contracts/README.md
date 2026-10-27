# @stations/contracts

Runtime validation, TypeScript types and GeoJSON/NDJSON codecs for station
catalogues and live observation feeds. Use this package when reading or writing
station documents before maps or UI. Runs in browsers, Node and Workers.

```ts
import {
  catalogueToGeoJson,
  parseStationCatalogueJson,
  parseStationFeedJson,
} from '@stations/contracts';

const catalogue = parseStationCatalogueJson(rawJson);
if (catalogue === null) throw new Error('Invalid station catalogue');

const features = catalogueToGeoJson(catalogue.stations, catalogue.generatedAt);
```

Units, absence and freshness are owned by
[Contracts](../../docs/toolkit-contracts.md). This package implements those rules
in Zod schemas and codecs.

## What it owns

| Subpath | Responsibility |
| --- | --- |
| [`/catalogue`](src/catalogue.ts) | `CatalogueStation` / document schemas, cross-network dedup, launch enrichment, station overrides |
| [`/public-catalogue`](src/public-catalogue.ts) | Strip server-only `locator` fields for published files and `/catalogue` |
| [`/geojson`](src/geojson.ts) | Catalogue and `StationFeed` → GeoJSON `FeatureCollection` |
| [`/ndjson`](src/ndjson.ts) | Newline-delimited catalogue serialize / parse |

The [root export](src/index.ts) also re-exports `@azohra/meteo.station` wire
schemas and derivations (`Reading`, `StationFeed`, freshness helpers, …).

## Next layer

- [Wire semantics](../../docs/toolkit-contracts.md)
- [Serving / public catalogue stripping](../../docs/toolkit-serving.md#credentials-stay-on-the-server)
- [Package map](../../docs/toolkit.md)
