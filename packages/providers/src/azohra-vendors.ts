import {
  unavailableStation,
  windnerdStationUrl,
  type StationMeta,
} from '@azohra/meteo.station';
import {
  ecowittStationConfigSchema,
  loadEcowittStation,
  loadTempestStation,
  parseWindnerdLiveLocation,
  tempestStationConfigSchema,
  type CustomStationLoader,
  type ResolvedEnvironment,
  type StationConfigInput,
} from '@azohra/meteo.station/server';
import {
  resolveEnvironment,
} from './server.ts';
import { fetchUpstreamStream, fetchUpstreamText } from '@azohra/meteo.station/server';
import {
  formatStationUid,
  mergeCatalogueStations,
  type CatalogueStation,
  type StationVendor,
} from '@stations/contracts';
import {
  INITIAL_SCOPE_REGIONS,
  containsPoint,
  coverageForRegions,
  coversPoint,
  inferRegionCode,
  validPosition,
  type Coverage,
} from '@stations/geography';
import type {
  DiscoverOptions,
  ProviderCredentials,
  StationNetworkProvider,
} from './types.ts';
import { credentialScopedEnvironment } from './freeflight-observations.ts';

export const WINDNERD_DIRECTORY_URL = 'https://windnerd.net/en/stations';
export const WINDNERD_LIVE_BASE_URL = 'https://windnerd.net/api/live-url';

