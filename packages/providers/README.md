# @stations/providers

Discover weather stations across upstream networks, normalize live observations
into the `@azohra/meteo.station` wire contract, and serve them over HTTP.
Runs on Node 20+ and edge Workers — not in the browser.

```ts
import { createStationsApiHandler, discoverStations } from '@stations/providers';

const catalogue = await discoverStations({
  regions: ['US', 'CA', 'MX', 'AM'],
  includeRemoteDiscovery: false,
});

export const handleRequest = createStationsApiHandler({
  catalogue,
  basePath: '/api/stations',
});
```

`discoverStations` queries selected providers, validates records and merges
duplicates while preferring direct-provider metadata over meta-aggregators.
`createStationsApiHandler` mounts `/catalogue`, `/feed`, `/current`, `/live`,
`/history` and `/climatology`. Full route, auth, cache and batching behaviour:
[Serving](../../docs/toolkit-serving.md).

## What it owns

- Per-vendor `StationNetworkProvider` adapters and the
  [registry](src/registry.ts)
- Live loaders that validate timestamps/units before SI conversion
  ([observation validators](src/observation-values.ts))
- The [HTTP handler](src/handler.ts) and credential-scoped upstream cache keys
- Origin-aware retries and rate limits via
  [`createProviderFetch`](docs/transport.md)

Missing credentials degrade only those stations to `unavailable` /
`not_configured`; the rest of a feed continues.

## Supported networks

- **Free-flight / club:** `windnerd`, `holfuy`, `openwindmap`, `windsmobi`,
  `windspion`, `windguru`, `campbell`, `weatherlink`, `realtime_txt`
- **Mountain / fire / snow:** `raws`, `snotel`, `avalanche`
- **Synoptic / aviation / marine:** `iem`, `awc`, `nws`, `eccc`, `ndbc`,
  `conagua`, `hydromet_am`, `synoptic`
- **Citizen / PWS:** `cwop`, `climatenet`, `windy`, `tempest`, `ecowitt`,
  `wunderground`, `ambient`

## Next layer

- [Serving stations](../../docs/toolkit-serving.md)
- [Transport retries and limits](docs/transport.md)
- [Adding a network](../../docs/toolkit-development.md#add-a-station-network)
- [Wire semantics](../../docs/toolkit-contracts.md)
