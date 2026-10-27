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
import { observationTimeIso } from './freeflight-observations.ts';
import {
  KNOTS_TO_MPS,
  MAX_OBSERVATION_AGE_SECONDS,
  finiteNumber,
  isRecord,
  windDirection,
} from './observation-values.ts';

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

export function parseWindGuruStationsList(text: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error('WindGuru station_list response must be an array');
  }
  const stations: CatalogueStation[] = [];
  for (const row of data) {
    if (!isRecord(row)) continue;
    const idRaw = row.id_station ?? row.station_id ?? row.id;
    if (typeof idRaw !== 'number' && typeof idRaw !== 'string') continue;
    const nativeId = String(idRaw).trim();
    if (!nativeId) continue;

    const secondsAlive = finiteNumber(row.seconds_alive);
    if (secondsAlive === null || secondsAlive < 0 || secondsAlive > MAX_OBSERVATION_AGE_SECONDS) {
      continue;
    }

    const latitude = finiteNumber(row.lat ?? row.latitude);
    const longitude = finiteNumber(row.lon ?? row.longitude);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }

    const alt = finiteNumber(row.alt ?? row.elevation);
    const elevationM = alt !== null ? Math.round(alt) : null;
    const tz =
      typeof row.timezone === 'string' && row.timezone.trim()
        ? row.timezone.trim()
        : null;
    const spot = typeof row.spotname === 'string' ? row.spotname.trim() : '';
    const rawName = typeof row.name === 'string' ? row.name.trim() : '';
    const name =
      spot && rawName && !rawName.toLowerCase().includes(spot.toLowerCase())
        ? `${spot} - ${rawName}`
        : rawName || spot || `WindGuru ${nativeId}`;

    const countryHint =
      tz === 'Asia/Yerevan' || /\barmenia/i.test(name)
        ? 'AM'
        : tz &&
            /^America\/(?:Mexico_City|Cancun|Mazatlan|Hermosillo|Merida|Monterrey|Chihuahua|Tijuana|Bahia_Banderas)$/i.test(
              tz,
            )
          ? 'MX'
          : null;
    const country = inferRegionCode({ latitude, longitude }, countryHint);

    stations.push({
      uid: formatStationUid('windguru', nativeId),
      vendor: 'windguru',
      nativeId,
      name,
      latitude,
      longitude,
      elevationM,
      country,
      region: null,
      timeZone: tz,
      pageUrl: `https://www.windguru.cz/station/${encodeURIComponent(nativeId)}`,
      category: 'freeflight',
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: true,
        history: false,
      },
      samplingWindowSeconds: 60,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationId: nativeId,
      },
    });
  }
  return stations;
}

const coverage: Coverage = { kind: 'global' };

export const windGuruProvider: StationNetworkProvider = {
  vendor: 'windguru',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'windguru');
    const batches: CatalogueStation[][] = [seeds];
    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      try {
        const url = new URL(WINDGURU_IAPI_URL);
        url.searchParams.set('q', 'station_list');
        const text = await fetchUpstreamText(environment, {
          url,
          headers: {
            Referer: 'https://www.windguru.cz/stations',
          },
          cacheKey: 'windguru/station_list/all',
          cacheTtlSeconds: 3_600,
          subject: 'WindGuru station list',
          limitBytes: 4 * 1024 * 1024,
        });
        batches.push(parseWindGuruStationsList(text));
      } catch {
        // Fallback to seeds + winds.mobi unwrapping
      }
    }
    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(
      station,
      ({ environment, historyHours, mode }) =>
        loadWindGuruStation({ station }, { environment, historyHours, mode }),
      station.pageUrl ?? `https://www.windguru.cz/station/${station.nativeId}`,
    );
  },
};
