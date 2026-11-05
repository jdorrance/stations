import {
  loadStationCurrent,
  loadStationFeed,
  type ServerEnvironment,
} from '@azohra/meteo.station/server';
import {
  createStationFeedHandler,
  createRequestEnvironment,
} from './server.ts';
import {
  catalogueToGeoJson,
  defaultCategoryForVendor,
  defaultPlaceForStation,
  feedToGeoJson,
  isStationCategory,
  isLandform,
  isStationPlace,
  isStationVendor,
  LIVE_CATALOGUE_PROFILE,
  parseStationFeedJson,
  toPublicCatalogueStation,
  type CatalogueStation,
  type StationCatalogueDocument,
  type StationCategory,
  type Landform,
  type StationPlace,
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
import { cacheIdentity } from './freeflight-observations.ts';
import { prewarmBatchFeedCache } from './batch.ts';
import { createStationCache, type StationCachePolicy, type StationCacheResult, type StationRequestContext } from './station-cache.ts';
import { toLiveCatalogueDocument } from './live-catalogue.ts';
import { toStationConfigs } from './registry.ts';
import type { ProviderCredentials } from './types.ts';

export type { StationCachePolicy, StationRequestContext } from './station-cache.ts';

export const DEFAULT_MAX_FEED_STATIONS = 25;

export interface StationsApiHandlerOptions {
  readonly catalogue:
    | StationCatalogueDocument
    | ((context?: StationRequestContext) => Promise<StationCatalogueDocument> | StationCatalogueDocument);
  readonly credentials?: ProviderCredentials;
  readonly environment?: ServerEnvironment;
  readonly basePath?: string;
  readonly maxFeedStations?: number;
  readonly maxHistoryHours?: number;
  readonly corsOrigin?: string;
  readonly cachePolicy?: StationCachePolicy;
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
  liveCatalogueBytes?: Uint8Array;
  /** Lean-index cache for the same revision, so a `profile=live` request does not evict the full index. */
  live?: CachedCatalogueIndex;
  /** Lean projection memoized for the same revision. */
  liveDocument?: StationCatalogueDocument;
}

export function createStationsApiHandler(
  options: StationsApiHandlerOptions,
): (request: Request, context?: StationRequestContext) => Promise<Response> {
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
  const stationCache = createStationCache(options.environment, options.cachePolicy);
  const cacheScope = cacheIdentity(JSON.stringify([options.credentials ?? {}, options.cachePolicy ?? {}]));
  const stationKeys = new WeakMap<CatalogueStation, Promise<string>>();

  /**
   * Resolves the index for the request's catalogue revision. `profile=live`
   * shares the revision's `cachedIndex` and memoizes its lean projection and
   * index on that base, so a live request neither evicts the full catalogue's
   * index nor rebuilds the lean one on every call.
   */
  function getRequestCatalogue(
    doc: StationCatalogueDocument,
    liveOnly: boolean,
  ): { indexed: CachedCatalogueIndex; liveDocument: StationCatalogueDocument | null } {
    const base = getIndexedCatalogue(doc);
    if (!liveOnly) return { indexed: base, liveDocument: null };
    const liveDocument = base.liveDocument ?? toLiveCatalogueDocument(doc);
    base.liveDocument = liveDocument;
    base.live ??= buildIndexedCatalogue(liveDocument);
    base.live.liveDocument = liveDocument;
    return { indexed: base.live, liveDocument };
  }

  /** Builds a spatial index and UID map without touching the request cache slot. */
  function buildIndexedCatalogue(doc: StationCatalogueDocument): CachedCatalogueIndex {
    const index = createSpatialIndex(doc.stations, 1);
    const byUid = new Map<string, CatalogueStation>();
    for (const station of doc.stations) {
      byUid.set(station.uid, station);
      for (const alias of station.aliases ?? []) {
        if (!byUid.has(alias)) byUid.set(alias, station);
      }
    }
    return {
      generatedAt: doc.generatedAt,
      stationsRef: doc.stations,
      index,
      byUid,
      publicByRef: new WeakMap(),
      etag: `W/"${doc.generatedAt}-${doc.stations.length}"`,
    };
  }

  function getIndexedCatalogue(doc: StationCatalogueDocument): CachedCatalogueIndex {
    if (
      cachedIndex &&
      cachedIndex.generatedAt === doc.generatedAt &&
      cachedIndex.stationsRef === doc.stations
    ) {
      return cachedIndex;
    }
    cachedIndex = buildIndexedCatalogue(doc);
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

  return async (request: Request, context: StationRequestContext = {}): Promise<Response> => {
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
      typeof options.catalogue === 'function' ? await options.catalogue(context) : options.catalogue;

    // `profile` is not a filter: an unknown value fails closed rather than
    // silently returning the full public catalogue.
    const profileParam = isCatalogueRoute ? url.searchParams.get('profile') : null;
    if (profileParam !== null && profileParam !== LIVE_CATALOGUE_PROFILE) {
      return jsonResponse(
        { error: 'invalid profile: expected live' },
        400,
        corsOrigin,
        isHead,
      );
    }
    const liveOnly = isCatalogueRoute && profileParam === LIVE_CATALOGUE_PROFILE;
    // A filtered (or GeoJSON) `profile=live` query still answers over the live
    // station set, memoized on the catalogue revision so it neither evicts the
    // full index nor rebuilds the lean projection per request.
    const { indexed, liveDocument } = getRequestCatalogue(catalogueDoc, liveOnly);
    const { index, byUid } = indexed;

    // Filtering params travel separately so the lean profile can share the
    // predicate: filters with `profile=live` stay filtered, not unfiltered.
    const hasSelectionFilter =
      url.searchParams.has('ids') ||
      url.searchParams.has('station') ||
      url.searchParams.has('bbox') ||
      url.searchParams.has('near') ||
      url.searchParams.has('limit') ||
      url.searchParams.has('country') ||
      url.searchParams.has('vendor') ||
      url.searchParams.has('category') ||
      url.searchParams.has('place') ||
      url.searchParams.has('landform') ||
      url.searchParams.has('launch');
    const isUnfilteredCatalogueQuery =
      isCatalogueRoute && !hasSelectionFilter && profileParam === null;

    // `profile=live` serves the lean wind-only catalogue for hosts without R2
    // (local explorer, self-hosted Worker). Only the unfiltered, JSON variant
    // returns the memoized whole-document bytes; filtered or GeoJSON requests
    // fall through to `selectStations()` against the live station set.
    if (isCatalogueRoute && profileParam === LIVE_CATALOGUE_PROFILE && !hasSelectionFilter &&
        (url.searchParams.get('format') ?? 'json') === 'json') {
      if (!indexed.liveCatalogueBytes) {
        indexed.liveCatalogueBytes = utf8Encoder.encode(JSON.stringify(liveDocument!));
      }
      return rawBytesResponse(indexed.liveCatalogueBytes, 200, corsOrigin, isHead, {
        'Cache-Control': 'public, max-age=300',
      });
    }

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

      const places = parseStrictCsvFilter<StationPlace>(
        url.searchParams.get('place'),
        isStationPlace,
      );
      if (places === 'invalid') {
        return { error: 'invalid place filter' };
      }

      const landforms = parseStrictCsvFilter<Landform>(
        url.searchParams.get('landform'),
        isLandform,
      );
      if (landforms === 'invalid') {
        return { error: 'invalid landform filter' };
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
        candidates = indexed.stationsRef;
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

      if (places) {
        candidates = candidates.filter(s => {
          const place = s.place ?? defaultPlaceForStation(s);
          return place !== null && places.has(place);
        });
      }

      if (landforms) {
        candidates = candidates.filter(s => s.landform !== null && s.landform !== undefined && landforms.has(s.landform));
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
      // The lean profile has no `regions` of its own; inherit the catalogue's.
      const document = liveOnly
        ? { ...liveDocument!, stations: publicStations }
        : {
            schemaVersion: catalogueDoc.schemaVersion,
            generatedAt: catalogueDoc.generatedAt,
            regions: catalogueDoc.regions,
            stations: publicStations,
          };
      if (format === 'geojson') {
        return jsonResponse(
          catalogueToGeoJson(document.stations, document.generatedAt),
          200,
          corsOrigin,
          isHead,
          { 'Cache-Control': 'public, max-age=300' },
        );
      }
      return jsonResponse(document, 200, corsOrigin, isHead, {
        'Cache-Control': 'public, max-age=300',
      });
    }

    const selected = selectStations(isFeedRoute ? maxFeedStations : 1);
    if ('error' in selected) {
      return jsonResponse({ error: selected.error }, 400, corsOrigin, isHead);
    }
    const capped = isFeedRoute ? selected.slice(0, maxFeedStations) : selected.slice(0, 1);
    const includeHistory = isFeedRoute ? parseFeedHistory(url.searchParams.get('history')) : true;
    if (includeHistory === 'invalid') {
      return jsonResponse({ error: 'invalid history: expected 0 or 1' }, 400, corsOrigin, isHead);
    }
    if (includeHistory === false) url.searchParams.delete('history');
    const geojsonFeed = isFeedRoute && url.searchParams.get('format') === 'geojson';
    const currentRoute = pathname.endsWith('/current');
    const environment = createRequestEnvironment(options.environment, stationCache.cacheTimeoutMs);
    const results: StationCacheResult[] = [];
    const batches = new Map<string, Promise<void>>();
    const configs = toStationConfigs(capped, options.credentials);
    const stationConfigs = isFeedRoute || currentRoute ? configs.map((config, i) => ({
      vendor: 'custom' as const,
      id: config.id,
      name: config.name,
      latitude: config.latitude,
      longitude: config.longitude,
      elevationM: config.elevationM,
      timeZone: config.timeZone,
      pageUrl: config.pageUrl,
      load: async (loadContext: { mode: 'current' | 'full'; historyHours: number }) => {
        const station = capped[i]!;
        const mode = includeHistory === false ? 'current' : loadContext.mode;
        let identity = stationKeys.get(station);
        if (!identity) {
          identity = cacheIdentity(JSON.stringify(station));
          stationKeys.set(station, identity);
        }
        const key = `station/v1/${await cacheScope}/${catalogueDoc.generatedAt}/${await identity}/${mode}/${mode === 'full' ? loadContext.historyHours : ''}`;
        const result = await stationCache.read(key, station, async () => {
          // Only cache misses enter this vendor barrier; other vendors start immediately.
          if (station.vendor === 'awc' || station.vendor === 'synoptic') {
            let batch = batches.get(station.vendor);
            if (!batch) {
              batch = prewarmBatchFeedCache(capped.filter(s => s.vendor === station.vendor), options.credentials, environment);
              batches.set(station.vendor, batch);
            }
            await batch;
          }
          const loadOptions = { stations: [config], environment, historyHours: loadContext.historyHours };
          const loaded = mode === 'current'
            ? (await loadStationCurrent({ ...loadOptions, stationId: config.id })).station
            : (await loadStationFeed(loadOptions)).stations[0]!;
          return mode === 'current' && loaded.status === 'ok' ? { ...loaded, history: null } : loaded;
        }, context);
        results.push(result);
        return result.station;
      },
    })) : configs;
    const delegate = createStationFeedHandler({
      stations: stationConfigs,
      primaryStationId: capped[0]?.uid,
      environment,
      basePath: normalizedBase ?? undefined,
      maxHistoryHours: options.maxHistoryHours,
      cors: corsOrigin,
      cacheControl: isFeedRoute || currentRoute ? 'no-store' : undefined,
    });
    // Selection resolves aliases; the delegate must receive the canonical ID too.
    const stationParam = url.searchParams.get('station');
    if (stationParam && byUid.has(stationParam.trim())) {
      url.searchParams.set('station', byUid.get(stationParam.trim())!.uid);
    }
    const headers = new Headers(request.headers);
    // The delegate's ETag covers its JSON representation, not our GeoJSON metadata.
    if (geojsonFeed) headers.delete('If-None-Match');
    const response = await delegate(new Request(url, { method: request.method, headers, signal: request.signal }));
    if (isFeedRoute || currentRoute) {
      const state = results.some(r => r.state === 'stale') ? 'stale'
        : results.length > 0 && results.every(r => r.state === 'hit') ? 'hit' : 'miss';
      const freshUntil = Math.min(...results.map(r => r.freshUntil));
      response.headers.set('X-Station-Cache', state);
      if (isFeedRoute) response.headers.set('X-Feed-Cache', state);
      response.headers.set('X-Station-Cache-Ttl', results.length ? String(Math.max(0, Math.floor((freshUntil - environment.now().getTime()) / 1000))) : '0');
      response.headers.set('X-Station-Catalogue-Revision', catalogueDoc.generatedAt);
      response.headers.set('Access-Control-Expose-Headers', 'Age, ETag, X-Station-Cache');
    }
    if (!geojsonFeed || !response.ok) return response;
    if (isHead) {
      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('ETag');
      return new Response(null, { status: response.status, headers: responseHeaders });
    }
    const feed = parseStationFeedJson(await response.text());
    if (!feed) return jsonResponse({ error: 'invalid upstream feed' }, 502, corsOrigin, false);
    const responseHeaders = new Headers(response.headers);
    responseHeaders.delete('ETag');
    return jsonResponse(feedToGeoJson(feed, byUid), 200, corsOrigin, false, Object.fromEntries(responseHeaders));
  };
}
