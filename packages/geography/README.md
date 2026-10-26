# @stations/geography

Small geographic calculations and spatial indexing for selecting station
networks, tiling bounding boxes and querying nearby weather stations. The
functions run in browsers and Node without fetching data.

```ts
import { containsPoint, createSpatialIndex, distanceKm } from '@stations/geography';

const tiger = { id: 'tiger', latitude: 47.4995, longitude: -122.009 };
const blanchard = { id: 'blanchard', latitude: 48.6097, longitude: -122.426 };

containsPoint([-123, 47, -121, 49], tiger); // true
distanceKm(tiger, blanchard); // great-circle distance in kilometres

const index = createSpatialIndex([tiger, blanchard]);
index.queryRadius({ latitude: 47.6, longitude: -122.3 }, 40);
```

Positions use degrees with east-positive longitude. Bounds are
`[west, south, east, north]`; a west value greater than east describes an area
crossing the date line. `coversPoint` accepts global coverage, bounds or a union
of areas.

`regions` defines discovery envelopes for the United States (`US`), Canada
(`CA`), Mexico (`MX`) and Armenia (`AM`). Coarse envelopes select which upstream
tiles to query; `inferRegionCode` preserves explicit country metadata and never
guesses a country from overlapping rectangles.

See the [types and functions](src/index.ts), [regional descriptors](src/regions.ts)
and [spatial index](src/spatial-index.ts), or the [geography tests](test/geography.test.mjs)
and [spatial regressions](test/spatial-regressions.test.mjs) for edge cases.
