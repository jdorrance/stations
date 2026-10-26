import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  type AirConditions,
  type Reading,
  type StationTelemetry,
} from '@azohra/meteo.station';
import {
  boundedResponseText,
  type ResolvedEnvironment,
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
import type {
  DiscoverOptions,
  ProviderCredentials,
  StationNetworkProvider,
} from './types.ts';
import { credentialCacheScope, observationTimeIso } from './freeflight-observations.ts';
import {
  finiteNumber,
  isRecord,
  utcObservationTimeMs,
  windDirection,
} from './observation-values.ts';

export const HOLFUY_LIVE_URL = 'https://api.holfuy.com/live/';
export const HOLFUY_STATIONS_LIST_URL = 'https://api.holfuy.com/stations/stations.json';
export const HOLFUY_PAGE_URL = 'https://holfuy.com/en/weather';
export const HOLFUY_WIDGET_JSON_URL = 'https://holfuy.com/puget/mjso.php';
const CACHE_TTL_SECONDS = 60;

export type HolfuyStationConfig = {
  readonly station: CatalogueStation;
  readonly password?: string;
};

export type HolfuyAdapterOptions = StationAdapterOptions & {
  readonly baseUrl?: string;
  readonly pageBaseUrl?: string;
  readonly widgetJsonUrl?: string;
};

export interface HolfuyObservation {
  readonly reading: Reading;
  readonly telemetry: StationTelemetry | null;
}

function parseHolfuySpeedMps(value: unknown, speedUnit: string): number | null {
  const n = finiteNumber(value);
  if (n === null) return null;
  const normalizedUnit = speedUnit.trim().toLowerCase();
  if (!['km/h', 'kmh', 'mph', 'knots', 'kt', 'm/s'].includes(normalizedUnit)) {
    throw new Error(`Holfuy returned unsupported wind unit: ${speedUnit}`);
  }
  const mps =
    normalizedUnit === 'km/h' || normalizedUnit === 'kmh'
      ? kmhToMps(n)
      : normalizedUnit === 'mph'
        ? n * 0.44704
        : normalizedUnit === 'knots' || normalizedUnit === 'kt'
          ? n * 0.5144444444444445
          : n;
  return plausibleWindMps(mps, 'Holfuy');
}

export function parseHolfuyObservation(text: string, expectedStationId: string): HolfuyObservation {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw new Error('Holfuy returned non-object payload');
  if (typeof data.error === 'string') {
    throw new Error(`Holfuy error: ${data.error}`);
  }
  const stationId = data.stationId !== undefined ? String(data.stationId) : null;
  if (stationId !== expectedStationId) {
    throw new Error(`Holfuy returned wrong stationId (expected ${expectedStationId})`);
  }

  const dateTimeRaw = typeof data.dateTime === 'string' ? data.dateTime.trim() : null;
  if (!dateTimeRaw) throw new Error('Holfuy payload is missing dateTime');
  const observedAtMs = utcObservationTimeMs(dateTimeRaw);
  if (!Number.isFinite(observedAtMs)) {
    throw new Error('Holfuy returned invalid dateTime');
  }

  const windBlock = isRecord(data.wind) ? data.wind : data;
  const speedUnit = typeof windBlock.unit === 'string' ? windBlock.unit : 'm/s';
  const windAvgMps = parseHolfuySpeedMps(windBlock.speed, speedUnit);
  if (windAvgMps === null) throw new Error('Holfuy payload is missing wind speed');

  const windGustMps = parseHolfuySpeedMps(windBlock.gust, speedUnit);
  const windLullMps = parseHolfuySpeedMps(windBlock.min, speedUnit);
  const directionRaw = finiteNumber(windBlock.direction);

  const temperatureC = finiteNumber(data.temperature);
  const humidity = finiteNumber(data.humidity);
  const pressure = finiteNumber(data.pressure);
  const hasConditions = humidity !== null || pressure !== null;
  const conditions: AirConditions | null = hasConditions
    ? {
        ...emptyConditions(),
        relativeHumidityPercent:
          humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
        seaLevelPressureHpa:
          pressure !== null && pressure >= 300 && pressure <= 1100 ? pressure : null,
      }
    : null;

  const battery = finiteNumber(data.battery);
  const telemetry: StationTelemetry | null =
    battery !== null && battery >= 0 && battery <= 100 ? { batteryVoltage: battery } : null;

  return {
    reading: {
      observedAt: new Date(observedAtMs).toISOString(),
      windAvgMps,
      windDirectionDeg:
        isCalm(windAvgMps) ? null : windDirection(directionRaw),
      windGustMps,
      windLullMps,
      temperatureC,
      windChillC: null,
      conditions,
    },
    telemetry,
  };
}

/**
 * Parses Holfuy's public keyless widget endpoint (`https://holfuy.com/puget/mjso.php?k={id}`).
 * Speeds from `mjso.php` default to km/h unless `su` / `unit` states otherwise.
 */
export function parseHolfuyWidgetJson(text: string, _legacyNowMs?: number): HolfuyObservation {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw new Error('Holfuy widget returned non-object payload');
  const observedAt = observationTimeIso(data.timestamp ?? data.ts ?? data.dateTime ?? data.time);
  if (!observedAt) throw new Error('Holfuy widget is missing an observation timestamp');
  const speedUnit = typeof data.su === 'string' ? data.su : typeof data.unit === 'string' ? data.unit : 'km/h';
  const windAvgMps = parseHolfuySpeedMps(data.speed ?? data.wind_speed, speedUnit);
  if (windAvgMps === null) throw new Error('Holfuy widget payload is missing speed');

  const windGustMps = parseHolfuySpeedMps(data.gust ?? data.wind_gust, speedUnit);
  const windLullMps = parseHolfuySpeedMps(data.min ?? data.lull, speedUnit);
  const dirDeg = finiteNumber(data.dir ?? data.direction);
  const temperatureC = finiteNumber(data.temperature ?? data.temp);
  const humidity = finiteNumber(data.humidity ?? data.rh);
  const pressure = finiteNumber(data.pressure ?? data.baro);

  const conditions: AirConditions | null =
    humidity !== null || pressure !== null
      ? {
          ...emptyConditions(),
          relativeHumidityPercent:
            humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
          seaLevelPressureHpa:
            pressure !== null && pressure >= 300 && pressure <= 1100 ? pressure : null,
        }
      : null;

  return {
    reading: {
      observedAt,
      windAvgMps,
      windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dirDeg),
      windGustMps,
      windLullMps,
      temperatureC,
      windChillC: null,
      conditions,
    },
    telemetry: null,
  };
}

