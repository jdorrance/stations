# @stations/contracts

Runtime validation, TypeScript types and GeoJSON/NDJSON codecs for station
catalogues and live observation feeds. Use this package when reading or writing
station documents before passing them to map layers or UI components. It works
in browsers and Node.

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

Temperatures are °C, pressures hPa, wind speeds m/s and elevations metres MSL.
Directions are degrees true `[0, 360)` from which the wind blows, or `null` when
calm (`< 0.5 m/s`). Optional measurements are `null` when not reported; zero is
a measured value.

## Subpaths and helpers

- [`@stations/contracts/catalogue`](src/catalogue.ts) validates `CatalogueStation`
  and `StationCatalogueDocument` records, deduplicates stations across
  overlapping networks (`deduplicateCatalogueStations`) and attaches nearest
  launch distance and bearing (`enrichStationsWithLaunches`).
- [`@stations/contracts/public-catalogue`](src/public-catalogue.ts) strips
  server-only `locator` fields before writing public catalogue files or serving
  `/catalogue` responses.
- [`@stations/contracts/geojson`](src/geojson.ts) converts station catalogues
  and `@azohra/meteo.station` `StationFeed` documents into GeoJSON
  `FeatureCollection` objects for MapLibre, Leaflet and Windy plugins.
- [`@stations/contracts/ndjson`](src/ndjson.ts) serializes and parses newline-
  delimited station catalogues.

The [public exports](src/index.ts) also re-export the `@azohra/meteo.station`
wire schemas and derivations.
