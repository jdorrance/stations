# Changelog

## Unreleased

- Preserve the latest viewport across overlapping requests, cancel obsolete requests, and coalesce identical pending viewports.
- Expose retained data bounds, stale state, and errors on viewport snapshots.
- Add detailed HTTP client results, request cancellation, and configurable timeouts while retaining nullable convenience methods.
- Allow all client methods to be used without a bound receiver.

## 0.1.0

- Initial release with `createCatalogueIndex`, `createStationsClient`, `createViewportStationStore`, and `@azohra/meteo.station/client` re-exports.
