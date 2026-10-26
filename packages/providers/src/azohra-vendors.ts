import { unavailableStation, type StationMeta } from '@azohra/meteo.station';
import type { StationConfigInput } from '@azohra/meteo.station/server';
import type { CatalogueStation, StationVendor } from '@stations/contracts';
import {
  INITIAL_SCOPE_REGIONS,
  containsPoint,
  inRegion,
  type Coverage,
} from '@stations/geography';
import type {
  DiscoverOptions,
  ProviderCredentials,
  StationNetworkProvider,
} from './types.ts';

export function filterCatalogueStations(
  stations: readonly CatalogueStation[],
  options: DiscoverOptions = {},
): CatalogueStation[] {
  const regions = options.regions ?? INITIAL_SCOPE_REGIONS;
  const regionSet = new Set(regions);
  return stations.filter(station => {
    if (options.bounds && !containsPoint(options.bounds, station)) return false;
    if (station.country && regionSet.has(station.country)) return true;
    return regions.some(code => inRegion(code, station, station.country));
  });
}

export function stationMetaFromCatalogue(
  station: CatalogueStation,
  sourceLabel: string,
): StationMeta {
  return {
    id: station.uid,
    name: station.name,
    sourceLabel,
    pageUrl: station.pageUrl,
    latitude: station.latitude,
    longitude: station.longitude,
    timeZone: station.timeZone,
    elevationM: station.elevationM,
    declaredFavorableDirections: station.declaredFavorableDirections
      ? station.declaredFavorableDirections.map(arc => ({ ...arc }))
      : null,
    capabilities: { ...station.capabilities },
    samplingWindowSeconds: station.samplingWindowSeconds,
    recommendedPollSeconds: station.recommendedPollSeconds,
  };
}

function unconfiguredCustomStation(
  station: CatalogueStation,
  sourceLabel: string,
): StationConfigInput {
  const meta = stationMetaFromCatalogue(station, sourceLabel);
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

export function windnerdConfigFromCatalogue(station: CatalogueStation): StationConfigInput {
  const stationKey =
    typeof station.locator.stationKey === 'string'
      ? station.locator.stationKey
      : station.nativeId;
  const locationId =
    typeof station.locator.locationId === 'number'
      ? station.locator.locationId
      : Number(station.locator.locationId ?? 1);
  return {
    vendor: 'windnerd',
    id: station.uid,
    name: station.name,
    latitude: station.latitude,
    longitude: station.longitude,
    elevationM: station.elevationM,
    timeZone: station.timeZone,
    pageUrl: station.pageUrl,
    stationKey,
    locationId: Number.isInteger(locationId) && locationId > 0 ? locationId : 1,
    hasTemperature: station.capabilities.temperature,
    hasPressure: station.capabilities.conditions && station.elevationM !== null,
    hasBattery: Boolean(station.capabilities.battery),
  };
}

export function tempestConfigFromCatalogue(
  station: CatalogueStation,
  credentials?: ProviderCredentials,
): StationConfigInput {
  const token =
    credentials?.tempestToken ??
    (typeof station.locator.token === 'string' ? station.locator.token : undefined);
  const rawStationId =
    typeof station.locator.stationId === 'number'
      ? station.locator.stationId
      : Number(station.nativeId);
  if (!token || !Number.isInteger(rawStationId) || rawStationId <= 0) {
    return unconfiguredCustomStation(station, 'Tempest');
  }
  return {
    vendor: 'tempest',
    id: station.uid,
    name: station.name,
    latitude: station.latitude,
    longitude: station.longitude,
    elevationM: station.elevationM,
    timeZone: station.timeZone,
    pageUrl: station.pageUrl,
    stationId: rawStationId,
    token,
  };
}

export function ecowittConfigFromCatalogue(
  station: CatalogueStation,
  credentials?: ProviderCredentials,
): StationConfigInput {
  const applicationKey = credentials?.ecowittApplicationKey;
  const apiKey = credentials?.ecowittApiKey;
  const mac =
    typeof station.locator.mac === 'string' ? station.locator.mac : station.nativeId;
  if (!applicationKey || !apiKey || station.elevationM === null) {
    return unconfiguredCustomStation(station, 'Ecowitt');
  }
  return {
    vendor: 'ecowitt',
    id: station.uid,
    name: station.name,
    latitude: station.latitude,
    longitude: station.longitude,
    elevationM: station.elevationM,
    timeZone: station.timeZone,
    pageUrl: station.pageUrl,
    applicationKey,
    apiKey,
    mac,
    hasBattery: Boolean(station.capabilities.battery ?? true),
  };
}

export function campbellConfigFromCatalogue(station: CatalogueStation): StationConfigInput {
  const baseUrl =
    typeof station.locator.baseUrl === 'string' ? station.locator.baseUrl : null;
  const source =
    typeof station.locator.source === 'string'
      ? station.locator.source
      : station.nativeId;
  const timeZone = station.timeZone;
  if (!baseUrl || !timeZone) {
    return unconfiguredCustomStation(station, 'Campbell logger');
  }
  return {
    vendor: 'campbell',
    id: station.uid,
    name: station.name,
    latitude: station.latitude,
    longitude: station.longitude,
    elevationM: station.elevationM,
    timeZone,
    pageUrl: station.pageUrl,
    baseUrl,
    source,
    ...(typeof station.locator.currentTable === 'string'
      ? { currentTable: station.locator.currentTable }
      : {}),
    ...(typeof station.locator.historyTable === 'string'
      ? { historyTable: station.locator.historyTable }
      : {}),
  };
}

function createSeededAzohraProvider(
  vendor: Extract<StationVendor, 'windnerd' | 'tempest' | 'ecowitt' | 'campbell'>,
  toConfig: (station: CatalogueStation, credentials?: ProviderCredentials) => StationConfigInput,
): StationNetworkProvider {
  const coverage: Coverage = { kind: 'global' };
  return {
    vendor,
    coverage,
    async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
      const seeds = (options.seeds ?? []).filter(station => station.vendor === vendor);
      return filterCatalogueStations(seeds, options);
    },
    toStationConfig: toConfig,
  };
}

export const windnerdProvider: StationNetworkProvider = createSeededAzohraProvider(
  'windnerd',
  station => windnerdConfigFromCatalogue(station),
);

export const tempestProvider: StationNetworkProvider = createSeededAzohraProvider(
  'tempest',
  tempestConfigFromCatalogue,
);

export const ecowittProvider: StationNetworkProvider = createSeededAzohraProvider(
  'ecowitt',
  ecowittConfigFromCatalogue,
);

export const campbellProvider: StationNetworkProvider = createSeededAzohraProvider(
  'campbell',
  station => campbellConfigFromCatalogue(station),
);
