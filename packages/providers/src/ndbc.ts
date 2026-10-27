import {
  isRecentObservation,
  optionalWindMps,
  utcPartsMs,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
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

export const NDBC_LATEST_OBS_URL =
  'https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt';
export const NDBC_REALTIME2_BASE_URL =
  'https://www.ndbc.noaa.gov/data/realtime2';

const CACHE_TTL_SECONDS = 180;

export type NdbcStationConfig = {
  readonly station: CatalogueStation;
};

export type NdbcAdapterOptions = StationAdapterOptions & {
  readonly latestObsUrl?: string;
  readonly realtime2BaseUrl?: string;
};

export interface NdbcParsedRow {
  readonly station: CatalogueStation;
  readonly reading: Reading;
}

function parseNdbcNumber(token: string | undefined): number | null {
  if (!token || token === 'MM') {
    return null;
  }
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parses NOAA NDBC `latest_obs.txt` space-delimited table.
 * Columns:
 * 0:#STN 1:LAT 2:LON 3:YYYY 4:MM 5:DD 6:hh 7:mm 8:WDIR 9:WSPD 10:GST
 * 11:WVHT 12:DPD 13:APD 14:MWD 15:PRES 16:PTDY 17:ATMP 18:WTMP 19:DEWP 20:VIS 21:TIDE
 */
export function parseNdbcLatestObs(text: string): NdbcParsedRow[] {
  const results: NdbcParsedRow[] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 19) continue;

    const nativeId = cols[0]!.toUpperCase();
    const latitude = parseNdbcNumber(cols[1]);
    const longitude = parseNdbcNumber(cols[2]);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }

    const year = Number(cols[3]);
    const month = Number(cols[4]);
    const day = Number(cols[5]);
    const hour = Number(cols[6]);
    const minute = Number(cols[7]);
    const observedAtMs = utcPartsMs(year, month, day, hour, minute);
    if (!Number.isFinite(observedAtMs)) continue;

    const wspdMps = parseNdbcNumber(cols[9]);
    if (wspdMps === null || optionalWindMps(wspdMps) === null) continue;
    const windAvgMps = plausibleWindMps(wspdMps, 'NDBC');

    const gstMps = parseNdbcNumber(cols[10]);
    const windGustMps =
      optionalWindMps(gstMps);
    const wdirDeg = parseNdbcNumber(cols[8]);
    const presHpa = parseNdbcNumber(cols[15]);
    const atmpC = parseNdbcNumber(cols[17]);
    const dewpC = parseNdbcNumber(cols[19]);

    const country = inferRegionCode({ latitude, longitude });
    const station: CatalogueStation = {
      uid: formatStationUid('ndbc', nativeId),
      vendor: 'ndbc',
      nativeId,
      name: `NDBC Station ${nativeId}`,
      latitude,
      longitude,
      elevationM: null,
      country,
      region: null,
      timeZone: null,
      pageUrl: `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(nativeId)}`,
      category: 'marine',
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: true,
        history: true,
      },
      samplingWindowSeconds: 480,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationId: nativeId,
      },
    };

    const conditions: AirConditions = {
      ...emptyConditions(),
      dewPointC: validTemperatureC(dewpC),
      seaLevelPressureHpa:
        presHpa !== null && presHpa >= 300 && presHpa <= 1100 ? presHpa : null,
    };

    results.push({
      station,
      reading: {
        observedAt: new Date(observedAtMs).toISOString(),
        windAvgMps,
        windDirectionDeg:
          isCalm(windAvgMps) || wdirDeg === null ? null : windDirection(wdirDeg),
        windGustMps,
        windLullMps: null,
        temperatureC: validTemperatureC(atmpC),
        windChillC: null,
        conditions,
      },
    });
  }
  return results;
}

/**
 * Parses per-station NDBC `realtime2/{id}.txt` file for current reading + 6-hour history.
 * Columns:
 * 0:#YY 1:MM 2:DD 3:hh 4:mm 5:WDIR 6:WSPD 7:GST 8:WVHT 9:DPD 10:APD 11:MWD 12:PRES 13:ATMP 14:WTMP 15:DEWP
 */
