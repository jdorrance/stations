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
  utcPartsMs,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { defineStationAdapter, resolveEnvironment } from './server.ts';
import { fetchUpstreamText } from '@azohra/meteo.station/server';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

export const CLIMATENET_LIST_URL = 'https://climatenet.am/device_inner/list/';
export const CLIMATENET_DEVICE_BASE_URL = 'https://climatenet.am/device_inner';
export const OGIMET_GETSYNOP_URL = 'https://www.ogimet.com/cgi-bin/getsynop';

const CLIMATENET_CACHE_TTL_SECONDS = 300;
const HYDROMET_CACHE_TTL_SECONDS = 900;

export type ClimateNetStationConfig = {
  readonly station: CatalogueStation;
};

export type ClimateNetAdapterOptions = StationAdapterOptions & {
  readonly deviceBaseUrl?: string;
};

export type HydrometAmStationConfig = {
  readonly station: CatalogueStation;
};

export type HydrometAmAdapterOptions = StationAdapterOptions & {
  readonly getsynopUrl?: string;
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
                  const res = await fetch(
                    `${CLIMATENET_DEVICE_BASE_URL}/${encodeURIComponent(candidate.nativeId)}/latest/`,
                    {
                      headers: {
                        Referer: 'https://climatenet.am/en/',
                        'User-Agent': environment.userAgent,
                      },
                      signal: AbortSignal.timeout(5_000),
                    },
                  );
                  if (!res.ok) return null;
                  const latestText = await res.text();
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

export interface HydrometAmStationMeta {
  readonly wmoId: string;
  readonly name: string;
  readonly region: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly elevationM: number;
}

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

function catalogueStationFromWmoMeta(meta: HydrometAmStationMeta): CatalogueStation {
  return {
    uid: formatStationUid('hydromet_am', meta.wmoId),
    vendor: 'hydromet_am',
    nativeId: meta.wmoId,
    name: `${meta.name} (ArmHydromet WMO ${meta.wmoId})`,
    latitude: meta.latitude,
    longitude: meta.longitude,
    elevationM: meta.elevationM,
    country: 'AM',
    region: meta.region,
    timeZone: 'Asia/Yerevan',
    pageUrl: `https://www.ogimet.com/cgi-bin/gsynres?lang=en&ind=${encodeURIComponent(meta.wmoId)}&decoded=yes&ndays=2`,
    category: meta.elevationM >= 1600 ? 'mountain' : 'synoptic',
    capabilities: {
      gustLull: true,
      temperature: true,
      conditions: true,
      history: true,
    },
    samplingWindowSeconds: 600,
    recommendedPollSeconds: HYDROMET_CACHE_TTL_SECONDS,
    locator: {
      wmoId: meta.wmoId,
    },
  };
}

function relativeHumidityFromDewPoint(tempC: number | null, dewPointC: number | null): number | null {
  if (tempC === null || dewPointC === null) return null;
  const a = 17.625;
  const b = 243.04;
  const gammaT = (a * tempC) / (b + tempC);
  const gammaD = (a * dewPointC) / (b + dewPointC);
  const rh = 100 * Math.exp(gammaD - gammaT);
  return Math.min(100, Math.max(0, Math.round(rh)));
}

/**
 * Parses a single Ogimet WMO FM-12 SYNOP CSV line:
 * Example: `37699,2026,10,26,12,00,AAXX 26121 37699 32698 51301 10118 20060 38154 48542 57004 85200=`
 */
export function parseOgimetSynopLine(
  line: string,
): { wmoId: string; reading: Reading } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(
    /^(\d{5}),(\d{4}),(\d{2}),(\d{2}),(\d{2}),(\d{2}),AAXX\s+(\d{2})(\d{2})([0134/])\s+(\d{5})\s+([^\s=]+)\s+([^\s=]+)(.*)$/,
  );
  if (!match) return null;

  const [, csvWmoId, yearStr, monthStr, dayStr, hourStr, minStr, , , iwChar, bodyWmoId, , nddffGroup, rest = ''] = match;
  if (csvWmoId !== bodyWmoId) return null;
  const observedAtMs = utcPartsMs(
    Number(yearStr),
    Number(monthStr),
    Number(dayStr),
    Number(hourStr),
    Number(minStr),
  );
  if (!Number.isFinite(observedAtMs)) return null;

  if (!/^[0-9/](\d{2})(\d{2})$/.test(nddffGroup!)) return null;
  const ddRaw = Number(nddffGroup!.slice(1, 3));
  const ffRaw = Number(nddffGroup!.slice(3, 5));
  if (!Number.isFinite(ddRaw) || !Number.isFinite(ffRaw)) return null;

  const isKnots = iwChar === '3' || iwChar === '4';
  const rawMps = isKnots ? ffRaw * KNOTS_TO_MPS : ffRaw;
  if (optionalWindMps(rawMps) === null) return null;
  const windAvgMps = plausibleWindMps(rawMps, 'WMO SYNOP');
  const dirDeg =
    isCalm(windAvgMps) || ddRaw === 0 || ddRaw === 99 || ddRaw > 36
      ? null
      : windDirection(ddRaw * 10);

  const tokens = rest.replace(/=+$/, '').trim().split(/\s+/).filter(Boolean);
  let section = 1;
  let temperatureC: number | null = null;
  let dewPointC: number | null = null;
  let seaLevelPressureHpa: number | null = null;
  let windGustMps: number | null = null;

  for (const token of tokens) {
    if (token === '333') {
      section = 3;
      continue;
    }
    if (token === '555') {
      section = 5;
      continue;
    }
    if (section === 1) {
      if (/^1([01])(\d{3})$/.test(token)) {
        const sign = token[1] === '1' ? -1 : 1;
        temperatureC = validTemperatureC((sign * Number(token.slice(2))) / 10);
      } else if (/^2([01])(\d{3})$/.test(token)) {
        const sign = token[1] === '1' ? -1 : 1;
        dewPointC = validTemperatureC((sign * Number(token.slice(2))) / 10);
      } else if (/^4([09]\d{3})$/.test(token)) {
        const pVal = Number(token.slice(1));
        const hpa = pVal < 5000 ? 1000 + pVal / 10 : 900 + (pVal - 9000) / 10;
        seaLevelPressureHpa = pressureHpa(Math.round(hpa * 10) / 10);
      }
    } else if (section === 3) {
      if (/^91[01](\d{2})$/.test(token)) {
        const gustVal = Number(token.slice(3));
        const gustMps = isKnots ? gustVal * KNOTS_TO_MPS : gustVal;
        windGustMps = optionalWindMps(gustMps);
      }
    }
  }

  const relativeHumidityPercent = relativeHumidityFromDewPoint(temperatureC, dewPointC);
  const hasConditions =
    dewPointC !== null || relativeHumidityPercent !== null || seaLevelPressureHpa !== null;
  const conditions: AirConditions | null = hasConditions
    ? {
        ...emptyConditions(),
        dewPointC,
        relativeHumidityPercent,
        seaLevelPressureHpa,
      }
    : null;

  return {
    wmoId: csvWmoId!,
    reading: {
      observedAt: new Date(observedAtMs).toISOString(),
      windAvgMps,
      windDirectionDeg: dirDeg,
      windGustMps,
      windLullMps: null,
      temperatureC,
      windChillC: null,
      conditions,
    },
  };
}

