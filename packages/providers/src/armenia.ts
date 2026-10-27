import { plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  type AirConditions,
  type History,
  type HistoryPoint,
  type Reading,
} from '@azohra/meteo.station';
import {
  logUpstreamFailure,
  naiveLocalToIso,
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
  validPosition,
  type Coverage,
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import {
  KNOTS_TO_MPS,
  finiteNumber,
  isRecentObservation,
  isRecord,
  observationTimeMs,
  optionalWindMps,
  pressureHpa,
  relativeHumidityFromDewPoint,
  utcPartsMs,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { defineStationAdapter, resolveEnvironment } from './server.ts';
import { fetchUpstreamText } from '@azohra/meteo.station/server';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';
import {
  OGIMET_GETSYNOP_URL,
  createOgimetSynopLoader,
  createOgimetSynopProvider,
  formatOgimetBeginUtc,
  parseOgimetSynopBatch,
  parseOgimetSynopLine,
  type OgimetSynopAdapterOptions,
  type OgimetSynopStationConfig,
  type OgimetWmoStationMeta,
} from './ogimet-synop.ts';

export {
  OGIMET_GETSYNOP_URL,
  formatOgimetBeginUtc,
  parseOgimetSynopBatch,
  parseOgimetSynopLine,
};

export const CLIMATENET_LIST_URL = 'https://climatenet.am/device_inner/list/';
export const CLIMATENET_DEVICE_BASE_URL = 'https://climatenet.am/device_inner';
const CLIMATENET_CACHE_TTL_SECONDS = 300;

export type ClimateNetStationConfig = {
  readonly station: CatalogueStation;
};

export type ClimateNetAdapterOptions = StationAdapterOptions & {
  readonly deviceBaseUrl?: string;
};

const COMPASS_DEGREES: Readonly<Record<string, number>> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

function compassToDegrees(value: unknown): number | null {
  const num = finiteNumber(value);
  if (num !== null) return windDirection(num);
  if (typeof value !== 'string') return null;
  const key = value.trim().toUpperCase();
  return COMPASS_DEGREES[key] ?? null;
}

export function parseClimateNetDeviceList(text: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.devices)
      ? data.devices
      : [];
  const stations: CatalogueStation[] = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const status = typeof row.Status === 'string' ? row.Status.trim().toLowerCase() : 'online';
    if (status === 'offline' || row.Wind === 'nodata') continue;

    const idRaw = row.generated_id ?? row.id;
    if (typeof idRaw !== 'number' && typeof idRaw !== 'string') continue;
    const nativeId = String(idRaw).trim();
    if (!nativeId) continue;

    const latitude = finiteNumber(row.latitude ?? row.lat);
    const longitude = finiteNumber(row.longitude ?? row.lon);
    if (
      latitude === null ||
      longitude === null ||
      !validPosition({ latitude, longitude }) ||
      (latitude === 0 && longitude === 0)
    ) {
      continue;
    }

    const rawName =
      (typeof row.location_en === 'string' && row.location_en.trim()) ||
      (typeof row.location === 'string' && row.location.trim()) ||
      `ClimateNet ${nativeId}`;
    if (/^test$/i.test(rawName)) continue;

    const region =
      (typeof row.region_en === 'string' && row.region_en.trim()) ||
      (typeof row.region === 'string' && row.region.trim()) ||
      null;
    const alt = finiteNumber(row.altitude ?? row.elevation);
    const elevationM = alt !== null ? Math.round(alt) : null;
    const country = inferRegionCode({ latitude, longitude }, 'AM');

    stations.push({
      uid: formatStationUid('climatenet', nativeId),
      vendor: 'climatenet',
      nativeId,
      name: `${rawName} (TUMO ClimateNet)`,
      latitude,
      longitude,
      elevationM,
      country,
      region,
      timeZone: 'Asia/Yerevan',
      pageUrl: `https://climatenet.am/en/device/${encodeURIComponent(nativeId)}/`,
      category: elevationM !== null && elevationM >= 1500 ? 'mountain' : 'pws',
      capabilities: {
        gustLull: false,
        temperature: true,
        conditions: true,
        history: true,
      },
      samplingWindowSeconds: 900,
      recommendedPollSeconds: CLIMATENET_CACHE_TTL_SECONDS,
      locator: {
        generatedId: Number.isFinite(Number(nativeId)) ? Number(nativeId) : nativeId,
      },
    });
  }

  return stations;
}

