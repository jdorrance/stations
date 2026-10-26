import { unavailableStation } from '@azohra/meteo.station';
import {
  logUpstreamFailure,
  resolveEnvironment,
  type ServerEnvironment,
  type StationConfigInput,
} from '@azohra/meteo.station/server';
import {
  CATALOGUE_SCHEMA_VERSION,
  mergeCatalogueStations,
  parseCatalogueStation,
  type CatalogueStation,
  type StationCatalogueDocument,
  type StationVendor,
} from '@stations/contracts';
import {
  INITIAL_SCOPE_REGIONS,
  inferRegionCode,
  type Bounds,
  type RegionCode,
} from '@stations/geography';
import { awcProvider } from './awc.ts';
import {
  campbellProvider,
  ecowittProvider,
  stationMetaFromCatalogue,
  tempestProvider,
  windnerdProvider,
} from './azohra-vendors.ts';
import { holfuyProvider } from './holfuy.ts';
import { openWindMapProvider } from './openwindmap.ts';
import { INITIAL_SEED_STATIONS } from './seeds.ts';
import type {
  DiscoverOptions,
  ProviderCredentials,
  StationNetworkProvider,
} from './types.ts';

export const PROVIDERS: Readonly<Record<Exclude<StationVendor, 'custom'>, StationNetworkProvider>> = {
  windnerd: windnerdProvider,
  tempest: tempestProvider,
  ecowitt: ecowittProvider,
  campbell: campbellProvider,
  openwindmap: openWindMapProvider,
  holfuy: holfuyProvider,
  awc: awcProvider,
};

export function providerForVendor(vendor: StationVendor): StationNetworkProvider | null {
  if (vendor === 'custom') return null;
  return PROVIDERS[vendor] ?? null;
}

export function toStationConfig(
  station: CatalogueStation,
  credentials?: ProviderCredentials,
): StationConfigInput {
  const provider = providerForVendor(station.vendor);
  if (!provider) {
    const meta = stationMetaFromCatalogue(station, station.vendor);
    return {
      vendor: 'custom',
      id: station.uid,
      name: station.name,
      latitude: station.latitude,
      longitude: station.longitude,
      elevationM: station.elevationM,
      timeZone: station.timeZone,
      pageUrl: station.pageUrl,
      async load() {
        return unavailableStation(meta, 'not_configured');
      },
    };
  }
  return provider.toStationConfig(station, credentials);
}

export function toStationConfigs(
  stations: readonly CatalogueStation[],
  credentials?: ProviderCredentials,
): StationConfigInput[] {
  return stations.map(station => toStationConfig(station, credentials));
}

export interface AggregateCatalogueOptions {
  readonly regions?: readonly RegionCode[];
  readonly vendors?: readonly Exclude<StationVendor, 'custom'>[];
  readonly bounds?: Bounds;
  readonly seeds?: readonly CatalogueStation[];
  readonly includeRemoteDiscovery?: boolean;
  readonly environment?: ServerEnvironment;
}

export async function discoverStations(
  options: AggregateCatalogueOptions = {},
): Promise<StationCatalogueDocument> {
  const environment = resolveEnvironment(options.environment);
  const regions = options.regions ?? INITIAL_SCOPE_REGIONS;
  const vendors =
    options.vendors ??
    (Object.keys(PROVIDERS) as readonly Exclude<StationVendor, 'custom'>[]);
  const seeds = options.seeds ?? INITIAL_SEED_STATIONS;

  const discoverOptions: DiscoverOptions = {
    regions,
    bounds: options.bounds,
    seeds,
    includeRemoteDiscovery: options.includeRemoteDiscovery ?? false,
    environment,
  };

  const results = await Promise.all(
    vendors.map(async vendor => {
      const provider = PROVIDERS[vendor];
      try {
        return await provider.discover(discoverOptions);
      } catch (error) {
        logUpstreamFailure(environment, `${vendor} station discovery failed`, error, {
          vendor,
        });
        return DiscoverFallback(seeds, vendor, discoverOptions);
      }
    }),
  );

  const normalizedBatches = results.map(batch =>
    batch
      .map(station => {
        const country = station.country ?? inferRegionCode(station);
        return parseCatalogueStation({ ...station, country });
      })
      .filter((station): station is CatalogueStation => station !== null),
  );

  const stations = mergeCatalogueStations(normalizedBatches);
  return {
    schemaVersion: CATALOGUE_SCHEMA_VERSION,
    generatedAt: environment.now().toISOString(),
    regions: [...regions],
    stations,
  };
}

function DiscoverFallback(
  seeds: readonly CatalogueStation[],
  vendor: StationVendor,
  options: DiscoverOptions,
): CatalogueStation[] {
  const provider = providerForVendor(vendor);
  if (!provider) return [];
  return seeds.filter(
    station =>
      station.vendor === vendor &&
      (!options.regions ||
        (station.country !== null && options.regions.includes(station.country))),
  );
}
