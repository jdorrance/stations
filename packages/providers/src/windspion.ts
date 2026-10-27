import { kmhToMps } from '@azohra/meteo.core';
import { isCalm, type Reading } from '@azohra/meteo.station';
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
  type Position,
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';
import {
  finiteNumber,
  isRecentObservation,
  isRecord,
  observationTimeMs,
  optionalWindMps,
  windDirection,
} from './observation-values.ts';

export const WINDSPION_NEAR_URL = 'https://windspion.app/dataServer/getNear.php';
const CACHE_TTL_SECONDS = 60;

export type WindSpionStationConfig = {
  readonly station: CatalogueStation;
};

export type WindSpionAdapterOptions = StationAdapterOptions & {
  readonly nearUrl?: string;
};

export interface WindSpionParsedEntry {
  readonly station: CatalogueStation;
  readonly reading: Reading | null;
}

export function parseWindSpionEntry(raw: unknown): WindSpionParsedEntry | null {
  if (!isRecord(raw)) return null;
  const idRaw = raw.id ?? raw.station_id ?? raw.sId ?? raw.code;
  if (typeof idRaw !== 'string' && typeof idRaw !== 'number') return null;
  const nativeId = String(idRaw).trim();
  if (!nativeId) return null;

  const latitude = finiteNumber(raw.lat ?? raw.latitude ?? raw.a);
  const longitude = finiteNumber(raw.lon ?? raw.lng ?? raw.longitude ?? raw.o);
  if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
    return null;
  }

  const country = inferRegionCode({ latitude, longitude });
  const name =
    (typeof raw.name === 'string' && raw.name.trim()) ||
    (typeof raw.title === 'string' && raw.title.trim()) ||
    `WindSpion ${nativeId}`;
  const elevationM = finiteNumber(raw.alt ?? raw.elevation ?? raw.h);
  const pageUrl = typeof raw.url === 'string' && raw.url.startsWith('http') ? raw.url : null;

  const station: CatalogueStation = {
    uid: formatStationUid('windspion', nativeId),
    vendor: 'windspion',
    nativeId,
    name,
    latitude,
    longitude,
    elevationM,
    country,
    region: null,
    timeZone: null,
    pageUrl,
    category: 'freeflight',
    capabilities: {
      gustLull: true,
      temperature: true,
      conditions: false,
      history: false,
    },
    samplingWindowSeconds: 300,
    recommendedPollSeconds: CACHE_TTL_SECONDS,
    locator: {
      stationId: nativeId,
    },
  };

  const tsRaw = raw.ts ?? raw.timestamp ?? raw.time ?? raw.date;
  const observedAtMs = observationTimeMs(tsRaw);

  const avgKmh = finiteNumber(raw.wind ?? raw.ws ?? raw.speed ?? raw.v);
  if (!Number.isFinite(observedAtMs) || avgKmh === null || avgKmh < 0) {
    return { station, reading: null };
  }

  const windAvgMps = optionalWindMps(kmhToMps(avgKmh));
  if (windAvgMps === null) return { station, reading: null };
  const gustKmh = finiteNumber(raw.gust ?? raw.wg ?? raw.max);
  const windGustMps =
    gustKmh === null ? null : optionalWindMps(kmhToMps(gustKmh));
  const dirDeg = finiteNumber(raw.dir ?? raw.wd ?? raw.direction ?? raw.d);
  const temperatureC = finiteNumber(raw.temp ?? raw.temperature ?? raw.t);

  return {
    station,
    reading: {
      observedAt: new Date(observedAtMs).toISOString(),
      windAvgMps,
      windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dirDeg),
      windGustMps,
      windLullMps: null,
      temperatureC,
      windChillC: null,
      conditions: null,
    },
  };
}

