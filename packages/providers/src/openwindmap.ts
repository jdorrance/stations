import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  type AirConditions,
  type Reading,
} from '@azohra/meteo.station';
import {
  logUpstreamFailure,
  type StationAdapterOptions,
  type StationConfigInput,
} from '@azohra/meteo.station/server';
import {
  defineStationAdapter,
  resolveEnvironment,
} from './server.ts';
import { fetchUpstreamText } from '@azohra/meteo.station/server';
import {
  formatStationUid,
  mergeCatalogueStations,
  type CatalogueStation,
} from '@stations/contracts';
import {
  INITIAL_SCOPE_REGIONS,
  inferRegionCode,
  validPosition,
  type Coverage,
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';
import { isRecord, strictNumber as finiteNumber, windDirection } from './observation-values.ts';

export const OPENWINDMAP_ARCHIVE_URL = 'https://api.pioupiou.fr/v1/live-with-meta/all';
export const OPENWINDMAP_STATION_URL = 'https://api.pioupiou.fr/v1/live-with-meta';
const CACHE_TTL_SECONDS = 60;

export type OpenWindMapStationConfig = {
  readonly station: CatalogueStation;
};

export type OpenWindMapAdapterOptions = StationAdapterOptions & {
  readonly baseUrl?: string;
};

export interface OpenWindMapParsedStation {
  readonly station: CatalogueStation;
  readonly reading: Reading;
}

export function parseOpenWindMapEntry(raw: unknown): OpenWindMapParsedStation | null {
  if (!isRecord(raw)) return null;
  const idRaw = raw.id;
  if (typeof idRaw !== 'number' && typeof idRaw !== 'string') return null;
  const nativeId = String(idRaw).trim();
  if (!nativeId) return null;

  const meta = isRecord(raw.meta) ? raw.meta : null;
  const location = isRecord(raw.location) ? raw.location : null;
  const measurements = isRecord(raw.measurements) ? raw.measurements : null;
  if (!meta || !location || !measurements) return null;

  const latitude = finiteNumber(location.latitude);
  const longitude = finiteNumber(location.longitude);
  if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
    return null;
  }

  const country = inferRegionCode({ latitude, longitude });
  const name =
    typeof meta.name === 'string' && meta.name.trim().length > 0
      ? meta.name.trim()
      : `OpenWindMap ${nativeId}`;
  const elevationM = finiteNumber(location.altitude);
  const pressureHpa = finiteNumber(measurements.pressure);
  const hasPressure = pressureHpa !== null && pressureHpa >= 300 && pressureHpa <= 1100;

  const station: CatalogueStation = {
    uid: formatStationUid('openwindmap', nativeId),
    vendor: 'openwindmap',
    nativeId,
    name,
    latitude,
    longitude,
    elevationM,
    country,
    region: null,
    timeZone: null,
    pageUrl: `https://www.openwindmap.org/PP${encodeURIComponent(nativeId)}`,
    capabilities: {
      gustLull: true,
      temperature: false,
      conditions: hasPressure,
      history: false,
    },
    samplingWindowSeconds: 240,
    recommendedPollSeconds: CACHE_TTL_SECONDS,
    locator: {
      stationId: nativeId,
    },
  };

  const dateRaw = typeof measurements.date === 'string' ? measurements.date : null;
  const observedAtMs = dateRaw ? Date.parse(dateRaw) : Number.NaN;
  if (!Number.isFinite(observedAtMs)) return null;

  const avgKmh = finiteNumber(measurements.wind_speed_avg);
  if (avgKmh === null || avgKmh < 0) return null;
  const windAvgMps = plausibleWindMps(kmhToMps(avgKmh), 'OpenWindMap');

  const maxKmh = finiteNumber(measurements.wind_speed_max);
  const minKmh = finiteNumber(measurements.wind_speed_min);
  const headingDeg = finiteNumber(measurements.wind_heading);

  const conditions: AirConditions | null = hasPressure
    ? {
        ...emptyConditions(),
        seaLevelPressureHpa: pressureHpa,
      }
    : null;

  const reading: Reading = {
    observedAt: new Date(observedAtMs).toISOString(),
    windAvgMps,
    windDirectionDeg:
      isCalm(windAvgMps) ? null : windDirection(headingDeg),
    windGustMps: maxKmh === null ? null : plausibleWindMps(kmhToMps(maxKmh), 'OpenWindMap'),
    windLullMps: minKmh === null ? null : plausibleWindMps(kmhToMps(minKmh), 'OpenWindMap'),
    temperatureC: null,
    windChillC: null,
    conditions,
  };

  return { station, reading };
}

export function parseOpenWindMapArchive(
  text: string,
  onInvalidEntry?: (error: unknown, index: number) => void,
): OpenWindMapParsedStation[] {
  const root: unknown = JSON.parse(text);
  if (!isRecord(root) || !Array.isArray(root.data)) {
    throw new Error('OpenWindMap archive response is missing data array');
  }
  const results: OpenWindMapParsedStation[] = [];
  for (const [index, item] of root.data.entries()) {
    let parsed: OpenWindMapParsedStation | null;
    try {
      parsed = parseOpenWindMapEntry(item);
    } catch (error) {
      onInvalidEntry?.(error, index);
      continue;
    }
    if (parsed) results.push(parsed);
    else onInvalidEntry?.(new Error('OpenWindMap entry is missing valid station or wind data'), index);
  }
  return results;
}

export function parseOpenWindMapSingle(text: string, expectedId: string): OpenWindMapParsedStation {
  const root: unknown = JSON.parse(text);
  const payload = isRecord(root) && isRecord(root.data) ? root.data : root;
  const parsed = parseOpenWindMapEntry(payload);
  if (!parsed || parsed.station.nativeId !== expectedId) {
    throw new Error(`OpenWindMap returned invalid data for station ${expectedId}`);
  }
  return parsed;
}

export const loadOpenWindMapStation = defineStationAdapter<
  OpenWindMapStationConfig,
  OpenWindMapAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'OpenWindMap'),
  load: async ({ station }, { environment, options }) => {
    const baseUrl = options.baseUrl ?? OPENWINDMAP_STATION_URL;
    const text = await fetchUpstreamText(environment, {
      url: `${baseUrl}/${encodeURIComponent(station.nativeId)}`,
      cacheKey: `openwindmap/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `OpenWindMap station ${station.nativeId}`,
    });
    const parsed = parseOpenWindMapSingle(text, station.nativeId);
    return {
      reading: parsed.reading,
      history: null,
      meta: {
        elevationM: parsed.station.elevationM ?? station.elevationM,
        latitude: parsed.station.latitude,
        longitude: parsed.station.longitude,
      },
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const openWindMapProvider: StationNetworkProvider = {
  vendor: 'openwindmap',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'openwindmap');
    const batches: CatalogueStation[][] = [seeds];
    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      const text = await fetchUpstreamText(environment, {
        url: OPENWINDMAP_ARCHIVE_URL,
        cacheKey: 'openwindmap/archive/all',
        cacheTtlSeconds: 300,
        subject: 'OpenWindMap station archive',
        limitBytes: 4 * 1024 * 1024,
      });
      const discovered = parseOpenWindMapArchive(text, (error, index) => {
        logUpstreamFailure(environment, 'Skipped invalid OpenWindMap discovery entry', error, { index });
      }).map(entry => entry.station);
      batches.push(discovered);
    }
    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadOpenWindMapStation({ station }, { environment, historyHours, mode }),
    );
  },
};