export function parseHolfuyStationsList(text: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  const list =
    isRecord(data) && Array.isArray(data.holfuyStationsList)
      ? data.holfuyStationsList
      : Array.isArray(data)
        ? data
        : [];
  const stations: CatalogueStation[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    const idRaw = row.id ?? row.stationId;
    if (typeof idRaw !== 'number' && typeof idRaw !== 'string') continue;
    const nativeId = String(idRaw).trim();
    if (!nativeId) continue;
    const loc = isRecord(row.location) ? row.location : row;
    const latitude = finiteNumber(loc.latitude ?? loc.lat);
    const longitude = finiteNumber(loc.longitude ?? loc.lon);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }
    if (latitude === 0 && longitude === 0) continue;
    const country = inferRegionCode({ latitude, longitude });
    const elevationM = finiteNumber(loc.altitude ?? loc.elevation);
    const name =
      typeof row.name === 'string' && row.name.trim() ? row.name.trim() : `Holfuy ${nativeId}`;

    stations.push({
      uid: formatStationUid('holfuy', nativeId),
      vendor: 'holfuy',
      nativeId,
      name,
      latitude,
      longitude,
      elevationM,
      country,
      region: null,
      timeZone: null,
      pageUrl: `https://holfuy.com/en/weather/${encodeURIComponent(nativeId)}`,
      category: 'freeflight',
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: true,
        history: false,
        battery: true,
      },
      samplingWindowSeconds: 60,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationId: Number.isFinite(Number(nativeId)) ? Number(nativeId) : nativeId,
      },
    });
  }
  return stations;
}

