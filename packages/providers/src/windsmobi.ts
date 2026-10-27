import { kmhToMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  type AirConditions,
  type History,
  type HistoryPoint,
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
  regionDescriptor,
  tileBounds,
  validPosition,
  type Bounds,
  type Coverage,
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';
import {
  MAX_OBSERVATION_AGE_SECONDS,
  isRecentObservation,
  isRecord,
  observationTimeMs,
  optionalWindMps,
  strictNumber as finiteNumber,
  windDirection,
} from './observation-values.ts';

export const WINDSMOBI_STATIONS_URL = 'https://winds.mobi/api/2.3/stations/';
const CACHE_TTL_SECONDS = 60;

export type WindsMobiStationConfig = {
  readonly station: CatalogueStation;
};

export type WindsMobiAdapterOptions = StationAdapterOptions & {
  readonly baseUrl?: string;
};

export interface WindsMobiParsedEntry {
  readonly station: CatalogueStation;
  readonly reading: Reading | null;
}

function nativeAliasForWindsMobi(pvCode: string | null, pvId: string | null): string | null {
  if (!pvCode || !pvId) return null;
  const code = pvCode.trim().toLowerCase();
  const id = pvId.trim();
  if (!id) return null;
  if (code === 'holfuy') return formatStationUid('holfuy', id);
  if (code === 'pioupiou' || code === 'openwindmap') return formatStationUid('openwindmap', id);
  if (code === 'windguru' || code === 'wg') return formatStationUid('windguru', id);
  if (code === 'metar') return formatStationUid('awc', id.toUpperCase());
  if (code === 'wu' || code === 'wunderground') return formatStationUid('wunderground', id);
  return null;
}

export function parseWindsMobiMeasure(raw: unknown): Reading | null {
  if (!isRecord(raw)) return null;
  const observedAtMs = observationTimeMs(raw._id ?? raw.id);
  if (!Number.isFinite(observedAtMs)) return null;

  const avgKmh = finiteNumber(raw['w-avg']) ?? finiteNumber(raw.w_avg);
  if (avgKmh === null || avgKmh < 0) return null;
  const windAvgMps = optionalWindMps(kmhToMps(avgKmh));
  if (windAvgMps === null) return null;

  const maxKmh = finiteNumber(raw['w-max']) ?? finiteNumber(raw.w_max);
  const windGustMps =
    maxKmh === null ? null : optionalWindMps(kmhToMps(maxKmh));

  const dirDeg = finiteNumber(raw['w-dir']) ?? finiteNumber(raw.w_dir);
  const temperatureC = finiteNumber(raw.temp);
  const humidity = finiteNumber(raw.hum);
  const presObj = isRecord(raw.pres) ? raw.pres : null;
  const qnhHpa = presObj ? (finiteNumber(presObj.qnh) ?? finiteNumber(presObj.qff)) : null;

  const hasConditions = humidity !== null || qnhHpa !== null;
  const conditions: AirConditions | null = hasConditions
    ? {
        ...emptyConditions(),
        relativeHumidityPercent:
          humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
        seaLevelPressureHpa:
          qnhHpa !== null && qnhHpa >= 300 && qnhHpa <= 1100 ? qnhHpa : null,
      }
    : null;

  return {
    observedAt: new Date(observedAtMs).toISOString(),
    windAvgMps,
    windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dirDeg),
    windGustMps,
    windLullMps: null,
    temperatureC,
    windChillC: null,
    conditions,
  };
}

