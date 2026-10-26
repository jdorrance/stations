import { plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  normalizeDegrees,
  type AirConditions,
  type Reading,
} from '@azohra/meteo.station';
import {
  defineStationAdapter,
  fetchUpstreamText,
  resolveEnvironment,
  type StationAdapterOptions,
  type StationConfigInput,
} from '@azohra/meteo.station/server';
import {
  formatStationUid,
  mergeCatalogueStations,
  type CatalogueStation,
} from '@stations/contracts';
import {
  INITIAL_SCOPE_REGIONS,
  inferRegionCode,
  regionDescriptor,
  validPosition,
  type Bounds,
  type Coverage,
} from '@stations/geography';
import { filterCatalogueStations, stationMetaFromCatalogue } from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

export const AWC_METAR_URL = 'https://aviationweather.gov/api/data/metar';
const KNOTS_TO_MPS = 0.5144444444444445;
const CACHE_TTL_SECONDS = 120;

export type AwcStationConfig = {
  readonly station: CatalogueStation;
};

export type AwcAdapterOptions = StationAdapterOptions & {
  readonly metarUrl?: string;
};

export interface AwcParsedMetar {
  readonly station: CatalogueStation;
  readonly reading: Reading;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Magnus approximation for relative humidity (%) from temperature and dew point (°C). */
function relativeHumidityFromDewPoint(tempC: number | null, dewPointC: number | null): number | null {
  if (tempC === null || dewPointC === null) return null;
  const a = 17.625;
  const b = 243.04;
  const gammaT = (a * tempC) / (b + tempC);
  const gammaD = (a * dewPointC) / (b + dewPointC);
  const rh = 100 * Math.exp(gammaD - gammaT);
  return Math.min(100, Math.max(0, Math.round(rh)));
}

export function parseAwcMetarEntry(raw: unknown): AwcParsedMetar | null {
  if (!isRecord(raw)) return null;
  const icaoId = typeof raw.icaoId === 'string' ? raw.icaoId.trim().toUpperCase() : null;
  if (!icaoId) return null;

  const latitude = finiteNumber(raw.lat);
  const longitude = finiteNumber(raw.lon);
  if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
    return null;
  }

  const country = inferRegionCode({ latitude, longitude });
  const defaultZone = country ? regionDescriptor(country).defaultTimeZone : null;
  const name =
    typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : icaoId;
  const elevationM = finiteNumber(raw.elev);

  const station: CatalogueStation = {
    uid: formatStationUid('awc', icaoId),
    vendor: 'awc',
    nativeId: icaoId,
    name,
    latitude,
    longitude,
    elevationM,
    country,
    region: null,
    timeZone: defaultZone,
    pageUrl: `https://aviationweather.gov/data/metar/?id=${encodeURIComponent(icaoId)}`,
    capabilities: {
      gustLull: true,
      temperature: true,
      conditions: true,
      history: false,
    },
    samplingWindowSeconds: 120,
    recommendedPollSeconds: CACHE_TTL_SECONDS,
    locator: {
      icaoId,
    },
  };

  const obsTimeEpoch = finiteNumber(raw.obsTime);
  const reportTimeIso = typeof raw.reportTime === 'string' ? Date.parse(raw.reportTime) : Number.NaN;
  const observedAtMs =
    obsTimeEpoch !== null
      ? obsTimeEpoch * 1_000
      : Number.isFinite(reportTimeIso)
        ? reportTimeIso
        : Number.NaN;
  if (!Number.isFinite(observedAtMs)) return null;

  const wspdKnots = finiteNumber(raw.wspd) ?? 0;
  const windAvgMps = plausibleWindMps(wspdKnots * KNOTS_TO_MPS, 'AWC');
  const wgstKnots = finiteNumber(raw.wgst);
  const windGustMps =
    wgstKnots === null ? null : plausibleWindMps(wgstKnots * KNOTS_TO_MPS, 'AWC');
  const wdirDeg = finiteNumber(raw.wdir);

  const temperatureC = finiteNumber(raw.temp);
  const dewPointC = finiteNumber(raw.dewp);
  const seaLevelPressureHpa = finiteNumber(raw.slp) ?? finiteNumber(raw.altim);
  const relativeHumidityPercent = relativeHumidityFromDewPoint(temperatureC, dewPointC);

  const conditions: AirConditions = {
    ...emptyConditions(),
    dewPointC,
    relativeHumidityPercent,
    seaLevelPressureHpa:
      seaLevelPressureHpa !== null && seaLevelPressureHpa >= 300 && seaLevelPressureHpa <= 1100
        ? seaLevelPressureHpa
        : null,
  };

  const reading: Reading = {
    observedAt: new Date(observedAtMs).toISOString(),
    windAvgMps,
    windDirectionDeg:
      isCalm(windAvgMps) || wdirDeg === null ? null : normalizeDegrees(wdirDeg),
    windGustMps,
    windLullMps: null,
    temperatureC,
    windChillC: null,
    conditions,
  };

  return { station, reading };
}

export function parseAwcMetarList(text: string): AwcParsedMetar[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error('AWC METAR response must be a JSON array');
  }
  const results: AwcParsedMetar[] = [];
  for (const row of data) {
    const parsed = parseAwcMetarEntry(row);
    if (parsed) results.push(parsed);
  }
  return results;
}

export const loadAwcStation = defineStationAdapter<AwcStationConfig, AwcAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'NOAA AWC METAR'),
  load: async ({ station }, { environment, options }) => {
    const url = new URL(options.metarUrl ?? AWC_METAR_URL);
    url.searchParams.set('ids', station.nativeId);
    url.searchParams.set('format', 'json');

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `awc/metar/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `AWC METAR ${station.nativeId}`,
    });
    const parsed = parseAwcMetarList(text).find(
      entry => entry.station.nativeId === station.nativeId.toUpperCase(),
    );
    if (!parsed) {
      throw new Error(`AWC returned no METAR observation for ${station.nativeId}`);
    }
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

function formatAwcBbox(bounds: Bounds): string {
  // AWC bbox parameter uses south,west,north,east
  const [west, south, east, north] = bounds;
  return `${south},${west},${north},${east}`;
}

const coverage: Coverage = { kind: 'global' };

export const awcProvider: StationNetworkProvider = {
  vendor: 'awc',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'awc');
    const batches: CatalogueStation[][] = [seeds];
    if (options.includeRemoteDiscovery && options.bounds) {
      const environment = resolveEnvironment(options.environment);
      const url = new URL(AWC_METAR_URL);
      url.searchParams.set('bbox', formatAwcBbox(options.bounds));
      url.searchParams.set('format', 'json');
      const text = await fetchUpstreamText(environment, {
        url,
        cacheKey: `awc/bbox/${formatAwcBbox(options.bounds)}`,
        cacheTtlSeconds: 300,
        subject: 'AWC regional METAR discovery',
        limitBytes: 2 * 1024 * 1024,
      });
      batches.push(parseAwcMetarList(text).map(entry => entry.station));
    }
    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return {
      vendor: 'custom',
      id: station.uid,
      name: station.name,
      latitude: station.latitude,
      longitude: station.longitude,
      elevationM: station.elevationM,
      timeZone: station.timeZone,
      pageUrl: station.pageUrl,
      load: ({ environment, historyHours, mode }) =>
        loadAwcStation({ station }, { environment, historyHours, mode }),
    };
  },
};
