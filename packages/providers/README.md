# @stations/providers

Discover weather stations across upstream networks, normalize live observations
into the `@azohra/meteo.station` wire contract and serve them over HTTP.
Discovery and live adapters run on Node 20+ and edge workers.

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

`discoverStations` queries the selected providers, validates each station record
and merges duplicate identifiers while preserving direct-provider metadata over
meta-aggregators. `createStationsApiHandler` mounts `/catalogue` (JSON and
GeoJSON) alongside `@azohra/meteo.station`'s `/feed`, `/current`, `/live`,
`/history` and `/climatology` routes.

## Supported networks

- **Free-flight and club windtalkers:** `windnerd`, `holfuy` (API and keyless
  widget fallback), `openwindmap` (Pioupiou), `windsmobi`, `windspion`,
  `windguru`, `campbell`, `weatherlink` and `realtime_txt` (Cumulus/WeeWX).
- **Mountain, fire and avalanche:** `raws` (NIFC Interagency FeatureServer),
  `snotel` (USDA NRCS AWDB) and `avalanche` (Avalanche Canada).
- **National synoptic, aviation and marine:** `iem` (ASOS, AWOS and DCP
  networks across US, CA, MX and AM), `awc` (NOAA Aviation Weather Center
  METAR), `nws` (`api.weather.gov`), `eccc` (MSC GeoMet SWOB), `ndbc` (buoys and
  C-MAN stations) and `conagua` (Mexico SMN EMAs).
- **Citizen and personal stations:** `cwop` (APRS weather packets), `windy`,
  `tempest`, `ecowitt`, `wunderground`, `synoptic` and `ambient`.

Adapters validate upstream timestamps and units before converting to SI. Missing
or unconfigured credentials degrade individual stations to `unavailable` with
`reason: 'not_configured'` without failing the rest of a feed. Credentialed
requests isolate their cache keys by authorization scope.

See the [provider registry](src/registry.ts), [HTTP handler](src/handler.ts) and
[observation validators](src/observation-values.ts) for details.

## Request scheduling

Provider discovery, adapters and this package's server loaders share automatic
GET/HEAD retries and rate limits by URL origin. Transient failures use bounded
exponential backoff with jitter; `Retry-After` pauses requests to that origin.
Caller cancellation and existing upstream deadlines still apply.

Use `createProviderFetch` to configure limits and pass the same fetch instance in
`environment.fetch` to the crawler or handler. Limits are local to that instance
and process; multiple workers need coordination outside this package. See
[transport configuration and behavior](docs/transport.md).
