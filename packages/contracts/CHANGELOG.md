# Changelog

## Unreleased

- Validate station identities, aliases, and timestamps without throwing on malformed catalogue records.
- Strip private locators and unknown fields from public catalogue exports.
- Deduplicate transitive aliases and network-qualified airport identifiers while preserving direct-provider locators.
- Clear outdated launch proximity metadata when recomputing catalogue enrichment.

## 0.1.0

- Initial release with `CatalogueStation`, `StationCatalogueDocument`, GeoJSON conversion helpers, and `@azohra/meteo.station` wire re-exports.