export function parseWindsMobiEntry(raw: unknown): WindsMobiParsedEntry | null {
  if (!isRecord(raw)) return null;
  const idRaw = typeof raw._id === 'string' ? raw._id : typeof raw.id === 'string' ? raw.id : null;
  if (!idRaw || !idRaw.trim()) return null;
  const nativeId = idRaw.trim();

  const loc = isRecord(raw.loc) ? raw.loc : null;
  const coords = loc && Array.isArray(loc.coordinates) ? loc.coordinates : null;
  if (!coords || coords.length < 2) return null;
  const longitude = finiteNumber(coords[0]);
  const latitude = finiteNumber(coords[1]);
  if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
    return null;
  }

  const country = inferRegionCode({ latitude, longitude });
  const tz =
    typeof raw.tz === 'string' && raw.tz.trim()
      ? raw.tz.trim()
      : null;

  const name =
    (typeof raw.name === 'string' && raw.name.trim()) ||
    (typeof raw.short === 'string' && raw.short.trim()) ||
    nativeId;
  const elevationM = finiteNumber(raw.alt);
  const pvCode = typeof raw['pv-code'] === 'string' ? raw['pv-code'] : null;
  const pvId =
    typeof raw['pv-id'] === 'string' || typeof raw['pv-id'] === 'number'
      ? String(raw['pv-id'])
      : null;
  const pvName = typeof raw['pv-name'] === 'string' ? raw['pv-name'] : 'winds.mobi';

  const urlObj = isRecord(raw.url) ? raw.url : null;
  const pageUrl =
    (urlObj &&
      (typeof urlObj.en === 'string'
        ? urlObj.en
        : typeof urlObj.default === 'string'
          ? urlObj.default
          : null)) ??
    `https://winds.mobi/stations/view/${encodeURIComponent(nativeId)}`;

  const nativeAlias = nativeAliasForWindsMobi(pvCode, pvId);
  const reading = isRecord(raw.last) ? parseWindsMobiMeasure(raw.last) : null;

  const station: CatalogueStation = {
    uid: formatStationUid('windsmobi', nativeId),
    vendor: 'windsmobi',
    nativeId,
    name,
    latitude,
    longitude,
    elevationM,
    country,
    region: null,
    timeZone: tz,
    pageUrl,
    category: 'freeflight',
    aliases: nativeAlias ? [nativeAlias] : null,
    capabilities: {
      gustLull: true,
      temperature: true,
      conditions: true,
      history: true,
    },
    samplingWindowSeconds: 600,
    recommendedPollSeconds: CACHE_TTL_SECONDS,
    locator: {
      windsMobiId: nativeId,
      ...(pvCode ? { pvCode } : {}),
      ...(pvId ? { pvId } : {}),
      providerName: pvName,
    },
  };

  return { station, reading };
}

export function parseWindsMobiList(text: string): WindsMobiParsedEntry[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error('Winds.mobi list response must be an array');
  }
  const results: WindsMobiParsedEntry[] = [];
  for (const row of data) {
    const parsed = parseWindsMobiEntry(row);
    if (parsed) results.push(parsed);
  }
  return results;
}

export function parseWindsMobiHistoric(text: string, periodMinutes = 10): History | null {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data) || data.length === 0) return null;
  const points: HistoryPoint[] = [];
  for (const row of data) {
    const reading = parseWindsMobiMeasure(row);
    if (!reading) continue;
    points.push({
      observedAt: reading.observedAt,
      windAvgMps: reading.windAvgMps,
      windGustMps: reading.windGustMps,
      windLullMps: reading.windLullMps,
      windDirectionDeg: reading.windDirectionDeg,
      temperatureC: reading.temperatureC,
      seaLevelPressureHpa: reading.conditions?.seaLevelPressureHpa ?? null,
    });
  }
  if (points.length === 0) return null;
  points.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return {
    periodMinutes,
    points,
  };
}

