import {
  finiteNumber,
  isRecord,
  observationTimeMs,
  optionalWindMps,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
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

export const AVALANCHE_CA_STATIONS_URL = 'https://api.avalanche.ca/weather/stations';
const CACHE_TTL_SECONDS = 300;

export type AvalancheStationConfig = {
  readonly station: CatalogueStation;
};

export type AvalancheAdapterOptions = StationAdapterOptions & {
  readonly stationsUrl?: string;
};

export function parseAvalancheCanadaStations(text: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.stations)
      ? data.stations
      : [];
  const stations: CatalogueStation[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    const idRaw = row.stationId ?? row.id;
    if (typeof idRaw !== 'number' && typeof idRaw !== 'string') continue;
    const nativeId = String(idRaw).trim();
    if (!nativeId) continue;

    const latitude = finiteNumber(row.lat ?? row.latitude);
    const longitude = finiteNumber(row.lon ?? row.lng ?? row.longitude);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }

    const country = inferRegionCode({ latitude, longitude });
    const elevationM = finiteNumber(row.elevation ?? row.altitude);
    const name =
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : `Avalanche Station ${nativeId}`;

    stations.push({
      uid: formatStationUid('avalanche', nativeId),
      vendor: 'avalanche',
      nativeId,
      name,
      latitude,
      longitude,
      elevationM,
      country,
      region: null,
      timeZone:
        typeof row.timezone === 'string' && row.timezone.trim()
          ? row.timezone.trim()
          : null,
      pageUrl: 'https://www.avalanche.ca/weather/stations',
      category: 'mountain',
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: true,
        history: true,
      },
      samplingWindowSeconds: 3_600,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationId: nativeId,
      },
    });
  }
  return stations;
}

export function parseAvalancheCanadaMeasurements(
  text: string,
): { reading: Reading; history: History | null } {
  const data: unknown = JSON.parse(text);
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.measurements)
      ? data.measurements
      : [];
  if (rows.length === 0) {
    throw new Error('Avalanche station returned no measurements');
  }

  const points: HistoryPoint[] = [];
  let latestReading: Reading | null = null;
  let latestMs = -Infinity;

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const dtRaw =
      typeof row.measurementDateTime === 'string'
        ? row.measurementDateTime
        : typeof row.dateTime === 'string'
          ? row.dateTime
          : null;
    const observedAtMs = observationTimeMs(dtRaw);
    if (!Number.isFinite(observedAtMs)) continue;

    const avgKmh = finiteNumber(row.windSpeedAvg ?? row.wind_speed);
    if (avgKmh === null || optionalWindMps(kmhToMps(avgKmh)) === null) continue;
    const windAvgMps = plausibleWindMps(kmhToMps(avgKmh), 'Avalanche.ca');

    const gustKmh = finiteNumber(row.windSpeedGust ?? row.wind_gust);
    const windGustMps =
      gustKmh === null || gustKmh < 0
        ? null
        : optionalWindMps(kmhToMps(gustKmh));
    const dirDeg = finiteNumber(row.windDirAvg ?? row.wind_direction);
    const temperatureC = finiteNumber(row.airTempAvg ?? row.temperature);
    const rh = finiteNumber(row.relativeHumidityAvg ?? row.rh);

    const windDirectionDeg =
      isCalm(windAvgMps) || dirDeg === null ? null : windDirection(dirDeg);
    const observedAt = new Date(observedAtMs).toISOString();

    points.push({
      observedAt,
      windAvgMps,
      windGustMps,
      windLullMps: null,
      windDirectionDeg,
      temperatureC: validTemperatureC(temperatureC),
    });

    if (observedAtMs > latestMs) {
      latestMs = observedAtMs;
      const conditions: AirConditions | null =
        rh !== null && rh >= 0 && rh <= 100
          ? { ...emptyConditions(), relativeHumidityPercent: rh }
          : null;
      latestReading = {
        observedAt,
        windAvgMps,
        windDirectionDeg,
        windGustMps,
        windLullMps: null,
        temperatureC: validTemperatureC(temperatureC),
        windChillC: null,
        conditions,
      };
    }
  }

  if (!latestReading) {
    throw new Error('Avalanche station had no valid wind readings');
  }
  points.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return {
    reading: latestReading,
    history: points.length > 1 ? { periodMinutes: 60, points } : null,
  };
}

export const loadAvalancheStation = defineStationAdapter<
  AvalancheStationConfig,
  AvalancheAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Avalanche Canada'),
  load: async ({ station }, { environment, options }) => {
    const base = (options.stationsUrl ?? AVALANCHE_CA_STATIONS_URL).replace(/\/$/, '');
    const text = await fetchUpstreamText(environment, {
      url: `${base}/${encodeURIComponent(station.nativeId)}`,
      cacheKey: `avalanche/station/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `Avalanche station ${station.nativeId}`,
    });
    const { reading, history } = parseAvalancheCanadaMeasurements(text);
    return {
      reading,
      history,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const avalancheProvider: StationNetworkProvider = {
  vendor: 'avalanche',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'avalanche');
    const batches: CatalogueStation[][] = [seeds];
    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      try {
        const text = await fetchUpstreamText(environment, {
          url: AVALANCHE_CA_STATIONS_URL,
          cacheKey: 'avalanche/stations/all',
          cacheTtlSeconds: 3_600,
          subject: 'Avalanche Canada weather stations',
        });
        batches.push(parseAvalancheCanadaStations(text));
      } catch (error) {
        logUpstreamFailure(environment, 'AVALANCHE discovery failed', error);
        // Fallback to seeds
      }
    }
    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadAvalancheStation({ station }, { environment, historyHours, mode }),
    );
  },
};
