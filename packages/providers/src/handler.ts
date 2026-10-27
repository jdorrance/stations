import {
  fetchUpstreamText,
  type ServerEnvironment,
  type StationConfigInput,
} from '@azohra/meteo.station/server';
import {
  createStationFeedHandler,
  resolveEnvironment,
} from './server.ts';
import {
  catalogueToGeoJson,
  defaultCategoryForVendor,
  feedToGeoJson,
  isStationCategory,
  isStationVendor,
  parseStationFeedJson,
  toPublicCatalogueStation,
  type CatalogueStation,
  type StationCatalogueDocument,
  type StationCategory,
  type StationVendor,
} from '@stations/contracts';
import {
  createSpatialIndex,
  isRegionCode,
  parseBoundsParam,
  validPosition,
  type RegionCode,
  type SpatialIndex,
} from '@stations/geography';
import { resolveSynopticToken } from './cwop.ts';
import { credentialCacheScope } from './freeflight-observations.ts';
import { isRecord } from './observation-values.ts';
import { toStationConfigs } from './registry.ts';
import type { ProviderCredentials } from './types.ts';

export const DEFAULT_MAX_FEED_STATIONS = 25;

export interface StationsApiHandlerOptions {
  readonly catalogue:
    | StationCatalogueDocument
    | (() => Promise<StationCatalogueDocument> | StationCatalogueDocument);
  readonly credentials?: ProviderCredentials;
  readonly environment?: ServerEnvironment;
  readonly basePath?: string;
  readonly maxFeedStations?: number;
  readonly maxHistoryHours?: number;
  readonly corsOrigin?: string;
}

function parseNearParam(
  raw: string | null,
): { latitude: number; longitude: number; radiusKm: number } | null {
  if (!raw) return null;
  if (raw.split(',').some(part => part.trim() === '')) return null;
  const parts = raw.split(',').map(part => Number(part.trim()));
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  const [latitude, longitude, radiusKm] = parts as [number, number, number];
  if (!validPosition({ latitude, longitude }) || radiusKm <= 0) return null;
  return { latitude, longitude, radiusKm };
}

/** Absent and `1` keep history. `0` asks adapters for the current reading only. */
function parseFeedHistory(raw: string | null): boolean | 'invalid' {
  if (raw === null || raw === '1') return true;
  if (raw === '0') return false;
  return 'invalid';
}

function currentOnlyConfigs(configs: readonly StationConfigInput[]): StationConfigInput[] {
  return configs.map(config => {
    if (config.vendor !== 'custom') return config;
    const load = config.load;
    return {
      ...config,
      load: async context => {
        const station = await load({ ...context, mode: 'current' });
        if (station.status !== 'ok') return station;
        return { ...station, history: null };
      },
    };
  });
}

function parseLimitParam(raw: string | null, fallback?: number): number | undefined {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return undefined;
  return n;
}

function parseStrictCsvFilter<T extends string>(
  raw: string | null,
  guard: (item: string) => item is T,
): Set<T> | 'invalid' | null {
  if (raw === null) return null;
  const parts = raw.split(',').map(part => part.trim());
  if (parts.length === 0 || parts.some(part => part.length === 0)) {
    return 'invalid';
  }
  const out = new Set<T>();
  for (const val of parts) {
    if (guard(val)) out.add(val);
    else if (guard(val.toUpperCase())) out.add(val.toUpperCase() as T);
    else if (guard(val.toLowerCase())) out.add(val.toLowerCase() as T);
    else return 'invalid';
  }
  return out.size > 0 ? out : 'invalid';
}

const utf8Encoder = new TextEncoder();

function rawBytesResponse(
  bytes: Uint8Array,
  status: number,
  corsOrigin: string,
  isHead: boolean,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    'Access-Control-Allow-Origin': corsOrigin,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };
  return new Response(isHead ? null : (bytes as unknown as BodyInit), { status, headers });
}

function rawJsonResponse(
  jsonText: string,
  status: number,
  corsOrigin: string,
  isHead: boolean,
  extraHeaders: Record<string, string> = {},
): Response {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    'Access-Control-Allow-Origin': corsOrigin,
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  };
  return new Response(isHead ? null : jsonText, { status, headers });
}