export function parseClimateNetLatest(text: string, timeZone = 'Asia/Yerevan'): Reading {
  const data: unknown = JSON.parse(text);
  const first = Array.isArray(data) ? data[0] : data;
  if (!isRecord(first)) {
    throw new Error('ClimateNet latest response is empty');
  }

  const timeRaw =
    typeof first.time === 'string'
      ? first.time.trim()
      : typeof first.time_interval === 'string'
        ? first.time_interval.trim()
        : null;
  if (!timeRaw) {
    throw new Error('ClimateNet observation is missing time');
  }
  const observedAt = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timeRaw)
    ? new Date(observationTimeMs(timeRaw)).toISOString()
    : naiveLocalToIso(timeRaw.replace(' ', 'T'), timeZone);

  const speedMps = finiteNumber(first.speed ?? first.wind_speed);
  if (speedMps === null || optionalWindMps(speedMps) === null) {
    throw new Error('ClimateNet observation is missing valid wind speed');
  }
  const windAvgMps = plausibleWindMps(speedMps, 'ClimateNet');
  const dirDeg = compassToDegrees(first.direction ?? first.wind_direction);
  const temperatureC = validTemperatureC(finiteNumber(first.temperature));
  const rh = finiteNumber(first.humidity);
  const baroHpa = pressureHpa(finiteNumber(first.pressure));
  const uv = finiteNumber(first.uv);
  const rain = finiteNumber(first.rain);

  const hasConditions =
    (rh !== null && rh >= 0 && rh <= 100) ||
    baroHpa !== null ||
    (uv !== null && uv >= 0) ||
    (rain !== null && rain >= 0);

  const conditions: AirConditions | null = hasConditions
    ? {
        ...emptyConditions(),
        relativeHumidityPercent: rh !== null && rh >= 0 && rh <= 100 ? rh : null,
        seaLevelPressureHpa: baroHpa,
        uvIndex: uv !== null && uv >= 0 ? uv : null,
        precipitationTodayMm: rain !== null && rain >= 0 ? rain : null,
      }
    : null;

  return {
    observedAt,
    windAvgMps,
    windDirectionDeg: isCalm(windAvgMps) ? null : dirDeg,
    windGustMps: null,
    windLullMps: null,
    temperatureC,
    windChillC: null,
    conditions,
  };
}

export function parseClimateNetGraph(text: string, timeZone = 'Asia/Yerevan'): History | null {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data) || data.length === 0) return null;
  const points: HistoryPoint[] = [];

  for (const row of data) {
    if (!isRecord(row)) continue;
    const timeRaw =
      typeof row.time_interval === 'string'
        ? row.time_interval.trim()
        : typeof row.time === 'string'
          ? row.time.trim()
          : null;
    const speedMps = finiteNumber(row.speed ?? row.wind_speed);
    if (!timeRaw || speedMps === null || optionalWindMps(speedMps) === null) continue;
    try {
      const observedAt = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(timeRaw)
        ? new Date(observationTimeMs(timeRaw)).toISOString()
        : naiveLocalToIso(timeRaw.replace(' ', 'T'), timeZone);
      const windAvgMps = plausibleWindMps(speedMps, 'ClimateNet');
      const dirDeg = compassToDegrees(row.direction ?? row.wind_direction);
      points.push({
        observedAt,
        windAvgMps,
        windGustMps: null,
        windLullMps: null,
        windDirectionDeg: isCalm(windAvgMps) ? null : dirDeg,
        temperatureC: validTemperatureC(finiteNumber(row.temperature)),
        seaLevelPressureHpa: pressureHpa(finiteNumber(row.pressure)),
      });
    } catch {
      // Skip malformed point
    }
  }

  if (points.length < 2) return null;
  points.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return {
    periodMinutes: 15,
    points,
  };
}