export function parseNdbcRealtime2(
  text: string,
  historyHours = 6,
): { reading: Reading; history: History | null } {
  const lines = text.split(/\r?\n/);
  const points: HistoryPoint[] = [];
  let latestReading: Reading | null = null;
  let latestMs = -Infinity;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length < 15) continue;

    const year = Number(cols[0]);
    const month = Number(cols[1]);
    const day = Number(cols[2]);
    const hour = Number(cols[3]);
    const minute = Number(cols[4]);
    const observedAtMs = utcPartsMs(year, month, day, hour, minute);
    if (!Number.isFinite(observedAtMs)) continue;

    const wspdMps = parseNdbcNumber(cols[6]);
    if (wspdMps === null || optionalWindMps(wspdMps) === null) continue;
    const windAvgMps = plausibleWindMps(wspdMps, 'NDBC');

    const gstMps = parseNdbcNumber(cols[7]);
    const windGustMps =
      optionalWindMps(gstMps);
    const wdirDeg = parseNdbcNumber(cols[5]);
    const presHpa = parseNdbcNumber(cols[12]);
    const atmpC = parseNdbcNumber(cols[13]);
    const dewpC = parseNdbcNumber(cols[15]);

    const windDirectionDeg =
      isCalm(windAvgMps) || wdirDeg === null ? null : windDirection(wdirDeg);
    const observedAt = new Date(observedAtMs).toISOString();
    const seaLevelPressureHpa =
      presHpa !== null && presHpa >= 300 && presHpa <= 1100 ? presHpa : null;

    points.push({
      observedAt,
      windAvgMps,
      windGustMps,
      windLullMps: null,
      windDirectionDeg,
      temperatureC: validTemperatureC(atmpC),
      seaLevelPressureHpa,
    });

    if (observedAtMs > latestMs) {
      latestMs = observedAtMs;
      latestReading = {
        observedAt,
        windAvgMps,
        windDirectionDeg,
        windGustMps,
        windLullMps: null,
        temperatureC: validTemperatureC(atmpC),
        windChillC: null,
        conditions: {
          ...emptyConditions(),
          dewPointC: validTemperatureC(dewpC),
          seaLevelPressureHpa,
        },
      };
    }
  }

  if (!latestReading) {
    throw new Error('NDBC realtime2 file contained no valid wind observations');
  }

  const cutoffMs = latestMs - historyHours * 3_600_000;
  const windowed = points
    .filter(p => Date.parse(p.observedAt) >= cutoffMs)
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

  return {
    reading: latestReading,
    history: windowed.length > 1 ? { periodMinutes: 10, points: windowed } : null,
  };
}

export const loadNdbcStation = defineStationAdapter<NdbcStationConfig, NdbcAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'NOAA NDBC'),
  load: async ({ station }, { environment, historyHours, mode, options }) => {
    if (mode === 'full') {
      try {
        const base = (options.realtime2BaseUrl ?? NDBC_REALTIME2_BASE_URL).replace(/\/$/, '');
        const text = await fetchUpstreamText(environment, {
          url: `${base}/${encodeURIComponent(station.nativeId.toLowerCase())}.txt`,
          accept: 'text/plain',
          cacheKey: `ndbc/realtime2/${station.nativeId}`,
          cacheTtlSeconds: CACHE_TTL_SECONDS,
          subject: `NDBC realtime2 ${station.nativeId}`,
        });
        const parsed = parseNdbcRealtime2(text, historyHours);
        return {
          reading: parsed.reading,
          history: parsed.history,
        };
      } catch {
        // Fall through to latest_obs.txt
      }
    }

    const latestText = await fetchUpstreamText(environment, {
      url: options.latestObsUrl ?? NDBC_LATEST_OBS_URL,
      accept: 'text/plain',
      cacheKey: 'ndbc/latest_obs/all',
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: 'NDBC latest observations table',
      limitBytes: 2 * 1024 * 1024,
    });
    const match = parseNdbcLatestObs(latestText).find(
      row => row.station.nativeId === station.nativeId.toUpperCase(),
    );
    if (!match) {
      throw new Error(`NDBC station ${station.nativeId} not found in latest_obs.txt`);
    }
    return {
      reading: match.reading,
      history: null,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const ndbcProvider: StationNetworkProvider = {
  vendor: 'ndbc',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'ndbc');
    const batches: CatalogueStation[][] = [seeds];

    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      try {
        const text = await fetchUpstreamText(environment, {
          url: NDBC_LATEST_OBS_URL,
          accept: 'text/plain',
          cacheKey: 'ndbc/latest_obs/all',
          cacheTtlSeconds: 300,
          subject: 'NDBC latest observations table',
          limitBytes: 2 * 1024 * 1024,
        });
        const nowMs = environment.now().getTime();
        batches.push(
          parseNdbcLatestObs(text)
            .filter(row => isRecentObservation(row.reading.observedAt, nowMs))
            .map(row => row.station),
        );
      } catch (error) {
        logUpstreamFailure(environment, 'NDBC discovery failed', error);
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
      loadNdbcStation({ station }, { environment, historyHours, mode }),
    );
  },
};