function jsonResponse(
  body: unknown,
  status: number,
  corsOrigin: string,
  isHead: boolean,
  extraHeaders: Record<string, string> = {},
): Response {
  return rawJsonResponse(JSON.stringify(body), status, corsOrigin, isHead, extraHeaders);
}

interface CachedCatalogueIndex {
  readonly generatedAt: string;
  readonly stationsRef: readonly CatalogueStation[];
  readonly index: SpatialIndex<CatalogueStation>;
  readonly byUid: Map<string, CatalogueStation>;
  readonly publicByRef: WeakMap<CatalogueStation, CatalogueStation>;
  readonly etag: string;
  fullPublicStations?: readonly CatalogueStation[];
  fullCatalogueJsonBytes?: Uint8Array;
  fullCatalogueGeoJsonBytes?: Uint8Array;
}

async function prewarmBatchFeedCache(
  stations: readonly CatalogueStation[],
  credentials: ProviderCredentials | undefined,
  rawEnv: ServerEnvironment | undefined,
): Promise<void> {
  if (stations.length < 2) return;
  const environment = resolveEnvironment(rawEnv);

  const awcStations = stations.filter(s => s.vendor === 'awc');
  const synopticStations = stations.filter(s => s.vendor === 'synoptic');
  const tasks: Promise<void>[] = [];

  if (awcStations.length >= 2) {
    tasks.push(
      (async () => {
        const missingIds: string[] = [];
        for (const s of awcStations) {
          const cached = await environment.cache.get(`awc/metar/${s.nativeId}`);
          if (!cached) missingIds.push(s.nativeId);
        }
        if (missingIds.length < 2) return;
        try {
          const url = new URL('https://aviationweather.gov/api/data/metar');
          url.searchParams.set('ids', missingIds.join(','));
          url.searchParams.set('format', 'json');
          url.searchParams.set('hours', '3');
          const text = await fetchUpstreamText(environment, {
            url,
            cacheKey: `awc/metar/batch/${missingIds.join(',')}`,
            cacheTtlSeconds: 60,
            subject: `AWC batch METAR (${missingIds.length} stations)`,
            timeoutMs: 8_000,
          });
          const parsed: unknown = JSON.parse(text);
          if (!Array.isArray(parsed)) return;
          const byIcao = new Map<string, unknown[]>();
          for (const row of parsed) {
            if (!isRecord(row) || typeof row.icaoId !== 'string') continue;
            const id = row.icaoId.trim().toUpperCase();
            let list = byIcao.get(id);
            if (!list) {
              list = [];
              byIcao.set(id, list);
            }
            list.push(row);
          }
          await Promise.all(
            [...byIcao.entries()].map(([id, rows]) =>
              environment.cache.put(`awc/metar/${id}`, JSON.stringify(rows), 60),
            ),
          );
        } catch {
          // Fall back to individual station fetches on error
        }
      })(),
    );
  }

  const rawSynopticCred =
    credentials?.synopticToken?.trim() || credentials?.synopticApiKey?.trim();
  if (synopticStations.length >= 2 && rawSynopticCred) {
    tasks.push(
      (async () => {
        try {
          const scope = await credentialCacheScope(rawSynopticCred);
          const missingIds: string[] = [];
          for (const s of synopticStations) {
            const cached = await environment.cache.get(`synoptic/latest/${scope}/${s.nativeId}`);
            if (!cached) missingIds.push(s.nativeId);
          }
          if (missingIds.length < 2) return;
          const token = await resolveSynopticToken(rawSynopticCred, environment);
          const url = new URL('https://api.synopticdata.com/v2/stations/latest');
          url.searchParams.set('stid', missingIds.join(','));
          url.searchParams.set('units', 'metric');
          url.searchParams.set('token', token);
          const text = await fetchUpstreamText(environment, {
            url,
            cacheKey: `synoptic/latest/batch/${scope}/${missingIds.join(',')}`,
            cacheTtlSeconds: 60,
            subject: `Synoptic batch latest (${missingIds.length} stations)`,
            timeoutMs: 8_000,
          });
          const parsed: unknown = JSON.parse(text);
          const rows: unknown[] =
            isRecord(parsed) && Array.isArray(parsed.STATION) ? parsed.STATION : [];
          await Promise.all(
            rows.map(async (row: unknown) => {
              if (!isRecord(row) || typeof row.STID !== 'string') return;
              const stid = row.STID.trim().toUpperCase();
              await environment.cache.put(
                `synoptic/latest/${scope}/${stid}`,
                JSON.stringify({ STATION: [row] }),
                60,
              );
            }),
          );
        } catch {
          // Fall back to individual station fetches on error
        }
      })(),
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}

export function createStationsApiHandler(
  options: StationsApiHandlerOptions,
): (request: Request) => Promise<Response> {
  const corsOrigin = options.corsOrigin ?? '*';
  const maxFeedStations = options.maxFeedStations ?? DEFAULT_MAX_FEED_STATIONS;
  if (!Number.isSafeInteger(maxFeedStations) || maxFeedStations <= 0) {
    throw new Error('maxFeedStations must be a positive safe integer');
  }
  if (options.maxHistoryHours !== undefined &&
      (!Number.isFinite(options.maxHistoryHours) || options.maxHistoryHours <= 0)) {
    throw new Error('maxHistoryHours must be a positive finite number');
  }
  const normalizedBase = options.basePath
    ? options.basePath.endsWith('/')
      ? options.basePath.slice(0, -1)
      : options.basePath
    : null;

  let cachedIndex: CachedCatalogueIndex | null = null;

  function getIndexedCatalogue(doc: StationCatalogueDocument): CachedCatalogueIndex {
    if (
      cachedIndex &&
      cachedIndex.generatedAt === doc.generatedAt &&
      cachedIndex.stationsRef === doc.stations
    ) {
      return cachedIndex;
    }
    const index = createSpatialIndex(doc.stations, 1);
    const byUid = new Map<string, CatalogueStation>();
    for (const station of doc.stations) {
      byUid.set(station.uid, station);
      for (const alias of station.aliases ?? []) {
        if (!byUid.has(alias)) byUid.set(alias, station);
      }
    }
    cachedIndex = {
      generatedAt: doc.generatedAt,
      stationsRef: doc.stations,
      index,
      byUid,
      publicByRef: new WeakMap(),
      etag: `W/"${doc.generatedAt}-${doc.stations.length}"`,
    };
    return cachedIndex;
  }

  function toCachedPublicStation(
    indexed: CachedCatalogueIndex,
    station: CatalogueStation,
  ): CatalogueStation {
    let pub = indexed.publicByRef.get(station);
    if (!pub) {
      pub = toPublicCatalogueStation(station);
      indexed.publicByRef.set(station, pub);
    }
    return pub;
  }

  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': corsOrigin,
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'If-None-Match, Content-Type',
        },
      });
    }
    const isHead = request.method === 'HEAD';
    if (request.method !== 'GET' && !isHead) {
      return jsonResponse({ error: 'method not allowed' }, 405, corsOrigin, isHead, {
        Allow: 'GET, HEAD, OPTIONS',
      });
    }

    const url = new URL(request.url);
    const pathname =
      url.pathname.length > 1 && url.pathname.endsWith('/')
        ? url.pathname.slice(0, -1)
        : url.pathname;

    const isCatalogueRoute =
      normalizedBase !== null
        ? pathname === `${normalizedBase}/catalogue`
        : pathname.endsWith('/catalogue');

    const isFeedRoute = normalizedBase !== null
      ? pathname === `${normalizedBase}/feed`
      : pathname.endsWith('/feed');
    const isStationRoute = ['current', 'live', 'history', 'climatology'].some(route =>
      normalizedBase !== null ? pathname === `${normalizedBase}/${route}` : pathname.endsWith(`/${route}`),
    );
    if (!isCatalogueRoute && !isFeedRoute && !isStationRoute) {
      return jsonResponse({ error: 'not found' }, 404, corsOrigin, isHead);
    }

    const catalogueDoc =
      typeof options.catalogue === 'function' ? await options.catalogue() : options.catalogue;
    const indexed = getIndexedCatalogue(catalogueDoc);
    const { index, byUid } = indexed;

    const isUnfilteredCatalogueQuery =
      isCatalogueRoute &&
      !url.searchParams.has('ids') &&
      !url.searchParams.has('station') &&
      !url.searchParams.has('bbox') &&
      !url.searchParams.has('near') &&
      !url.searchParams.has('limit') &&
      !url.searchParams.has('country') &&
      !url.searchParams.has('vendor') &&
      !url.searchParams.has('category') &&
      !url.searchParams.has('launch');

    if (isUnfilteredCatalogueQuery) {
      const format = url.searchParams.get('format') ?? 'json';
      const routeEtag = format === 'geojson' ? `${indexed.etag}-geojson` : indexed.etag;
      const ifNoneMatch = request.headers.get('If-None-Match');
      if (ifNoneMatch && ifNoneMatch === routeEtag) {
        return new Response(null, {
          status: 304,
          headers: {
            ETag: routeEtag,
            'Cache-Control': 'public, max-age=300',
            'Access-Control-Allow-Origin': corsOrigin,
          },
        });
      }
      if (!indexed.fullPublicStations) {
        indexed.fullPublicStations = catalogueDoc.stations.map(s =>
          toCachedPublicStation(indexed, s),
        );
      }
      if (format === 'geojson') {
        if (!indexed.fullCatalogueGeoJsonBytes) {
          indexed.fullCatalogueGeoJsonBytes = utf8Encoder.encode(
            JSON.stringify(
              catalogueToGeoJson(indexed.fullPublicStations, catalogueDoc.generatedAt),
            ),
          );
        }
        return rawBytesResponse(
          indexed.fullCatalogueGeoJsonBytes,
          200,
          corsOrigin,
          isHead,
          { 'Cache-Control': 'public, max-age=300', ETag: routeEtag },
        );
      }
      if (!indexed.fullCatalogueJsonBytes) {
        indexed.fullCatalogueJsonBytes = utf8Encoder.encode(
          JSON.stringify({
            schemaVersion: catalogueDoc.schemaVersion,
            generatedAt: catalogueDoc.generatedAt,
            regions: catalogueDoc.regions,
            stations: indexed.fullPublicStations,
          }),
        );
      }
      return rawBytesResponse(
        indexed.fullCatalogueJsonBytes,
        200,
        corsOrigin,
        isHead,
        { 'Cache-Control': 'public, max-age=300', ETag: routeEtag },
      );
    }

    const selectStations = (defaultLimit?: number): readonly CatalogueStation[] | { error: string } => {
      const idsParam = url.searchParams.get('ids');
      const stationParam = url.searchParams.get('station');
      const bboxParam = url.searchParams.get('bbox');
      const nearParam = url.searchParams.get('near');
      const limit = parseLimitParam(url.searchParams.get('limit'), defaultLimit);
      if (url.searchParams.has('limit') && limit === undefined) {
        return { error: 'invalid limit: expected positive integer' };
      }

      const countries = parseStrictCsvFilter<RegionCode>(
        url.searchParams.get('country'),
        isRegionCode,
      );
      if (countries === 'invalid') {
        return { error: 'invalid country filter' };
      }

      const vendors = parseStrictCsvFilter<StationVendor>(
        url.searchParams.get('vendor'),
        isStationVendor,
      );
      if (vendors === 'invalid') {
        return { error: 'invalid vendor filter' };
      }

      const categories = parseStrictCsvFilter<StationCategory>(
        url.searchParams.get('category'),
        isStationCategory,
      );
      if (categories === 'invalid') {
        return { error: 'invalid category filter' };
      }

      let candidates: readonly CatalogueStation[];
      if (stationParam) {
        const hit = byUid.get(stationParam.trim());
        candidates = hit ? [hit] : [];
      } else if (idsParam !== null) {
        const seen = new Set<string>();
        const list: CatalogueStation[] = [];
        for (const rawId of idsParam.split(',')) {
          const trimmed = rawId.trim();
          if (!trimmed) continue;
          const hit = byUid.get(trimmed);
          if (hit && !seen.has(hit.uid)) {
            seen.add(hit.uid);
            list.push(hit);
          }
        }
        candidates = list;
      } else if (bboxParam !== null) {
        const bounds = parseBoundsParam(bboxParam);
        if (!bounds) return { error: 'invalid bbox: expected west,south,east,north' };
        candidates = index.queryBounds(bounds);
      } else if (nearParam !== null) {
        const near = parseNearParam(nearParam);
        if (!near) return { error: 'invalid near: expected lat,lon,radiusKm' };
        candidates = index
          .queryRadius({ latitude: near.latitude, longitude: near.longitude }, near.radiusKm)
          .map(m => m.item);
      } else {
        candidates = catalogueDoc.stations;
      }

      if (countries) {
        candidates = candidates.filter(s => s.country !== null && countries.has(s.country));
      }

      if (vendors) {
        candidates = candidates.filter(s => vendors.has(s.vendor));
      }

      if (categories) {
        candidates = candidates.filter(s =>
          categories.has(s.category ?? defaultCategoryForVendor(s.vendor)),
        );
      }

      const launchSlug = url.searchParams.get('launch');
      if (launchSlug) {
        candidates = candidates.filter(
          s => s.launchContext?.nearestLaunchSlug === launchSlug.trim(),
        );
      }

      return limit !== undefined ? candidates.slice(0, limit) : candidates;
    };

    if (isCatalogueRoute) {
      const selected = selectStations();
      if ('error' in selected) {
        return jsonResponse({ error: selected.error }, 400, corsOrigin, isHead);
      }
      const publicStations = selected.map(s => toCachedPublicStation(indexed, s));
      const format = url.searchParams.get('format') ?? 'json';
      if (format === 'geojson') {
        return jsonResponse(
          catalogueToGeoJson(publicStations, catalogueDoc.generatedAt),
          200,
          corsOrigin,
          isHead,
          { 'Cache-Control': 'public, max-age=300' },
        );
      }
      return jsonResponse(
        {
          schemaVersion: catalogueDoc.schemaVersion,
          generatedAt: catalogueDoc.generatedAt,
          regions: catalogueDoc.regions,
          stations: publicStations,
        },
        200,
        corsOrigin,
        isHead,
        { 'Cache-Control': 'public, max-age=300' },
      );
    }

    const selected = selectStations(isFeedRoute ? maxFeedStations : 1);
    if ('error' in selected) {
      return jsonResponse({ error: selected.error }, 400, corsOrigin, isHead);
    }
    const capped = isFeedRoute ? selected.slice(0, maxFeedStations) : selected.slice(0, 1);
    if (isFeedRoute && capped.length >= 2) {
      await prewarmBatchFeedCache(capped, options.credentials, options.environment);
    }
    const includeHistory = isFeedRoute ? parseFeedHistory(url.searchParams.get('history')) : true;
    if (includeHistory === 'invalid') {
      return jsonResponse({ error: 'invalid history: expected 0 or 1' }, 400, corsOrigin, isHead);
    }
    if (includeHistory === false) url.searchParams.delete('history');
    const stationConfigs = includeHistory === false
      ? currentOnlyConfigs(toStationConfigs(capped, options.credentials))
      : toStationConfigs(capped, options.credentials);

    const delegate = createStationFeedHandler({
      stations: stationConfigs,
      primaryStationId: capped[0]?.uid,
      environment: options.environment,
      basePath: normalizedBase ?? undefined,
      maxHistoryHours: options.maxHistoryHours,
      cors: corsOrigin,
    });
    // Selection resolves aliases; the delegate must receive the canonical ID too.
    const stationParam = url.searchParams.get('station');
    if (stationParam && byUid.has(stationParam.trim())) {
      url.searchParams.set('station', byUid.get(stationParam.trim())!.uid);
    }
    const geojsonFeed = isFeedRoute && url.searchParams.get('format') === 'geojson';
    const headers = new Headers(request.headers);
    // The delegate's ETag covers its JSON representation, not our GeoJSON metadata.
    if (geojsonFeed) headers.delete('If-None-Match');
    const response = await delegate(new Request(url, { method: request.method, headers, signal: request.signal }));
    if (!geojsonFeed || !response.ok) return response;
    if (isHead) {
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('ETag');
      return new Response(null, { status: response.status, headers: responseHeaders });
    }
    const feed = parseStationFeedJson(await response.text());
    if (!feed) return jsonResponse({ error: 'invalid upstream feed' }, 502, corsOrigin, false);
    return jsonResponse(feedToGeoJson(feed, byUid), 200, corsOrigin, false, {
      'Cache-Control': response.headers.get('Cache-Control') ?? 'public, max-age=30',
    });
  };
}
