import { CATALOGUE_SCHEMA_VERSION, type CatalogueStation, type StationCatalogueDocument, type StationVendor } from '@stations/contracts';
import { PROVIDERS } from './registry.ts';

/**
 * The lean catalogue is the subset of fields the browser plugin and map
 * explorer render plus what viewport selection needs. It deliberately drops
 * heavy catalogue-only fields (private `locator`, `launchContext`, terrain
 * `landform`/`tpiM`, `declaredFavorableDirections`, `aliases`) so the payload
 * gzips far smaller than the public catalogue. Records stay schema-valid: every
 * required `CatalogueStation` field is present, only optional ones are omitted.
 *
 * Ownership: `providers` owns the projection because liveness is a provider
 * fact (`PROVIDERS`), not a contract fact.
 */
export interface LiveCatalogueOptions {
  /** Vendors to keep. Defaults to every vendor with a registered provider. */
  readonly vendors?: ReadonlySet<StationVendor>;
}

/** Vendors that have a live feed arm, derived from the provider registry. */
export function liveCatalogueVendors(): ReadonlySet<StationVendor> {
  return new Set(Object.keys(PROVIDERS) as StationVendor[]);
}

/** Projects one catalogue station to the lean, schema-valid record. */
export function toLiveCatalogueStation(station: CatalogueStation): CatalogueStation {
  const shortName = station.shortName ?? null;
  const category = station.category ?? null;
  const place = station.place ?? null;
  return {
    uid: station.uid,
    vendor: station.vendor,
    nativeId: station.nativeId,
    name: station.name,
    ...(shortName ? { shortName } : {}),
    latitude: station.latitude,
    longitude: station.longitude,
    elevationM: station.elevationM,
    country: station.country,
    region: station.region,
    timeZone: station.timeZone,
    pageUrl: station.pageUrl,
    capabilities: station.capabilities,
    samplingWindowSeconds: station.samplingWindowSeconds,
    recommendedPollSeconds: station.recommendedPollSeconds,
    ...(category ? { category } : {}),
    ...(place ? { place } : {}),
    locator: {},
  };
}

/**
 * Projects a catalogue document to the lean shape, keeping only stations whose
 * vendor has a live feed arm. No `locator` ever survives the projection.
 */
export function toLiveCatalogueDocument(
  document: StationCatalogueDocument,
  options: LiveCatalogueOptions = {},
): StationCatalogueDocument {
  const vendors = options.vendors ?? liveCatalogueVendors();
  return {
    schemaVersion: CATALOGUE_SCHEMA_VERSION,
    generatedAt: document.generatedAt,
    regions: [...document.regions],
    stations: document.stations
      .filter(station => vendors.has(station.vendor))
      .map(toLiveCatalogueStation),
  };
}
