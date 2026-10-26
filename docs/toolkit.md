# Station toolkit

The toolkit provides the geographic indexing, wire contracts, upstream station
adapters and client stores used by the Stations workspace. Its packages can also
support a standalone map layer, a Windy plugin, a launch briefing page or a
live station dashboard. They are currently private workspace packages.

Catalogue discovery and live upstream adapters run in Node or an edge worker.
Published catalogues are JSON, NDJSON and GeoJSON documents that a browser can
index and query without contacting upstream station networks directly.

## Packages

- [geography](../packages/geography/README.md) works with positions, bounds,
  regional coverages and spatial indexing.
- [contracts](../packages/contracts/README.md) defines catalogue records,
  cross-network deduplication, launch-proximity metadata, GeoJSON features and
  re-exported `@azohra/meteo.station` observation documents.
- [providers](../packages/providers/README.md) discovers stations across upstream
  networks, normalizes live readings into the `@azohra/meteo.station` wire
  contract and mounts the HTTP feed handler.
- [client](../packages/client/README.md) queries published catalogues, polls
  active map viewports and exposes reactive stores for maps and dashboards.

## Using the packages

Start with the README for the package you need. It links to its public types and
usage snippets. Application concerns such as map rendering, unit preferences and
credentials stay with the consumer.

`pnpm test:consumer` compiles and runs integration fixtures against packed archives
in a separate project.

For changes to the toolkit, see [API conventions](toolkit-contracts.md) and the
[development guide](toolkit-development.md). TypeScript generates the published
declarations from source; package checks catch private imports and undeclared
dependencies.