async function fetchHolfuyKeylessWidget(
  environment: ResolvedEnvironment,
  stationId: string,
  options: HolfuyAdapterOptions,
): Promise<HolfuyObservation> {
  const cached = await environment.cache.get(`holfuy/widget/${stationId}`);
  if (cached !== null) {
    return parseHolfuyWidgetJson(cached);
  }

  const pageUrl = `${options.pageBaseUrl ?? HOLFUY_PAGE_URL}/${encodeURIComponent(stationId)}`;
  const pageRes = await environment.fetch(pageUrl, {
    headers: { 'User-Agent': environment.userAgent },
    signal: AbortSignal.timeout(4_000),
    redirect: 'error',
  });
  if (!pageRes.ok) {
    throw new Error(`Holfuy page returned ${pageRes.status}`);
  }
  const cookieHeader = pageRes.headers.get('set-cookie')?.split(';')[0] ?? '';
  try {
    await pageRes.body?.cancel();
  } catch {
    // ignore
  }

  const widgetUrl = `${options.widgetJsonUrl ?? HOLFUY_WIDGET_JSON_URL}?k=${encodeURIComponent(stationId)}`;
  const widgetRes = await environment.fetch(widgetUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': environment.userAgent,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      Referer: pageUrl,
    },
    signal: AbortSignal.timeout(4_000),
    redirect: 'error',
  });
  if (!widgetRes.ok) {
    throw new Error(`Holfuy widget endpoint returned ${widgetRes.status}`);
  }
  const text = await boundedResponseText(widgetRes, 128 * 1024, 'Holfuy widget');
  const observation = parseHolfuyWidgetJson(text);
  await environment.cache.put(`holfuy/widget/${stationId}`, text, CACHE_TTL_SECONDS);
  return observation;
}

export const loadHolfuyStation = defineStationAdapter<HolfuyStationConfig, HolfuyAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Holfuy'),
  load: async ({ station, password }, { environment, options }) => {
    const url = new URL(options.baseUrl ?? HOLFUY_LIVE_URL);
    url.searchParams.set('s', station.nativeId);
    if (password) url.searchParams.set('pw', password);
    url.searchParams.set('m', 'JSON');
    url.searchParams.set('tu', 'C');
    url.searchParams.set('su', 'm/s');
    url.searchParams.set('utc', '');
    if (station.capabilities.battery) {
      url.searchParams.set('batt', '');
    }

    try {
      const text = await fetchUpstreamText(environment, {
        url,
        cacheKey: `holfuy/${await credentialCacheScope(password)}/${station.nativeId}/${station.capabilities.battery ? 'battery' : 'basic'}`,
        cacheTtlSeconds: CACHE_TTL_SECONDS,
        subject: `Holfuy station ${station.nativeId}`,
      });
      const observation = parseHolfuyObservation(text, station.nativeId);
      return {
        reading: observation.reading,
        history: null,
        telemetry: observation.telemetry,
      };
    } catch (apiError) {
      if (password) throw apiError;
      const widgetObs = await fetchHolfuyKeylessWidget(environment, station.nativeId, options);
      return {
        reading: widgetObs.reading,
        history: null,
        telemetry: widgetObs.telemetry,
      };
    }
  },
});

const coverage: Coverage = { kind: 'global' };

export const holfuyProvider: StationNetworkProvider = {
  vendor: 'holfuy',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'holfuy');
    const batches: CatalogueStation[][] = [seeds];
    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      try {
        const text = await fetchUpstreamText(environment, {
          url: HOLFUY_STATIONS_LIST_URL,
          cacheKey: 'holfuy/stations/all',
          cacheTtlSeconds: 3_600,
          subject: 'Holfuy stations list',
          limitBytes: 2 * 1024 * 1024,
        });
        batches.push(parseHolfuyStationsList(text));
      } catch {
        // Fallback to seeds + winds.mobi unwrapping
      }
    }
    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(
    station: CatalogueStation,
    credentials?: ProviderCredentials,
  ): StationConfigInput {
    const password =
      credentials?.holfuyPasswords?.[station.nativeId] ??
      credentials?.holfuyApiKey;
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadHolfuyStation({ station, password }, { environment, historyHours, mode }),
    );
  },
};
