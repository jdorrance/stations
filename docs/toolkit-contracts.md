# Contracts

This guide owns wire semantics: units, absence, freshness and shared
terminology. Package surfaces are in [Packages](toolkit.md); HTTP behaviour is
in [Serving](toolkit-serving.md).

Each package exposes a small set of named entry points through its `exports`
map. Public types describe values a caller needs; upstream wire formats stay
inside their packages. New exports should serve a concrete use in an application
or another package.

## Units and absence

Use shared domain types when passing station data between packages. Field names
carry units where practical (`temperatureC`, `windAvgMps`, `elevationM`,
`distanceKm`).

| Quantity | Unit / rule |
| --- | --- |
| Wind speed | Metres per second (`m/s`). Convert to display units at the edge. |
| Wind direction | Degrees true `[0, 360)`, the bearing the wind blows **from**. |
| Calm | Below `0.5 m/s` (`CALM_THRESHOLD_MPS`), `windDirectionDeg` is `null`. |
| Temperature | Degrees Celsius (`°C`). |
| Pressure | Hectopascals (`hPa`) reduced to mean sea level (`seaLevelPressureHpa`). |
| Elevation | Metres above mean sea level (`elevationM`). |
| Distance / bearing | Kilometres; forward bearing from launch to station in degrees true. |

**Absence vs zero.** A missing quantity is `null` and is never sent as `0`.
`windGustMps: null` means gusts are not reported; `windAvgMps: 0` is a measured
calm reading. A `null` direction on a blowing reading means a missing or
unserviceable vane.

**Timestamps.** ISO-8601 UTC strings. Adapters preserve the upstream observation
time and never substitute fetch time for a missing measurement time.

**Public exports.** `toPublicCatalogueStation`, `toPublicStationCatalogue` and
`serializeCatalogueNdjson` strip server-only `locator` fields so tokens and
private endpoints never appear in published files or `/catalogue` responses.

External data enters as `unknown` and is validated before indexing or display.
Network operations accept cancellation and timeouts. Viewport stores coalesce
identical bounds and discard out-of-order responses.

## Freshness

Two windows, two jobs:

| Window | Owner | Purpose |
| --- | --- | --- |
| Discovery activity | `isRecentObservation` (30 days) | Keep decommissioned hardware out of the catalogue |
| Tactical flying | `pilotFreshness` / `pilotFreshnessThresholds` | Tell a pilot if a reading is still useful on launch |

Pilot thresholds by category:

| Category | `live` | `aging` | `stale` |
| --- | --- | --- | --- |
| `freeflight` | ≤ 4 min (≤ 2 min for 30 s sonic) | ≤ 15 min (≤ 7.5 min sonic) | beyond |
| `synoptic` / `pws` / `marine` | ≤ 10 min | ≤ 30 min | beyond |
| `mountain` | ≤ 15 min | ≤ 45 min | beyond |

## Terminology

- **Position** — latitude and longitude in degrees; east-positive longitude.
- **Bounds** — `[west, south, east, north]` in degrees; `west > east` crosses
  the antimeridian.
- **Discovery coverage** — coarse envelopes used to query upstream networks.
  Rectangles do not assign political country codes; `country` comes only from
  trusted upstream or curated metadata.
- **Station UID** — `<vendor>:<nativeId>` (for example `holfuy:1652` or
  `raws:TT029`). Cross-network duplicates keep secondary UIDs in `aliases`.
- **Category** — `'freeflight' | 'mountain' | 'synoptic' | 'marine' | 'pws'`.
  Network / application role (freshness, feed selection). Not physical siting.
- **Place** — optional `'airport' | 'mountain'`. `airport` is inferred for
  METAR/ASOS sites and names containing airport/airfield/airstrip. `mountain`
  is an override only. A `place` override always replaces.
- **Landform** — `'summit' | 'ridge' | 'slope' | 'valley' | 'flat'`. The 1 km
  ring is the local shape. The 5 km ring decides whether a local low is a
  valley floor or a slope under higher ground. `tpiM` is the 1 km value:
  center elevation minus that ring's mean. Flat means both rings barely
  change height, not “low elevation”.
  Owned by [`data/terrain/landforms.json`](../data/terrain/landforms.json),
  applied after crawl merge.
- **Short name** — optional curated label on a catalogue station, at most 11
  characters. When present, live feeds use it as `Station.name` so compact UIs
  (XCTrack tiles) can show it without a second field. Catalogue `name` stays
  the upstream name.
- **Station overrides** — curated fields in
  [`data/overrides/stations.json`](../data/overrides/stations.json), applied
  after crawl merge. `shortName` and `place` always replace. `elevationM`,
  `region`, and a latitude/longitude pair fill only when that field is missing
  on the merged station. A crawl cannot overwrite the file.
- **Launch context** — distance and forward bearing from the nearest known
  free-flight launch within the configured search radius.
- **Feed** — an `@azohra/meteo.station` `StationFeed` with current readings and
  optional history for a set of stations.

## Generated declarations

The TypeScript compiler emits JavaScript and declarations together. Runtime
schemas in `@stations/contracts` and `@azohra/meteo.station` define the types of
validated documents. Edit those sources when an API changes; `dist/` is
generated output.

`pnpm check` verifies declarations, exports, dependencies and boundary rules.
`pnpm test:consumer` compiles an external example against packed libraries and
confirms browser bundles exclude server adapters.