export const loadWindsMobiStation = defineStationAdapter<
  WindsMobiStationConfig,
  WindsMobiAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Winds.mobi'),
  load: async ({ station }, { environment, mode, options, historyHours }) => {
    const base = (options.baseUrl ?? WINDSMOBI_STATIONS_URL).replace(/\/$/, '');
    const stationUrl = `${base}/${encodeURIComponent(station.nativeId)}`;
    const text = await fetchUpstreamText(environment, {
      url: stationUrl,
      cacheKey: `windsmobi/station/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `Winds.mobi station ${station.nativeId}`,
    });
    const parsed = parseWindsMobiEntry(JSON.parse(text));
    if (!parsed || parsed.station.nativeId !== station.nativeId || !parsed.reading) {
      throw new Error(`Winds.mobi returned no reading for ${station.nativeId}`);
    }

    let history: History | null = null;
    if (mode === 'full') {
      try {
        const duration = Math.round(historyHours * 3600);
        if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error('Invalid history duration');
        const histText = await fetchUpstreamText(environment, {
          url: `${stationUrl}/historic/?duration=${duration}&keys=w-dir&keys=w-avg&keys=w-max&keys=temp&keys=hum&keys=pres`,
          cacheKey: `windsmobi/history/${station.nativeId}/${duration}`,
          cacheTtlSeconds: 180,
          subject: `Winds.mobi history ${station.nativeId}`,
        });
        history = parseWindsMobiHistoric(histText, 10);
      } catch {
        // History is soft
      }
    }

    return {
      reading: parsed.reading,
      history,
      meta: {
        elevationM: parsed.station.elevationM ?? station.elevationM,
        latitude: parsed.station.latitude,
        longitude: parsed.station.longitude,
      },
    };
  },
});

function buildWindsMobiBoxUrl(baseUrl: string, bounds: Bounds): URL {
  const [west, south, east, north] = bounds;
  const url = new URL(baseUrl);
  url.searchParams.set('within-pt1-lat', String(north));
  url.searchParams.set('within-pt1-lon', String(east));
  url.searchParams.set('within-pt2-lat', String(south));
  url.searchParams.set('within-pt2-lon', String(west));
  url.searchParams.set('last-measure', String(MAX_OBSERVATION_AGE_SECONDS));
  url.searchParams.set('limit', '500');
  for (const key of [
    'short',
    'name',
    'loc',
    'status',
    'pv-code',
    'pv-id',
    'pv-name',
    'alt',
    'peak',
    'tz',
    'url',
    'last._id',
    'last.w-dir',
    'last.w-avg',
    'last.w-max',
    'last.temp',
  ]) {
    url.searchParams.append('keys', key);
  }
  return url;
}

const coverage: Coverage = { kind: 'global' };

export const windsMobiProvider: StationNetworkProvider = {
  vendor: 'windsmobi',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'windsmobi');
    const batches: CatalogueStation[][] = [seeds];

    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      const regions = options.regions ?? INITIAL_SCOPE_REGIONS;
      const envelopes: Bounds[] = options.bounds
        ? [options.bounds]
        : regions.flatMap(code => {
            const env = regionDescriptor(code).envelope;
            return tileBounds(env, 12, 18);
          });

      const nowMs = environment.now().getTime();
      const queue: { bounds: Bounds; depth: number }[] = envelopes.map(bounds => ({
        bounds,
        depth: 0,
      }));

      const concurrency = 6;
      let requests = 0;
      while (queue.length > 0 && requests < 60) {
        const slice = queue.splice(0, Math.min(concurrency, 60 - requests));
        requests += slice.length;
        const tileBatches = await Promise.all(
          slice.map(async ({ bounds: box, depth }) => {
            try {
              const url = buildWindsMobiBoxUrl(WINDSMOBI_STATIONS_URL, box);
              const text = await fetchUpstreamText(environment, {
                url,
                cacheKey: `windsmobi/bbox/${box.join(',')}`,
                cacheTtlSeconds: 600,
                subject: `Winds.mobi bbox [${box.join(', ')}]`,
                limitBytes: 2 * 1024 * 1024,
              });
              const parsed = parseWindsMobiList(text);
              const active = parsed.filter(
                entry =>
                  entry.reading !== null &&
                  isRecentObservation(entry.reading.observedAt, nowMs),
              );
              if (parsed.length >= 500 && depth < 3) {
                const [west, south, east, north] = box;
                const midLon = (west + east) / 2;
                const midLat = (south + north) / 2;
                queue.push(
                  { bounds: [west, south, midLon, midLat], depth: depth + 1 },
                  { bounds: [midLon, south, east, midLat], depth: depth + 1 },
                  { bounds: [west, midLat, midLon, north], depth: depth + 1 },
                  { bounds: [midLon, midLat, east, north], depth: depth + 1 },
                );
              }
              return active.map(entry => entry.station);
            } catch {
              return [];
            }
          }),
        );
        for (const batch of tileBatches) batches.push(batch);
      }
      for (const providerCode of ['holfuy', 'pioupiou']) {
        try {
          const url = new URL(WINDSMOBI_STATIONS_URL);
          url.searchParams.set('provider', providerCode);
          url.searchParams.set('last-measure', String(MAX_OBSERVATION_AGE_SECONDS));
          for (const key of [
            'short',
            'name',
            'loc',
            'status',
            'pv-code',
            'pv-id',
            'pv-name',
            'alt',
            'peak',
            'tz',
            'url',
            'last._id',
            'last.w-dir',
            'last.w-avg',
            'last.w-max',
            'last.temp',
          ]) {
            url.searchParams.append('keys', key);
          }
          const text = await fetchUpstreamText(environment, {
            url,
            cacheKey: `windsmobi/provider/${providerCode}`,
            cacheTtlSeconds: 600,
            subject: `Winds.mobi provider ${providerCode}`,
            limitBytes: 2 * 1024 * 1024,
          });
          const parsed = parseWindsMobiList(text).filter(
            entry =>
              entry.reading !== null &&
              isRecentObservation(entry.reading.observedAt, nowMs),
          );
          batches.push(parsed.map(entry => entry.station));
        } catch {
          // Best-effort provider sweep
        }
      }
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadWindsMobiStation({ station }, { environment, historyHours, mode }),
    );
  },
};
