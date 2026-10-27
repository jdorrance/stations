# API conventions

Each package exposes a small set of named entry points through its `exports`
map. Public types describe the values a caller needs; upstream wire formats and
parsing helpers stay inside their packages. New exports should serve a concrete
use in an application or another package.

## Types and values

Use shared domain types when passing station data between packages. Field names
carry units where practical, such as `temperatureC`, `windAvgMps`, `elevationM`
and `distanceKm`.

- **Speeds:** metres per second (`m/s`). Convert to display units (`mph`, `kmh`,
  `knots`) when values leave the data layer.
- **Directions:** degrees true `[0, 360)`, the bearing the wind blows **from**.
  Below the WMO calm threshold (`0.5 m/s`, `CALM_THRESHOLD_MPS`),
  `windDirectionDeg` is `null`. A `null` direction on a blowing reading means a
  missing or unserviceable vane.
- **Temperatures and pressures:** degrees Celsius (`°C`) and hectopascals
  (`hPa`) reduced to mean sea level (`seaLevelPressureHpa`).
- **Elevations:** metres above mean sea level (`elevationM`).
- **Absence vs zero:** a missing quantity is `null` and is never sent as `0`.
  `windGustMps: null` means gusts are not reported; `windAvgMps: 0` is a
  measured calm reading.
- **Timestamps and freshness:** ISO-8601 UTC strings. Adapters preserve the
  upstream observation timestamp and never substitute fetch time for a missing
  measurement time. Discovery applies a 30-day activity window
  (`isRecentObservation`) to exclude decommissioned hardware from the catalogue,
  while live feeds and GeoJSON features evaluate tactical flying freshness
  (`pilotFreshness` / `pilotFreshnessThresholds`: `freeflight` windtalkers are
  `live` ≤ 4m and `stale` > 15m; `synoptic`/`pws`/`marine` are `live` ≤ 10m and
  `stale` > 30m; `mountain` telemetry is `live` ≤ 15m and `stale` > 45m).

External data enters as `unknown` and is validated before indexing or display.
Public catalogue exports (`toPublicCatalogueStation`, `toPublicStationCatalogue`
and `serializeCatalogueNdjson`) strip server-only `locator` fields so adapter
tokens or private endpoints never appear in published files or `/catalogue`
responses.

Network operations accept cancellation and timeouts. Viewport stores coalesce
identical bounds and discard out-of-order responses.

## Generated declarations

The TypeScript compiler emits JavaScript and declarations together. Runtime
schemas in `@stations/contracts` and `@azohra/meteo.station` define the types of
validated documents. Edit those sources when an API changes; `dist/` is
generated output.

`pnpm check` checks declarations, exports, package dependencies and boundary
rules, including unintended package-owned `any` types. `pnpm test:consumer`
compiles and runs an external example against the packed libraries and verifies
that browser bundles exclude server adapters.

## Terminology

- **Position:** latitude and longitude in degrees, with east-positive longitude.
- **Bounds:** `[west, south, east, north]` in degrees; `west > east` crosses the
  antimeridian.
- **Discovery coverage:** coarse geographic envelopes used to query upstream
  networks. Rectangular coverage does not assign political country codes;
  `country` is preserved only from trusted upstream or curated metadata.
- **Station UID:** `<vendor>:<nativeId>` (for example `windnerd:tiger-mountain`
  or `raws:TT029`). Cross-network duplicates retain secondary UIDs in `aliases`.
- **Category:** `'freeflight' | 'mountain' | 'synoptic' | 'marine' | 'pws'`.
- **Launch context:** distance and forward bearing from the nearest known
  free-flight launch within the configured search radius.
- **Feed:** an `@azohra/meteo.station` `StationFeed` document containing current
  readings and optional history for a set of stations.
