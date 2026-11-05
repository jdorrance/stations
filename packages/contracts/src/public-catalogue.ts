import {
  catalogueStationSchema,
  type CatalogueStation,
  type StationCatalogueDocument,
} from './catalogue.ts';

/**
 * Query value that opts a `/catalogue` request into the lean wind-only profile.
 * Shared by the worker router and the browser client so the two cannot drift.
 */
export const LIVE_CATALOGUE_PROFILE = 'live';

/** Public catalogue records contain metadata, never server adapter locators. */
export function toPublicCatalogueStation(station: CatalogueStation): CatalogueStation {
  // Schema parsing also removes unexpected top-level fields supplied by callers.
  return catalogueStationSchema.parse({ ...station, locator: {} });
}

export function toPublicStationCatalogue(
  document: StationCatalogueDocument,
): StationCatalogueDocument {
  return {
    schemaVersion: document.schemaVersion,
    generatedAt: document.generatedAt,
    regions: [...document.regions],
    stations: document.stations.map(toPublicCatalogueStation),
  };
}