export function parseOgimetSynopBatch(
  text: string,
  expectedWmoId?: string,
): { reading: Reading; history: History | null } {
  const lines = text.trim().split(/\r?\n/);
  const points: HistoryPoint[] = [];
  let latestReading: Reading | null = null;
  let latestMs = -Infinity;

  for (const line of lines) {
    const parsed = parseOgimetSynopLine(line);
    if (!parsed) continue;
    if (expectedWmoId && parsed.wmoId !== expectedWmoId) continue;
    const ms = Date.parse(parsed.reading.observedAt);
    if (!Number.isFinite(ms)) continue;

    points.push({
      observedAt: parsed.reading.observedAt,
      windAvgMps: parsed.reading.windAvgMps,
      windGustMps: parsed.reading.windGustMps,
      windLullMps: null,
      windDirectionDeg: parsed.reading.windDirectionDeg,
      temperatureC: parsed.reading.temperatureC,
      seaLevelPressureHpa: parsed.reading.conditions?.seaLevelPressureHpa ?? null,
    });

    if (ms >= latestMs) {
      latestMs = ms;
      latestReading = parsed.reading;
    }
  }

  if (!latestReading) {
    throw new Error(`No valid SYNOP observations found${expectedWmoId ? ` for ${expectedWmoId}` : ''}`);
  }
  points.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return {
    reading: latestReading,
    history: points.length > 1 ? { periodMinutes: 180, points } : null,
  };
}

function formatOgimetBeginUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}0000`;
}

export const loadHydrometAmStation = defineStationAdapter<
  HydrometAmStationConfig,
  HydrometAmAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Armenia Hydromet (WMO SYNOP)'),
  load: async ({ station }, { environment, options }) => {
    const url = new URL(options.getsynopUrl ?? OGIMET_GETSYNOP_URL);
    url.searchParams.set('block', station.nativeId);
    url.searchParams.set('begin', formatOgimetBeginUtc(environment.now().getTime() - 48 * 3_600_000));

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `hydromet_am/synop/${station.nativeId}`,
      cacheTtlSeconds: HYDROMET_CACHE_TTL_SECONDS,
      subject: `Armenia Hydromet SYNOP ${station.nativeId}`,
    });

    const { reading, history } = parseOgimetSynopBatch(text, station.nativeId);
    return {
      reading,
      history,
    };
  },
});

export const hydrometAmProvider: StationNetworkProvider = {
  vendor: 'hydromet_am',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'hydromet_am');
    const batches: CatalogueStation[][] = [seeds];
    const regions = options.regions ?? INITIAL_SCOPE_REGIONS;

    if (options.includeRemoteDiscovery !== false && regions.includes('AM')) {
      const environment = resolveEnvironment(options.environment);
      const nowMs = environment.now().getTime();
      try {
        const url = new URL(OGIMET_GETSYNOP_URL);
        url.searchParams.set('state', 'Arme');
        url.searchParams.set('begin', formatOgimetBeginUtc(nowMs - 72 * 3_600_000));

        const text = await fetchUpstreamText(environment, {
          url,
          cacheKey: 'hydromet_am/synop/state/Arme',
          cacheTtlSeconds: 1_800,
          subject: 'Armenia Hydromet WMO SYNOP state batch',
        });

        const latestByWmo = new Map<string, string>();
        for (const line of text.trim().split(/\r?\n/)) {
          const parsed = parseOgimetSynopLine(line);
          if (!parsed) continue;
          const prev = latestByWmo.get(parsed.wmoId);
          if (!prev || Date.parse(parsed.reading.observedAt) >= Date.parse(prev)) {
            latestByWmo.set(parsed.wmoId, parsed.reading.observedAt);
          }
        }

        const activeStations = ARMENIA_WMO_SYNOP_STATIONS.filter(meta => {
          const latestIso = latestByWmo.get(meta.wmoId);
          return latestIso !== undefined && isRecentObservation(latestIso, nowMs);
        }).map(catalogueStationFromWmoMeta);

        batches.push(activeStations);
      } catch (error) {
        logUpstreamFailure(environment, 'HYDROMET_AM discovery failed', error);
      }
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadHydrometAmStation({ station }, { environment, historyHours, mode }),
    );
  },
};
