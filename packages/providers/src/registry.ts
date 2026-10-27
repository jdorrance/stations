import { unavailableStation } from '@azohra/meteo.station';
import {
  logUpstreamFailure,
  type ServerEnvironment,
  type StationConfigInput,
} from '@azohra/meteo.station/server';
import {
  resolveEnvironment,
} from './server.ts';
import {
  CATALOGUE_SCHEMA_VERSION,
  deduplicateCatalogueStations,
  enrichStationsWithLaunches,
  formatStationUid,
  mergeCatalogueStations,
  parseCatalogueStation,
  type CatalogueStation,
  type LaunchSite,
  type StationCatalogueDocument,
  type StationVendor,
} from '@stations/contracts';
import {
  INITIAL_SCOPE_REGIONS,
  type Bounds,
  type RegionCode,
} from '@stations/geography';
import { avalancheProvider } from './avalanche.ts';
import { climatenetProvider, hydrometAmProvider } from './armenia.ts';
import { awcProvider } from './awc.ts';
import {
  campbellProvider,
  ecowittProvider,
  filterCatalogueStations,
  stationMetaFromCatalogue,
  tempestProvider,
  windnerdProvider,
} from './azohra-vendors.ts';
import { conaguaProvider } from './conagua.ts';
import {
  ambientProvider,
  cwopProvider,
  synopticProvider,
  windyProvider,
  wundergroundProvider,
} from './cwop.ts';
import { ecccProvider } from './eccc.ts';
import { holfuyProvider } from './holfuy.ts';
import { iemProvider } from './iem.ts';
import { ndbcProvider } from './ndbc.ts';
import { nwsProvider } from './nws.ts';
import { openWindMapProvider } from './openwindmap.ts';
import { rawsProvider } from './raws.ts';
import { INITIAL_SEED_STATIONS } from './seeds.ts';
import { snotelProvider } from './snotel.ts';
import type {
  DiscoverOptions,
  ProviderCredentials,
  StationNetworkProvider,
} from './types.ts';
import { windGuruProvider } from './windguru.ts';
import { windsMobiProvider } from './windsmobi.ts';
import { windSpionProvider } from './windspion.ts';
import { realtimeTxtProvider, weatherLinkProvider } from './windtalkers.ts';

export const PROVIDERS: Readonly<Record<Exclude<StationVendor, 'custom'>, StationNetworkProvider>> = {
  windnerd: windnerdProvider,
  tempest: tempestProvider,
  ecowitt: ecowittProvider,
  campbell: campbellProvider,
  openwindmap: openWindMapProvider,
  holfuy: holfuyProvider,
  awc: awcProvider,
  windsmobi: windsMobiProvider,
  windspion: windSpionProvider,
  windguru: windGuruProvider,
  windy: windyProvider,
  weatherlink: weatherLinkProvider,
  realtime_txt: realtimeTxtProvider,
  raws: rawsProvider,
  snotel: snotelProvider,
  avalanche: avalancheProvider,
  iem: iemProvider,
  nws: nwsProvider,
  eccc: ecccProvider,
  ndbc: ndbcProvider,
  conagua: conaguaProvider,
  cwop: cwopProvider,
  wunderground: wundergroundProvider,
  synoptic: synopticProvider,
  ambient: ambientProvider,
  climatenet: climatenetProvider,
  hydromet_am: hydrometAmProvider,
};

export const DEFAULT_DISCOVERY_VENDORS: readonly Exclude<StationVendor, 'custom'>[] = [
  'windnerd',
  'tempest',
  'ecowitt',
  'campbell',
  'openwindmap',
  'holfuy',
  'awc',
  'windguru',
  'weatherlink',
  'realtime_txt',
  'raws',
  'snotel',
  'avalanche',
  'eccc',
  'ndbc',
  'conagua',
  'cwop',
  'windy',
  'wunderground',
  'synoptic',
  'ambient',
  'climatenet',
  'hydromet_am',
];

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