export function filterCatalogueStations(
  stations: readonly CatalogueStation[],
  options: DiscoverOptions = {},
): CatalogueStation[] {
  const regions = options.regions ?? INITIAL_SCOPE_REGIONS;
  const regionSet = new Set(regions);
  const coverage = coverageForRegions(regions);
  return stations.filter(station => {
    if (options.bounds && !containsPoint(options.bounds, station)) return false;
    if (station.country !== null) return regionSet.has(station.country);
    // Coverage is only a coarse discovery filter; it does not assign a country.
    return coversPoint(coverage, station);
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

function catalogueConfigIdentity(station: CatalogueStation) {
  return {
    id: station.uid,
    name: station.name,
    latitude: station.latitude,
    longitude: station.longitude,
    elevationM: station.elevationM,
    timeZone: station.timeZone,
    pageUrl: station.pageUrl,
  };
}

export function customStationConfig(
  station: CatalogueStation,
  load: CustomStationLoader,
  pageUrlOverride?: string | null,
): StationConfigInput {
  return {
    ...catalogueConfigIdentity(station),
    ...(pageUrlOverride !== undefined ? { pageUrl: pageUrlOverride } : {}),
    vendor: 'custom',
    load,
  };
}

export function unconfiguredCustomStation(
  station: CatalogueStation,
  sourceLabel: string,
): StationConfigInput {
  const meta = stationMetaFromCatalogue(station, sourceLabel);
  return customStationConfig(station, async () =>
    unavailableStation(meta, 'not_configured'),
  );
}

export function windnerdConfigFromCatalogue(station: CatalogueStation): StationConfigInput {
  const stationKey =
    typeof station.locator.stationKey === 'string'
      ? station.locator.stationKey
      : station.nativeId;
  const locationId =
    typeof station.locator.locationId === 'number'
      ? station.locator.locationId
      : Number(station.locator.locationId);
  if (!Number.isSafeInteger(locationId) || locationId <= 0) {
    return unconfiguredCustomStation(station, 'WindNerd');
  }
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
    locationId,
    hasTemperature: station.capabilities.temperature,
    hasPressure: station.capabilities.conditions && station.elevationM !== null,
    hasBattery: Boolean(station.capabilities.battery),
  };
}

export function tempestConfigFromCatalogue(
  station: CatalogueStation,
  credentials?: ProviderCredentials,
): StationConfigInput {
  const token = credentials?.tempestTokens?.[station.nativeId] ?? credentials?.tempestToken;
  const rawStationId =
    typeof station.locator.stationId === 'number'
      ? station.locator.stationId
      : Number(station.nativeId);
  if (!token || !Number.isInteger(rawStationId) || rawStationId <= 0) {
    return unconfiguredCustomStation(station, 'Tempest');
  }
  const config = {
    vendor: 'tempest' as const,
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
  return {
    ...catalogueConfigIdentity(station),
    vendor: 'custom',
    async load({ environment, historyHours, mode }) {
      return loadTempestStation(tempestStationConfigSchema.parse(config), {
        environment: await credentialScopedEnvironment(environment, [token]),
        historyHours,
        mode,
      });
    },
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
  const config = {
    vendor: 'ecowitt' as const,
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
  return {
    ...catalogueConfigIdentity(station),
    vendor: 'custom',
    async load({ environment, historyHours, mode }) {
      return loadEcowittStation(ecowittStationConfigSchema.parse(config), {
        environment: await credentialScopedEnvironment(environment, [applicationKey, apiKey]),
        historyHours,
        mode,
      });
    },
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

/**
 * Extracts public WindNerd station keys and optional names/countries from the `windnerd.net/en/stations` HTML directory.
 */
export function parseWindnerdDirectoryHtml(
  html: string,
): { stationKey: string; name?: string; countryHint?: string }[] {
  const found = new Map<string, { stationKey: string; name?: string; countryHint?: string }>();
  const linkRegex = /href=["']\/(?:en|fr)\/(?:stations\/)?([a-z0-9][a-z0-9_-]{2,60})["']/gi;
  const reserved = new Set([
    'stations',
    'shop',
    'docs',
    'about',
    'contact',
    'login',
    'register',
    'privacy',
    'terms',
  ]);
  for (const match of html.matchAll(linkRegex)) {
    const key = match[1]?.toLowerCase();
    if (!key || reserved.has(key)) continue;
    if (!found.has(key)) found.set(key, { stationKey: key });
  }
  return [...found.values()];
}

async function probeWindnerdStationInit(
  environment: ResolvedEnvironment,
  stationKey: string,
  nameFallback?: string,
): Promise<CatalogueStation | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetchUpstreamStream(environment, {
      url: `${WINDNERD_LIVE_BASE_URL}/${encodeURIComponent(stationKey)}`,
      subject: `WindNerd live probe ${stationKey}`,
      connectTimeoutMs: 4_000,
      signal: controller.signal,
    });
    reader = response.body?.getReader();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let buffer = '';
    let bytesRead = 0;
    while (bytesRead < 65_536) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > 65_536) throw new Error('WindNerd init exceeds response limit');
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const jsonText = frame.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!jsonText) continue;
        const rawJson = JSON.parse(jsonText) as {
          type?: string;
          location?: { id?: number; name?: string };
        };
        if (rawJson.type !== 'INIT' && !/^event:\s*INIT\s*$/m.test(frame)) continue;
        const loc = parseWindnerdLiveLocation(rawJson.location);
        if (!loc || loc.latitude === null || loc.longitude === null) return null;
        if (!validPosition({ latitude: loc.latitude, longitude: loc.longitude })) return null;
        const country = inferRegionCode({ latitude: loc.latitude, longitude: loc.longitude });
        const locationId = rawJson.location?.id;
        if (typeof locationId !== 'number' || !Number.isSafeInteger(locationId) || locationId <= 0) return null;
        const name =
          (typeof rawJson.location?.name === 'string' && rawJson.location.name.trim()) ||
          nameFallback ||
          stationKey;
        return {
          uid: formatStationUid('windnerd', stationKey),
          vendor: 'windnerd',
          nativeId: stationKey,
          name,
          latitude: loc.latitude,
          longitude: loc.longitude,
          elevationM: loc.altitudeM,
          country,
          region: null,
          timeZone: loc.timeZone,
          pageUrl: windnerdStationUrl(stationKey),
          category: 'freeflight',
          declaredFavorableDirections: loc.declaredFavorableDirections,
          capabilities: {
            gustLull: true,
            temperature: true,
            conditions: loc.altitudeM !== null,
            history: true,
            live: true,
            battery: true,
            recentSummaries: true,
          },
          samplingWindowSeconds: 60,
          recommendedPollSeconds: 60,
          locator: {
            stationKey,
            locationId,
          },
        };
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
  }
}

export function createSeededProvider(
  vendor: StationVendor,
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

const createSeededAzohraProvider = createSeededProvider;

export const windnerdProvider: StationNetworkProvider = {
  vendor: 'windnerd',
  coverage: { kind: 'global' },
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'windnerd');
    const batches: CatalogueStation[][] = [seeds];
    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      try {
        const html = await fetchUpstreamText(environment, {
          url: WINDNERD_DIRECTORY_URL,
          accept: 'text/html',
          cacheKey: 'windnerd/directory/en',
          cacheTtlSeconds: 3_600,
          subject: 'WindNerd public stations directory',
        });
        const entries = parseWindnerdDirectoryHtml(html);
        const discovered: CatalogueStation[] = [];
        for (const entry of entries) {
          const station = await probeWindnerdStationInit(
            environment,
            entry.stationKey,
            entry.name,
          );
          if (station) discovered.push(station);
        }
        batches.push(discovered);
      } catch {
        // Fallback to seeds when directory or stream probe is unreachable
      }
    }
    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig: station => windnerdConfigFromCatalogue(station),
};

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