export const loadClimateNetStation = defineStationAdapter<
  ClimateNetStationConfig,
  ClimateNetAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'TUMO ClimateNet Armenia'),
  load: async ({ station }, { environment, mode, options }) => {
    const base = (options.deviceBaseUrl ?? CLIMATENET_DEVICE_BASE_URL).replace(/\/$/, '');
    const id = encodeURIComponent(station.nativeId);
    const tz = station.timeZone ?? 'Asia/Yerevan';

    const latestText = await fetchUpstreamText(environment, {
      url: `${base}/${id}/latest/`,
      headers: {
        Referer: 'https://climatenet.am/en/',
      },
      cacheKey: `climatenet/latest/${station.nativeId}`,
      cacheTtlSeconds: CLIMATENET_CACHE_TTL_SECONDS,
      subject: `ClimateNet station ${station.nativeId}`,
    });
    const reading = parseClimateNetLatest(latestText, tz);

    let history: History | null = null;
    if (mode === 'full') {
      try {
        const graphText = await fetchUpstreamText(environment, {
          url: `${base}/graph/${id}/today/`,
          headers: {
            Referer: 'https://climatenet.am/en/',
          },
          cacheKey: `climatenet/graph/${station.nativeId}`,
          cacheTtlSeconds: CLIMATENET_CACHE_TTL_SECONDS,
          subject: `ClimateNet history ${station.nativeId}`,
        });
        history = parseClimateNetGraph(graphText, tz);
      } catch {
        // History is optional
      }
    }

    return {
      reading,
      history,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const climatenetProvider: StationNetworkProvider = {
  vendor: 'climatenet',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'climatenet');
    const batches: CatalogueStation[][] = [seeds];
    const regions = options.regions ?? INITIAL_SCOPE_REGIONS;

    if (options.includeRemoteDiscovery !== false && regions.includes('AM')) {
      const environment = resolveEnvironment(options.environment);
      try {
        const text = await fetchUpstreamText(environment, {
          url: CLIMATENET_LIST_URL,
          headers: {
            Referer: 'https://climatenet.am/en/',
          },
          cacheKey: 'climatenet/devices/all',
          cacheTtlSeconds: 3_600,
          subject: 'TUMO ClimateNet Armenia stations list',
        });
        const candidates = parseClimateNetDeviceList(text);
        if (candidates.length > 5) {
          const nowMs = environment.now().getTime();
          const active: CatalogueStation[] = [];
          const concurrency = 10;
          for (let index = 0; index < candidates.length; index += concurrency) {
            const slice = candidates.slice(index, index + concurrency);
            const checked = await Promise.all(
              slice.map(async candidate => {
                try {
                  const latestText = await fetchUpstreamText(environment, {
                    url: `${CLIMATENET_DEVICE_BASE_URL}/${encodeURIComponent(candidate.nativeId)}/latest/`,
                    headers: {
                      Referer: 'https://climatenet.am/en/',
                    },
                    cacheKey: `climatenet/latest/${candidate.nativeId}`,
                    cacheTtlSeconds: CLIMATENET_CACHE_TTL_SECONDS,
                    subject: `ClimateNet station ${candidate.nativeId}`,
                    timeoutMs: 5_000,
                  });
                  const reading = parseClimateNetLatest(latestText, candidate.timeZone ?? 'Asia/Yerevan');
                  return isRecentObservation(reading.observedAt, nowMs) ? candidate : null;
                } catch {
                  return null;
                }
              }),
            );
            for (const station of checked) {
              if (station) active.push(station);
            }
          }
          batches.push(active);
        } else {
          batches.push(candidates);
        }
      } catch (error) {
        logUpstreamFailure(environment, 'ClimateNet discovery failed', error);
      }
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadClimateNetStation({ station }, { environment, historyHours, mode }),
    );
  },
};

