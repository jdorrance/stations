import { plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  type AirConditions,
  type Reading,
} from '@azohra/meteo.station';
import {
  type StationAdapterOptions,
  type StationConfigInput,
} from '@azohra/meteo.station/server';
import {
  defineStationAdapter,
} from './server.ts';
import { fetchUpstreamText } from '@azohra/meteo.station/server';
import type { CatalogueStation } from '@stations/contracts';
import type { Coverage } from '@stations/geography';
import {
  createSeededProvider,
  customStationConfig,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';
import { observationTimeIso } from './freeflight-observations.ts';
import { KNOTS_TO_MPS, finiteNumber, isRecord, windDirection } from './observation-values.ts';

export const WINDGURU_IAPI_URL = 'https://www.windguru.cz/int/iapi.php';
const CACHE_TTL_SECONDS = 60;

export type WindGuruStationConfig = {
  readonly station: CatalogueStation;
};

export type WindGuruAdapterOptions = StationAdapterOptions & {
  readonly iapiUrl?: string;
};

export function parseWindGuruCurrent(text: string, expectedStationId?: string): Reading {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) {
    throw new Error('WindGuru returned non-object payload');
  }
  const returnedId = data.id_station ?? data.station_id;
  if (expectedStationId && returnedId !== undefined && String(returnedId) !== expectedStationId) {
    throw new Error('WindGuru returned the wrong station');
  }
  const observedAt = observationTimeIso(data.unixtime);
  if (!observedAt) {
    throw new Error('WindGuru payload is missing unixtime');
  }

  const avgKt = finiteNumber(data.wind_avg);
  if (avgKt === null || avgKt < 0) {
    throw new Error('WindGuru payload is missing wind_avg');
  }
  const windAvgMps = plausibleWindMps(avgKt * KNOTS_TO_MPS, 'WindGuru');

  const maxKt = finiteNumber(data.wind_max);
  const minKt = finiteNumber(data.wind_min);
  const dirDeg = finiteNumber(data.wind_direction);
  const temperatureC = finiteNumber(data.temperature);
  const rh = finiteNumber(data.rh);
  const slp = finiteNumber(data.slp ?? data.mslp);

  const hasConditions = rh !== null || slp !== null;
  const conditions: AirConditions | null = hasConditions
    ? {
        ...emptyConditions(),
        relativeHumidityPercent: rh !== null && rh >= 0 && rh <= 100 ? rh : null,
        seaLevelPressureHpa: slp !== null && slp >= 300 && slp <= 1100 ? slp : null,
      }
    : null;

  return {
    observedAt,
    windAvgMps,
    windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dirDeg),
    windGustMps:
      maxKt === null || maxKt < 0 ? null : plausibleWindMps(maxKt * KNOTS_TO_MPS, 'WindGuru'),
    windLullMps:
      minKt === null || minKt < 0 ? null : plausibleWindMps(minKt * KNOTS_TO_MPS, 'WindGuru'),
    temperatureC,
    windChillC: null,
    conditions,
  };
}

export const loadWindGuruStation = defineStationAdapter<
  WindGuruStationConfig,
  WindGuruAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'WindGuru'),
  load: async ({ station }, { environment, options }) => {
    const url = new URL(options.iapiUrl ?? WINDGURU_IAPI_URL);
    url.searchParams.set('q', 'station_data_current');
    url.searchParams.set('id_station', station.nativeId);

    const text = await fetchUpstreamText(environment, {
      url,
      headers: {
        Referer: `https://www.windguru.cz/station/${encodeURIComponent(station.nativeId)}`,
      },
      cacheKey: `windguru/current/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `WindGuru station ${station.nativeId}`,
    });

    return {
      reading: parseWindGuruCurrent(text, station.nativeId),
      history: null,
    };
  },
});

export const windGuruProvider: StationNetworkProvider = createSeededProvider(
  'windguru',
  station =>
    customStationConfig(
      station,
      ({ environment, historyHours, mode }) =>
        loadWindGuruStation({ station }, { environment, historyHours, mode }),
      station.pageUrl ?? `https://www.windguru.cz/station/${station.nativeId}`,
    ),
);