export function parseWindSpionList(text: string): WindSpionParsedEntry[] {
  const root: unknown = JSON.parse(text);
  const rows = Array.isArray(root)
    ? root
    : isRecord(root) && Array.isArray(root.stations)
      ? root.stations
      : isRecord(root) && Array.isArray(root.data)
        ? root.data
        : [];
  const out: WindSpionParsedEntry[] = [];
  for (const row of rows) {
    const parsed = parseWindSpionEntry(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

export const loadWindSpionStation = defineStationAdapter<
  WindSpionStationConfig,
  WindSpionAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'WindSpion'),
  load: async ({ station }, { environment, options }) => {
    const url = new URL(options.nearUrl ?? WINDSPION_NEAR_URL);
    url.searchParams.set('a', String(station.latitude));
    url.searchParams.set('o', String(station.longitude));
    url.searchParams.set('count', '25');

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `windspion/near/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `WindSpion station ${station.nativeId}`,
    });
    const list = parseWindSpionList(text);
    const match = list.find(entry => entry.station.nativeId === station.nativeId);
    if (!match || !match.reading) {
      throw new Error(`WindSpion returned no reading for ${station.nativeId}`);
    }
    return {
      reading: match.reading,
      history: null,
    };
  },
});

const REGIONAL_HUBS: readonly Position[] = [
  { latitude: 61.18, longitude: -149.65 }, // Anchorage / Chugach AK
  { latitude: 21.32, longitude: -157.67 }, // Makapuu / Oahu HI
  { latitude: 48.61, longitude: -122.43 }, // Blanchard / North Sound WA
  { latitude: 47.6, longitude: -122.1 }, // Tiger / Cascades WA
  { latitude: 47.8, longitude: -120.04 }, // Chelan / Central WA
  { latitude: 45.72, longitude: -121.65 }, // Columbia River Gorge WA/OR
  { latitude: 42.23, longitude: -123.0 }, // Woodrat / Rogue Valley OR
  { latitude: 42.56, longitude: -120.19 }, // Abert Rim / Lakeview OR
  { latitude: 49.2, longitude: -121.9 }, // BC Fraser Valley / Woodside
  { latitude: 50.32, longitude: -122.8 }, // Pemberton / Whistler BC
  { latitude: 50.25, longitude: -119.1 }, // Lumby / Okanagan BC
  { latitude: 51.3, longitude: -116.9 }, // Golden / Mount 7 / Rockies BC
  { latitude: 43.8, longitude: -113.38 }, // King Mountain / Sun Valley ID
  { latitude: 43.59, longitude: -110.83 }, // Jackson Hole / Tetons WY
  { latitude: 40.4, longitude: -111.9 }, // Point of the Mountain / Wasatch UT
  { latitude: 38.54, longitude: -112.07 }, // Monroe Peak / Cove UT
  { latitude: 39.7, longitude: -105.2 }, // Boulder / Lookout Mountain CO
  { latitude: 38.25, longitude: -105.93 }, // Villa Grove / Sangre de Cristo CO
  { latitude: 35.21, longitude: -106.45 }, // Sandia Peak NM
  { latitude: 39.31, longitude: -119.88 }, // Slide Mountain / Tahoe NV
  { latitude: 37.8, longitude: -122.4 }, // Bay Area / Funston / Diablo CA
  { latitude: 36.57, longitude: -118.06 }, // Owens Valley / Walt's Point CA
  { latitude: 34.46, longitude: -119.7 }, // Santa Barbara / Montecito CA
  { latitude: 34.2, longitude: -117.3 }, // Crestline / Marshall / SoCal CA
  { latitude: 32.89, longitude: -117.25 }, // Torrey Pines / Palomar CA
  { latitude: 38.5, longitude: -78.5 }, // Shenandoah / Massanutten VA
  { latitude: 36.3, longitude: -81.72 }, // Tater Hill / Boone NC
  { latitude: 35.35, longitude: -85.4 }, // Henson Gap / Sequatchie TN
  { latitude: 34.89, longitude: -85.46 }, // Lookout Mountain GA
  { latitude: 43.37, longitude: -72.36 }, // Morningside NH / VT
  { latitude: 45.4, longitude: -72.6 }, // Mont Yamaska / Southern QC
  { latitude: 19.2, longitude: -100.1 }, // Valle de Bravo / Peñón MX
  { latitude: 20.0, longitude: -103.7 }, // Tapalpa / Colima / Jalisco MX
  { latitude: 25.6, longitude: -100.3 }, // Monterrey / Santiago MX
  { latitude: 40.3, longitude: 44.7 }, // Hatis / Aparan / Sevan AM
  { latitude: 39.35, longitude: 46.25 }, // Tatev / Syunik AM
];

const coverage: Coverage = { kind: 'global' };

export const windSpionProvider: StationNetworkProvider = {
  vendor: 'windspion',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'windspion');
    const batches: CatalogueStation[][] = [seeds];
    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      const nowMs = environment.now().getTime();
      const concurrency = 6;
      for (let i = 0; i < REGIONAL_HUBS.length; i += concurrency) {
        const slice = REGIONAL_HUBS.slice(i, i + concurrency);
        const hubBatches = await Promise.all(
          slice.map(async hub => {
            try {
              const url = new URL(WINDSPION_NEAR_URL);
              url.searchParams.set('a', String(hub.latitude));
              url.searchParams.set('o', String(hub.longitude));
              url.searchParams.set('count', '600');
              const text = await fetchUpstreamText(environment, {
                url,
                cacheKey: `windspion/hub/${hub.latitude},${hub.longitude}`,
                cacheTtlSeconds: 600,
                subject: `WindSpion hub (${hub.latitude}, ${hub.longitude})`,
                timeoutMs: 4_000,
              });
              return parseWindSpionList(text)
                .filter(entry => entry.reading !== null && isRecentObservation(entry.reading.observedAt, nowMs))
                .map(entry => entry.station);
            } catch {
              return [];
            }
          }),
        );
        for (const batch of hubBatches) batches.push(batch);
      }
    }
    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadWindSpionStation({ station }, { environment, historyHours, mode }),
    );
  },
};