export type HydrometAmStationMeta = OgimetWmoStationMeta;
export type HydrometAmStationConfig = OgimetSynopStationConfig;
export type HydrometAmAdapterOptions = OgimetSynopAdapterOptions;

export const ARMENIA_WMO_SYNOP_STATIONS: readonly HydrometAmStationMeta[] = [
  { wmoId: '37609', name: 'Ashotsk North (Bavra)', region: 'Shirak', latitude: 41.0292, longitude: 43.8764, elevationM: 2012 },
  { wmoId: '37618', name: 'Tashir', region: 'Lori', latitude: 41.1164, longitude: 44.2789, elevationM: 1507 },
  { wmoId: '37682', name: 'Ashotsk', region: 'Shirak', latitude: 40.95, longitude: 43.7833, elevationM: 1876 },
  { wmoId: '37699', name: 'Aparan', region: 'Aragatsotn', latitude: 40.5942, longitude: 44.3636, elevationM: 1889 },
  { wmoId: '37704', name: 'Vanadzor', region: 'Lori', latitude: 40.8386, longitude: 44.4342, elevationM: 1376 },
  { wmoId: '37711', name: 'Ijevan', region: 'Tavush', latitude: 40.8714, longitude: 45.1469, elevationM: 732 },
  { wmoId: '37717', name: 'Lake Sevan (Peninsula)', region: 'Gegharkunik', latitude: 40.565, longitude: 45.0081, elevationM: 1917 },
  { wmoId: '37772', name: 'Talin', region: 'Aragatsotn', latitude: 40.3861, longitude: 43.8928, elevationM: 1637 },
  { wmoId: '37785', name: 'Ashtarak', region: 'Aragatsotn', latitude: 40.2942, longitude: 44.3425, elevationM: 1090 },
  { wmoId: '37787', name: 'Armavir', region: 'Armavir', latitude: 40.1369, longitude: 44.0472, elevationM: 861 },
  { wmoId: '37792', name: 'Hrazdan', region: 'Kotayk', latitude: 40.4925, longitude: 44.7608, elevationM: 1765 },
  { wmoId: '37801', name: 'Gavar (Kamo)', region: 'Gegharkunik', latitude: 40.3483, longitude: 45.1256, elevationM: 1960 },
  { wmoId: '37815', name: 'Masrik (Mets Mazra)', region: 'Gegharkunik', latitude: 40.2075, longitude: 45.7642, elevationM: 1939 },
  { wmoId: '37871', name: 'Artashat', region: 'Ararat', latitude: 39.9583, longitude: 44.5472, elevationM: 829 },
  { wmoId: '37880', name: 'Vorotan Pass', region: 'Syunik', latitude: 39.6928, longitude: 45.7114, elevationM: 2387 },
  { wmoId: '37882', name: 'Jermuk', region: 'Vayots Dzor', latitude: 39.8336, longitude: 45.6708, elevationM: 2064 },
  { wmoId: '37897', name: 'Sisian', region: 'Syunik', latitude: 39.52, longitude: 46.0294, elevationM: 1580 },
  { wmoId: '37953', name: 'Goris', region: 'Syunik', latitude: 39.5178, longitude: 46.3381, elevationM: 1550 },
  { wmoId: '37958', name: 'Meghri', region: 'Syunik', latitude: 38.8975, longitude: 46.2422, elevationM: 627 },
];

export const loadHydrometAmStation = createOgimetSynopLoader({
  vendor: 'hydromet_am',
  sourceLabel: 'Armenia Hydromet (WMO SYNOP)',
  cacheTtlSeconds: 900,
});

export const hydrometAmProvider = createOgimetSynopProvider({
  vendor: 'hydromet_am',
  region: 'AM',
  stateQuery: 'Arme',
  stations: ARMENIA_WMO_SYNOP_STATIONS,
  defaultTimeZone: 'Asia/Yerevan',
  sourceLabel: 'Armenia Hydromet (WMO SYNOP)',
  nameSuffix: meta => ` (ArmHydromet WMO ${meta.wmoId})`,
  cacheTtlSeconds: 900,
});
