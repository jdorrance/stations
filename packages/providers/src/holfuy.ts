import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  normalizeDegrees,
  unavailableStation,
  type AirConditions,
  type Reading,
  type StationTelemetry,
} from '@azohra/meteo.station';
import {
  defineStationAdapter,
  fetchUpstreamText,
  type StationAdapterOptions,
  type StationConfigInput,
} from '@azohra/meteo.station/server';
import type { CatalogueStation } from '@stations/contracts';
import type { Coverage } from '@stations/geography';
import { filterCatalogueStations, stationMetaFromCatalogue } from './azohra-vendors.ts';
import type {
  DiscoverOptions,
  ProviderCredentials,
  StationNetworkProvider,
} from './types.ts';

export const HOLFUY_LIVE_URL = 'https://api.holfuy.com/live/';
const CACHE_TTL_SECONDS = 60;

export type HolfuyStationConfig = {
  readonly station: CatalogueStation;
  readonly password?: string;
};

export type HolfuyAdapterOptions = StationAdapterOptions & {
  readonly baseUrl?: string;
};

export interface HolfuyObservation {
  readonly reading: Reading;
  readonly telemetry: StationTelemetry | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseHolfuySpeedMps(value: unknown, speedUnit: string): number | null {
  const n = finiteNumber(value);
  if (n === null) return null;
  const normalizedUnit = speedUnit.trim().toLowerCase();
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
  const isoCandidate = dateTimeRaw.includes('T')
    ? dateTimeRaw
    : `${dateTimeRaw.replace(' ', 'T')}Z`;
  const observedAtMs = Date.parse(isoCandidate);
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
        isCalm(windAvgMps) || directionRaw === null ? null : normalizeDegrees(directionRaw),
      windGustMps,
      windLullMps,
      temperatureC,
      windChillC: null,
      conditions,
    },
    telemetry,
  };
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

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `holfuy/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `Holfuy station ${station.nativeId}`,
    });
    const observation = parseHolfuyObservation(text, station.nativeId);
    return {
      reading: observation.reading,
      history: null,
      telemetry: observation.telemetry,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const holfuyProvider: StationNetworkProvider = {
  vendor: 'holfuy',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'holfuy');
    return filterCatalogueStations(seeds, options);
  },
  toStationConfig(
    station: CatalogueStation,
    credentials?: ProviderCredentials,
  ): StationConfigInput {
    const password =
      credentials?.holfuyPasswords?.[station.nativeId] ??
      credentials?.holfuyApiKey ??
      (typeof station.locator.password === 'string' ? station.locator.password : undefined);
    const requiresPassword = station.locator.requiresPassword !== false;
    if (requiresPassword && !password) {
      const meta = stationMetaFromCatalogue(station, 'Holfuy');
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
        loadHolfuyStation({ station, password }, { environment, historyHours, mode }),
    };
  },
};
