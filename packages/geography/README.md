# @stations/geography

Positions, bounds, regional discovery envelopes and a spatial index for
selecting nearby weather stations. No network I/O; runs in browsers, Node and
Workers.

```ts
import { containsPoint, createSpatialIndex, distanceKm } from '@stations/geography';

const tiger = { id: 'tiger', latitude: 47.4995, longitude: -122.009 };
const blanchard = { id: 'blanchard', latitude: 48.6097, longitude: -122.426 };

containsPoint([-123, 47, -121, 49], tiger); // true
distanceKm(tiger, blanchard);               // kilometres

const index = createSpatialIndex([tiger, blanchard]);
index.queryRadius({ latitude: 47.6, longitude: -122.3 }, 40);
```

## What it owns

- Position / bounds helpers (`containsPoint`, `distanceKm`, `bearingDeg`, tiles)
- Regional envelopes for `US`, `CA`, `MX` and `AM`
- `createSpatialIndex` for bounding-box and great-circle radius queries
- `inferRegionCode` — preserves explicit country metadata; never guesses from
  overlapping rectangles

Positions use degrees with east-positive longitude. Bounds are
`[west, south, east, north]`; `west > east` crosses the antimeridian.

## Next layer

- [Types and functions](src/index.ts) · [regions](src/regions.ts) ·
  [spatial index](src/spatial-index.ts)
- [Contracts terminology](../../docs/toolkit-contracts.md#terminology)
- Tests: [geography](test/geography.test.mjs) ·
  [spatial regressions](test/spatial-regressions.test.mjs)
