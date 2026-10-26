import {
  isRecord,
  observationTimeMs,
  optionalWindMps,
  strictNumber as finiteNumber,
  windDirection,
} from './observation-values.ts';
import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
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
  inferRegionCode,
  validPosition,
  type Coverage,
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import { US_STATE_CODES } from './iem.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

export const NWS_STATIONS_URL = 'https://api.weather.gov/stations';
const CACHE_TTL_SECONDS = 120;

export type NwsStationConfig = {
  readonly station: CatalogueStation;
};

export type NwsAdapterOptions = StationAdapterOptions & {
  readonly stationsBaseUrl?: string;
};

function parseQuantitativeValue(
  block: unknown,
): { value: number; unitCode: string } | null {
  if (!isRecord(block)) return null;
  const val = finiteNumber(block.value);
  if (val === null) return null;
  const unitCode = typeof block.unitCode === 'string' ? block.unitCode : '';
  return { value: val, unitCode };
}

function speedFromNwsQuantitative(block: unknown): number | null {
  const qv = parseQuantitativeValue(block);
  if (!qv || qv.value < 0) return null;
  const u = qv.unitCode.toLowerCase();
  const mps =
    u.includes('km_h') || u.includes('km/h')
      ? kmhToMps(qv.value)
      : u.includes('kt') || u.includes('knot')
        ? qv.value * 0.5144444444444445
        : u.includes('mi_h') || u.includes('mph')
          ? qv.value * 0.44704
          : u.includes('m_s-1') || u === 'm/s' ? qv.value : NaN;
  return optionalWindMps(mps);
}

function pressureHpaFromNwsQuantitative(block: unknown): number | null {
  const qv = parseQuantitativeValue(block);
  if (!qv || qv.value <= 0) return null;
  const unit = qv.unitCode.toLowerCase().split(':').at(-1);
  const hpa = unit === 'pa' ? qv.value / 100 : unit === 'hpa' ? qv.value : unit === 'kpa' ? qv.value * 10 : NaN;
  return hpa >= 300 && hpa <= 1100 ? hpa : null;
}

function temperatureFromNwsQuantitative(block: unknown): number | null {
  const qv = parseQuantitativeValue(block);
  if (!qv) return null;
  const unit = qv.unitCode.toLowerCase().split(':').at(-1);
  const value = unit === 'degc' ? qv.value : unit === 'degf' ? (qv.value - 32) * 5 / 9 : unit === 'k' ? qv.value - 273.15 : NaN;
  return Number.isFinite(value) && value >= -100 && value <= 70 ? Math.round(value * 10) / 10 : null;
}

export function parseNwsStationsCollection(text: string, stateHint?: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || !Array.isArray(data.features)) {
    throw new Error('NWS stations response is missing features array');
  }
  const stations: CatalogueStation[] = [];
  for (const feature of data.features) {
    if (!isRecord(feature)) continue;
    const props = isRecord(feature.properties) ? feature.properties : {};
    const geom = isRecord(feature.geometry) ? feature.geometry : null;
    const coords = geom && Array.isArray(geom.coordinates) ? geom.coordinates : null;
    if (!coords || coords.length < 2) continue;

    const longitude = finiteNumber(coords[0]);
    const latitude = finiteNumber(coords[1]);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }

    const idRaw = props.stationIdentifier;
    if (typeof idRaw !== 'string' || !idRaw.trim()) continue;
    const nativeId = idRaw.trim().toUpperCase();

    const country = inferRegionCode({ latitude, longitude }, 'US');
    const elevBlock = parseQuantitativeValue(props.elevation);
    const elevationM = elevBlock ? Math.round(elevBlock.value) : null;
    const tz =
      typeof props.timeZone === 'string' && props.timeZone.trim()
        ? props.timeZone.trim()
        : null;
    const name =
      typeof props.name === 'string' && props.name.trim()
        ? props.name.trim()
        : `NWS ${nativeId}`;

    stations.push({
      uid: formatStationUid('nws', nativeId),
      vendor: 'nws',
      nativeId,
      name,
      latitude,
      longitude,
      elevationM,
      country,
      region: stateHint ?? null,
      timeZone: tz,
      pageUrl: `https://api.weather.gov/stations/${encodeURIComponent(nativeId)}`,
      category: 'synoptic',
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: true,
        history: false,
      },
      samplingWindowSeconds: 120,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationId: nativeId,
      },
    });
  }
  return stations;
}

