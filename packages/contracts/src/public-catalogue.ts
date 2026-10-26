import {
  catalogueStationSchema,
  type CatalogueStation,
  type StationCatalogueDocument,
} from './catalogue.ts';

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
