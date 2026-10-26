import {
  FEET_TO_METERS,
  MPH_TO_MPS,
  fahrenheitToCelsius,
  finiteNumber,
  isRecord,
  observationTimeMs,
  optionalWindMps,
  utcObservationTimeMs,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { plausibleWindMps } from '@azohra/meteo.core';
import {
  isCalm,
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

export const AWDB_STATIONS_URL =
  'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations';
export const AWDB_DATA_URL =
  'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/data';

const CACHE_TTL_SECONDS = 600;

export type SnotelStationConfig = {
  readonly station: CatalogueStation;
};

export type SnotelAdapterOptions = StationAdapterOptions & {
  readonly dataUrl?: string;
  readonly stationsUrl?: string;
};

export function parseSnotelStationsList(text: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error('USDA AWDB stations response must be an array');
  }
  const stations: CatalogueStation[] = [];
  for (const row of data) {
    if (!isRecord(row)) continue;
    if (typeof row.endDate === 'string' && !row.endDate.startsWith('2100')) continue;
    const triplet =
      typeof row.stationTriplet === 'string'
        ? row.stationTriplet.trim()
        : typeof row.stationId === 'string'
          ? row.stationId.trim()
          : null;
    if (!triplet) continue;

    const latitude = finiteNumber(row.latitude);
    const longitude = finiteNumber(row.longitude);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }

    const country = inferRegionCode({ latitude, longitude });
    const state =
      typeof row.stateCode === 'string'
        ? row.stateCode.trim()
        : typeof row.state === 'string'
          ? row.state.trim()
          : null;
    const elevFt = finiteNumber(row.elevation);
    const elevationM = elevFt !== null ? Math.round(elevFt * FEET_TO_METERS) : null;
    const name =
      typeof row.name === 'string' && row.name.trim() ? row.name.trim() : `SNOTEL ${triplet}`;

    stations.push({
      uid: formatStationUid('snotel', triplet),
      vendor: 'snotel',
      nativeId: triplet,
      name,
      latitude,
      longitude,
      elevationM,
      country,
      region: state,
      timeZone: null,
      pageUrl: `https://nwcc-apps.sc.egov.usda.gov/awdb/site-plots/POR/WTEQ/${encodeURIComponent(state ?? 'US')}/${encodeURIComponent(name)}.html`,
      category: 'mountain',
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: false,
        history: false,
      },
      samplingWindowSeconds: 3_600,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationTriplet: triplet,
        ...(finiteNumber(row.dataTimeZone) !== null ? { dataTimeZone: finiteNumber(row.dataTimeZone)! } : {}),
      },
    });
  }
  return stations;
}

export function parseSnotelDataResponse(text: string, dataTimeZone?: number, expectedTriplet?: string): Reading {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data) || data.length === 0) throw new Error('USDA AWDB data response is empty');
  const stationObj = expectedTriplet
    ? data.find(row => isRecord(row) && row.stationTriplet === expectedTriplet)
    : data[0];
  if (!isRecord(stationObj)) throw new Error('USDA AWDB response does not contain the requested station');
  const dataset = Array.isArray(stationObj.data) ? stationObj.data : data;
  const latestByElement = new Map<string, { value: number; ms: number; unit: string | null }>();
  for (const item of dataset) {
    if (!isRecord(item)) continue;
    const elObj = isRecord(item.stationElement) ? item.stationElement : item;
    const code = typeof elObj.elementCode === 'string' ? elObj.elementCode : null;
    if (!code || !Array.isArray(item.values)) continue;
    for (const entry of item.values) {
      if (!isRecord(entry) || typeof entry.date !== 'string') continue;
      const value = finiteNumber(entry.value);
      let ms = observationTimeMs(entry.date);
      if (!Number.isFinite(ms) && dataTimeZone !== undefined && Number.isFinite(dataTimeZone) && Math.abs(dataTimeZone) <= 14) {
        ms = utcObservationTimeMs(entry.date) - dataTimeZone * 3_600_000;
      }
      if (value === null || !Number.isFinite(ms)) continue;
      const previous = latestByElement.get(code);
      if (!previous || ms > previous.ms) latestByElement.set(code, {
        value, ms, unit: typeof elObj.storedUnitCode === 'string' ? elObj.storedUnitCode.toLowerCase() : null,
      });
    }
  }
  const speed = (entry: { value: number; unit: string | null } | undefined): number | null => {
    if (!entry) return null;
    const { value, unit } = entry;
    const mps = unit === null || unit === 'mph' ? value * MPH_TO_MPS
      : unit === 'm/s' || unit === 'mps' ? value
      : unit === 'km/h' || unit === 'kph' ? value / 3.6
      : unit === 'knots' || unit === 'kt' ? value * 0.5144444444444445 : NaN;
    return optionalWindMps(mps);
  };
  const wspd = [latestByElement.get('WSPDV'), latestByElement.get('WSPD')]
    .filter(entry => entry !== undefined && speed(entry) !== null).sort((a, b) => b!.ms - a!.ms)[0];
  const windAvgMps = speed(wspd);
  if (!wspd || windAvgMps === null) throw new Error('SNOTEL station returned no wind speed with a valid timestamp/timezone');
  const concurrent = (...codes: string[]) => codes.map(code => latestByElement.get(code)).find(entry => entry?.ms === wspd.ms);
  const gust = concurrent('WSPDX');
  const dir = concurrent('WDIRV', 'WDIR');
  const temp = concurrent('TOBS', 'TAVG');
  const temperatureC = !temp ? null : temp.unit === 'degc' || temp.unit === 'c' ? temp.value
    : temp.unit === null || temp.unit === 'degf' || temp.unit === 'f' ? fahrenheitToCelsius(temp.value) : null;
  return {
    observedAt: new Date(wspd.ms).toISOString(),
    windAvgMps,
    windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dir?.value ?? null),
    windGustMps: speed(gust),
    windLullMps: null,
    temperatureC: validTemperatureC(temperatureC),
    windChillC: null,
    conditions: null,
  };
}

