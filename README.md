# Stations

Stations finds weather stations near free-flight launches, indexes them by
location, and serves live wind observations through a small HTTP API and the
[`@azohra/meteo.station`](https://github.com/azohra/meteo) wire contract.

Coverage today is the United States, Canada, Mexico and Armenia, plus global
Holfuy windtalkers. Catalogue size and per-network counts live in
[`data/catalogue/manifest.json`](data/catalogue/manifest.json).

## What you get

- A published station catalogue (JSON, GeoJSON, NDJSON) with launch proximity
- A server handler that proxies live upstream reads and keeps credentials private
- Four TypeScript packages for geography, contracts, providers and browser clients

Plugins, maps and dashboards call **your** API. Upstream keys never leave the
server. See [Serving stations](docs/toolkit-serving.md).

## Quick start

The Node version in [.nvmrc](.nvmrc) and the pnpm version in
[package.json](package.json):

```sh
pnpm install --frozen-lockfile
pnpm build:packages
pnpm catalogue:build
pnpm dev
```

Open http://localhost:4331 for the map explorer and live station inspector.
http://localhost:4331/xct-use is the XCTrack setup page (the widget itself is
http://localhost:4331/xct).

Optional credentials (Synoptic, Weather Underground, Holfuy, …) go in `.env`;
see [`.env.example`](.env.example). To rebuild the full live catalogue from
upstream networks:

```sh
pnpm catalogue:crawl -- --regions=US,CA,MX,AM --resume
```

## Documentation

Read in this order; each layer owns one set of facts:

| Doc | Owns |
| --- | --- |
| [Packages](docs/toolkit.md) | Package map and how to compose them |
| [Serving](docs/toolkit-serving.md) | HTTP routes, auth, cache, batching, deploy |
| [Contracts](docs/toolkit-contracts.md) | Units, absence, freshness, terminology |
| [Development](docs/toolkit-development.md) | Providers, crawl, explorer, checks |
| [Deploy](docs/deploy.md) | Cloudflare Worker, R2 catalogue, secrets, pipelines |

Package READMEs: [`geography`](packages/geography/README.md) ·
[`contracts`](packages/contracts/README.md) ·
[`providers`](packages/providers/README.md) ·
[`client`](packages/client/README.md)

## Development checks

```sh
pnpm check
pnpm test
pnpm test:consumer
pnpm verify
```

`check` covers types (including the browser widget), package boundaries and public declarations.
`test:consumer` installs packed libraries in a separate project and verifies
their public APIs and browser bundle. `verify` runs the full gate.
