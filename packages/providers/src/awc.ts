import {
  KNOTS_TO_MPS,
  isRecord,
  observationTimeMs,
  optionalWindMps,
  relativeHumidityFromDewPoint,
  strictNumber as finiteNumber,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { plausibleWindMps } from '@azohra/meteo.core';
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
  coverageForRegions,
  inferRegionCode,
  validPosition,
  type Bounds,
  type Coverage,
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

export const AWC_METAR_URL = 'https://aviationweather.gov/api/data/metar';
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
    timeZone: null,
    pageUrl: `https://aviationweather.gov/data/metar/?id=${encodeURIComponent(icaoId)}`,
    place: 'airport',
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
  const reportTimeIso = observationTimeMs(raw.reportTime);
  const observedAtMs =
    obsTimeEpoch !== null
      ? observationTimeMs(obsTimeEpoch)
      : Number.isFinite(reportTimeIso)
        ? reportTimeIso
        : Number.NaN;
  if (!Number.isFinite(observedAtMs)) return null;

  const wspdKnots = finiteNumber(raw.wspd);
  if (wspdKnots === null || wspdKnots < 0 || wspdKnots * KNOTS_TO_MPS > 140) return null;
  const windAvgMps = plausibleWindMps(wspdKnots * KNOTS_TO_MPS, 'AWC');
  const wgstKnots = finiteNumber(raw.wgst);
  const windGustMps =
    optionalWindMps(wgstKnots === null ? null : wgstKnots * KNOTS_TO_MPS);
  const wdirDeg = finiteNumber(raw.wdir);

  const temperatureC = finiteNumber(raw.temp);
  const dewPointC = finiteNumber(raw.dewp);
  const seaLevelPressureHpa = finiteNumber(raw.slp);
  const relativeHumidityPercent = relativeHumidityFromDewPoint(temperatureC, dewPointC);

  const conditions: AirConditions = {
    ...emptyConditions(),
    dewPointC: validTemperatureC(dewPointC),
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
      isCalm(windAvgMps) || wdirDeg === null ? null : windDirection(wdirDeg),
    windGustMps,
    windLullMps: null,
    temperatureC: validTemperatureC(temperatureC),
    windChillC: null,
    conditions,
  };

  return { station, reading };
}

export function parseAwcMetarList(
  text: string,
  onInvalidEntry?: (error: unknown, index: number) => void,
): AwcParsedMetar[] {
  const data: unknown = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(data)) {
    throw new Error('AWC METAR response must be a JSON array');
  }
  const results: AwcParsedMetar[] = [];
  for (const [index, row] of data.entries()) {
    let parsed: AwcParsedMetar | null;
    try {
      parsed = parseAwcMetarEntry(row);
    } catch (error) {
      onInvalidEntry?.(error, index);
      continue;
    }
    if (parsed) results.push(parsed);
    else onInvalidEntry?.(new Error('AWC METAR entry is missing valid station or wind data'), index);
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
    if (options.includeRemoteDiscovery) {
      const environment = resolveEnvironment(options.environment);
      const flatten = (coverage: Coverage): Bounds[] => coverage.kind === 'bounds' ? [coverage.bounds]
        : coverage.kind === 'union' ? coverage.areas.flatMap(flatten) : [[-180, -90, 180, 90]];
      const scopes = options.bounds ? [options.bounds] : flatten(coverageForRegions(options.regions ?? INITIAL_SCOPE_REGIONS));
      const queue = scopes.flatMap(bounds => bounds[0] <= bounds[2] ? [{ bounds, depth: 0 }]
        : [{ bounds: [bounds[0], bounds[1], 180, bounds[3]] as Bounds, depth: 0 },
           { bounds: [-180, bounds[1], bounds[2], bounds[3]] as Bounds, depth: 0 }]);
      // AWC caps results at 400. Subdivide only saturated scopes, with a fixed
      // request budget and visible diagnostics if a region remains incomplete.
      for (let requests = 0; queue.length && requests < 40; requests += 1) {
        const { bounds, depth } = queue.shift()!;
        const url = new URL(AWC_METAR_URL);
        url.searchParams.set('bbox', formatAwcBbox(bounds));
        url.searchParams.set('format', 'json');
        try {
          const text = await fetchUpstreamText(environment, {
            url, cacheKey: `awc/bbox/${formatAwcBbox(bounds)}`, cacheTtlSeconds: 300,
            subject: 'AWC regional METAR discovery', limitBytes: 2 * 1024 * 1024,
          });
          const parsed = parseAwcMetarList(text, (error, index) => {
            logUpstreamFailure(environment, 'Skipped invalid AWC discovery entry', error, { index });
          });
          batches.push(parsed.map(entry => entry.station));
          const raw: unknown = text.trim() ? JSON.parse(text) : [];
          if (Array.isArray(raw) && raw.length >= 400) {
            if (depth >= 8) {
              logUpstreamFailure(environment, 'AWC discovery incomplete', new Error('Result cap reached at subdivision limit'));
              continue;
            }
            const [west, south, east, north] = bounds;
            const next: Bounds[] = east - west >= north - south
              ? [[west, south, (west + east) / 2, north], [(west + east) / 2, south, east, north]]
              : [[west, south, east, (south + north) / 2], [west, (south + north) / 2, east, north]];
            queue.push(...next.map(bounds => ({ bounds, depth: depth + 1 })));
          }
        } catch (error) {
          logUpstreamFailure(environment, 'AWC discovery failed', error);
        }
      }
      if (queue.length) logUpstreamFailure(environment, 'AWC discovery incomplete', new Error('Discovery request budget exhausted'));
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadAwcStation({ station }, { environment, historyHours, mode }),
    );
  },
};