export function unwrapAggregatorStation(station: CatalogueStation): CatalogueStation {
  if (station.vendor !== 'windsmobi') return station;
  const pvCode =
    typeof station.locator.pvCode === 'string'
      ? station.locator.pvCode.trim().toLowerCase()
      : null;
  const pvId =
    typeof station.locator.pvId === 'string' ? station.locator.pvId.trim() : null;
  if (!pvCode || !pvId) return station;

  let targetVendor: StationVendor | null = null;
  let normalizedId = pvId;
  if (pvCode === 'holfuy') targetVendor = 'holfuy';
  else if (pvCode === 'pioupiou' || pvCode === 'openwindmap') targetVendor = 'openwindmap';
  else if (pvCode === 'windguru' || pvCode === 'wg') targetVendor = 'windguru';
  else if (pvCode === 'metar') {
    targetVendor = 'awc';
    normalizedId = pvId.toUpperCase();
  }
  if (!targetVendor) return station;

  const uid = formatStationUid(targetVendor, normalizedId);
  return {
    ...station,
    uid,
    vendor: targetVendor,
    nativeId: normalizedId,
    ...(targetVendor === 'awc' ? { category: 'synoptic' as const } : {}),
    aliases: [...new Set([station.uid, ...(station.aliases ?? [])])].filter(alias => alias !== uid),
    locator:
      targetVendor === 'awc'
        ? { icaoId: normalizedId }
        : { stationId: normalizedId },
  };
}

/**
 * Normalizes aggregator identities while preserving direct-provider metadata.
 * Same-source UID enrichment happens first; converted aggregator records are
 * merged before direct records so caller/provider order cannot invert priority.
 */
export function mergeDiscoveredStations(
  stations: readonly CatalogueStation[],
  deduplicateCrossVendor = false,
): CatalogueStation[] {
  const bySourceUid = mergeCatalogueStations([stations]);
  const aggregators = bySourceUid
    .filter(station => station.vendor === 'windsmobi')
    .map(unwrapAggregatorStation);
  const direct = bySourceUid.filter(station => station.vendor !== 'windsmobi');
  const normalized = mergeCatalogueStations([aggregators, direct]);
  return deduplicateCrossVendor ? deduplicateCatalogueStations(normalized) : normalized;
}

export interface AggregateCatalogueOptions {
  readonly regions?: readonly RegionCode[];
  readonly vendors?: readonly Exclude<StationVendor, 'custom'>[];
  readonly bounds?: Bounds;
  readonly seeds?: readonly CatalogueStation[];
  readonly launches?: readonly LaunchSite[];
  readonly maxLaunchDistanceKm?: number;
  readonly deduplicateCrossVendor?: boolean;
  readonly includeRemoteDiscovery?: boolean;
  readonly environment?: ServerEnvironment;
}

export async function discoverStations(
  options: AggregateCatalogueOptions = {},
): Promise<StationCatalogueDocument> {
  const environment = resolveEnvironment(options.environment);
  const regions = options.regions ?? INITIAL_SCOPE_REGIONS;
  const vendors = [...new Set(options.vendors ?? DEFAULT_DISCOVERY_VENDORS)];
  const seeds = options.seeds ?? INITIAL_SEED_STATIONS;

  const discoverOptions: DiscoverOptions = {
    regions,
    bounds: options.bounds,
    seeds,
    launches: options.launches,
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
        return discoverFallback(seeds, vendor, discoverOptions);
      }
    }),
  );

  const normalizedBatches = results.map(batch =>
    batch
      .map(rawStation => {
        const validated = parseCatalogueStation(rawStation);
        if (!validated) {
          environment.logger({ level: 'warn', code: 'config_invalid', message: 'Skipping invalid discovered station' });
          return null;
        }
        return validated;
      })
      .filter((station): station is CatalogueStation => station !== null),
  );

  let stations = mergeDiscoveredStations(normalizedBatches.flat(), options.deduplicateCrossVendor);

  stations = filterCatalogueStations(stations, discoverOptions);

  if (options.launches && options.launches.length > 0) {
    stations = enrichStationsWithLaunches(
      stations,
      options.launches,
      options.maxLaunchDistanceKm ?? 50,
    );
  }

  return {
    schemaVersion: CATALOGUE_SCHEMA_VERSION,
    generatedAt: environment.now().toISOString(),
    regions: [...regions],
    stations,
  };
}

function discoverFallback(
  seeds: readonly CatalogueStation[],
  vendor: StationVendor,
  options: DiscoverOptions,
): CatalogueStation[] {
  const provider = providerForVendor(vendor);
  if (!provider) return [];
  return filterCatalogueStations(
    seeds.filter(station => station.vendor === vendor),
    options,
  );
}
