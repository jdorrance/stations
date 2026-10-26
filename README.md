# Stations

Stations discovers weather stations, indexes them by location and launch
proximity, and serves live observations through the
[`@azohra/meteo.station`](https://github.com/azohra/meteo) wire contract. The
catalogue currently covers the United States, Canada, Mexico and Armenia.

The spatial index, contracts, provider adapters and browser client are also
available as independent TypeScript packages within this workspace. See the
[package guide](docs/toolkit.md) for using them in another application.

## Start locally

Use Node 20 or later and the pnpm version pinned in [package.json](package.json).
These commands build the packages and start the local station explorer:

```sh
pnpm install --frozen-lockfile
pnpm build:packages
pnpm catalogue:build
pnpm dev
```

Open http://localhost:4331 to browse the station map and inspect live readings.
To crawl upstream networks and rebuild the full regional shards, run
`pnpm catalogue:crawl`. See the [development guide](docs/toolkit-development.md)
for crawler options, cache checkpoints and adding station networks.

## Documentation

- [Packages and architecture](docs/toolkit.md)
- [API conventions and wire semantics](docs/toolkit-contracts.md)
- [Adding providers, crawling and development](docs/toolkit-development.md)

## Development checks

```sh
pnpm check
pnpm test
pnpm test:consumer
pnpm verify
```

`check` covers types, package boundaries and public declarations. `test:consumer`
installs the packed libraries in a separate project and checks their public APIs
and browser bundle.