export function parseNwsLatestObservation(text: string): Reading {
  const data: unknown = JSON.parse(text);
  const props =
    isRecord(data) && isRecord(data.properties) ? data.properties : isRecord(data) ? data : null;
  if (!props) {
    throw new Error('NWS observation response is missing properties');
  }

  const tsRaw = observationTimeMs(props.timestamp);
  if (!Number.isFinite(tsRaw)) {
    throw new Error('NWS observation is missing valid timestamp');
  }

  const windAvgMps = speedFromNwsQuantitative(props.windSpeed);
  if (windAvgMps === null) throw new Error('NWS observation is missing valid wind speed and units');
  const windGustMps = speedFromNwsQuantitative(props.windGust);
  const dirQv = parseQuantitativeValue(props.windDirection);
  const rhQv = parseQuantitativeValue(props.relativeHumidity);
  const slpHpa =
    pressureHpaFromNwsQuantitative(props.seaLevelPressure);

  const conditions: AirConditions = {
    ...emptyConditions(),
    dewPointC: temperatureFromNwsQuantitative(props.dewpoint),
    relativeHumidityPercent:
      rhQv && rhQv.value >= 0 && rhQv.value <= 100 ? Math.round(rhQv.value) : null,
    seaLevelPressureHpa: slpHpa,
  };

  return {
    observedAt: new Date(tsRaw).toISOString(),
    windAvgMps,
    windDirectionDeg:
      isCalm(windAvgMps) || !dirQv ? null : windDirection(dirQv.value),
    windGustMps,
    windLullMps: null,
    temperatureC: temperatureFromNwsQuantitative(props.temperature),
    windChillC: temperatureFromNwsQuantitative(props.windChill),
    conditions,
  };
}

export const loadNwsStation = defineStationAdapter<NwsStationConfig, NwsAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'NOAA NWS'),
  load: async ({ station }, { environment, options }) => {
    const base = (options.stationsBaseUrl ?? NWS_STATIONS_URL).replace(/\/$/, '');
    const url = `${base}/${encodeURIComponent(station.nativeId)}/observations/latest`;

    const text = await fetchUpstreamText(environment, {
      url,
      accept: 'application/geo+json,application/json',
      cacheKey: `nws/latest/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `NWS station ${station.nativeId}`,
    });

    return {
      reading: parseNwsLatestObservation(text),
      history: null,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const nwsProvider: StationNetworkProvider = {
  vendor: 'nws',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'nws');
    const batches: CatalogueStation[][] = [seeds];
    const regions = options.regions ?? INITIAL_SCOPE_REGIONS;

    if (options.includeRemoteDiscovery !== false && regions.includes('US')) {
      const environment = resolveEnvironment(options.environment);
      const concurrency = 6;
      for (let i = 0; i < US_STATE_CODES.length; i += concurrency) {
        const slice = US_STATE_CODES.slice(i, i + concurrency);
        const stateBatches = await Promise.all(
          slice.map(async state => {
            try {
              const url = new URL(NWS_STATIONS_URL);
              url.searchParams.set('state', state);
              url.searchParams.set('limit', '500');
              const stations: CatalogueStation[] = [];
              let nextUrl: URL | null = url;
              for (let page = 0; nextUrl && page < 20; page += 1) {
                const currentUrl: URL = nextUrl;
                const text = await fetchUpstreamText(environment, {
                  url: currentUrl, accept: 'application/geo+json,application/json',
                  cacheKey: `nws/stations/${state}/${currentUrl.search}`, cacheTtlSeconds: 3_600,
                  subject: `NWS stations ${state}`, timeoutMs: 8_000, limitBytes: 4 * 1024 * 1024,
                });
                stations.push(...parseNwsStationsCollection(text, state));
                const root: unknown = JSON.parse(text);
                const pagination = isRecord(root) && isRecord(root.pagination) ? root.pagination : null;
                nextUrl = typeof pagination?.next === 'string' ? new URL(pagination.next, currentUrl) : null;
                if (nextUrl && nextUrl.origin !== url.origin) throw new Error('NWS pagination returned an unexpected origin');
              }
              if (nextUrl) logUpstreamFailure(environment, 'NWS discovery incomplete', new Error('Pagination limit reached'));
              return stations;
            } catch (error) {
              logUpstreamFailure(environment, 'NWS discovery failed', error);
              return [];
            }
          }),
        );
        for (const batch of stateBatches) batches.push(batch);
      }
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadNwsStation({ station }, { environment, historyHours, mode }),
    );
  },
};