export const loadSnotelStation = defineStationAdapter<
  SnotelStationConfig,
  SnotelAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'USDA SNOTEL'),
  load: async ({ station }, { environment, options }) => {
    const url = new URL(options.dataUrl ?? AWDB_DATA_URL);
    url.searchParams.set('stationTriplets', station.nativeId);
    url.searchParams.set('elements', 'WSPDV,WSPDX,WDIRV,TOBS');
    url.searchParams.set('duration', 'HOURLY');
    url.searchParams.set('beginDate', '-24');
    url.searchParams.set('endDate', '0');

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `snotel/data/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `USDA SNOTEL ${station.nativeId}`,
    });

    let dataTimeZone = finiteNumber(station.locator.dataTimeZone);
    if (dataTimeZone === null) {
      const metadataUrl = new URL(options.stationsUrl ?? AWDB_STATIONS_URL);
      metadataUrl.searchParams.set('stationTriplets', station.nativeId);
      const metadata = await fetchUpstreamText(environment, {
        url: metadataUrl, cacheKey: `snotel/metadata/${station.nativeId}`, cacheTtlSeconds: 3_600,
        subject: `USDA SNOTEL timezone ${station.nativeId}`,
      });
      const rows: unknown = JSON.parse(metadata);
      const row = Array.isArray(rows) ? rows.find(item => isRecord(item) && item.stationTriplet === station.nativeId) : null;
      dataTimeZone = isRecord(row) ? finiteNumber(row.dataTimeZone) : null;
    }
    return {
      reading: parseSnotelDataResponse(text, dataTimeZone ?? undefined, station.nativeId),
      history: null,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const snotelProvider: StationNetworkProvider = {
  vendor: 'snotel',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'snotel');
    const batches: CatalogueStation[][] = [seeds];
    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      try {
        const url = new URL(AWDB_STATIONS_URL);
        url.searchParams.set('stationTriplets', '*:*:SNTL,*:*:SCAN');
        url.searchParams.set('elements', 'WSPDV,WSPD');
        url.searchParams.set('durations', 'HOURLY');
        url.searchParams.set('activeOnly', 'true');
        const text = await fetchUpstreamText(environment, {
          url,
          cacheKey: 'snotel/stations/all',
          cacheTtlSeconds: 3_600,
          subject: 'USDA AWDB SNOTEL/SCAN stations',
          timeoutMs: 12_000,
          limitBytes: 6 * 1024 * 1024,
        });
        batches.push(parseSnotelStationsList(text));
      } catch (error) {
        logUpstreamFailure(environment, 'SNOTEL discovery failed', error);
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
      loadSnotelStation({ station }, { environment, historyHours, mode }),
    );
  },
};
