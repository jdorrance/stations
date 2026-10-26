import {
  createStationFeedHandler,
  loadStationFeed,
  resolveEnvironment,
  type ServerEnvironment,
} from '@azohra/meteo.station/server';
import {
  catalogueToGeoJson,
  feedToGeoJson,
  isStationVendor,
  type CatalogueStation,
  type StationCatalogueDocument,
  type StationVendor,
} from '@stations/contracts';
import {
  createSpatialIndex,
  isRegionCode,
  parseBoundsParam,
  validPosition,
  type RegionCode,
} from '@stations/geography';
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
  const parts = raw.split(',').map(part => Number(part.trim()));
  if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return null;
  const [latitude, longitude, radiusKm] = parts as [number, number, number];
  if (!validPosition({ latitude, longitude }) || radiusKm <= 0) return null;
  return { latitude, longitude, radiusKm };
}

function parseLimitParam(raw: string | null, fallback?: number): number | undefined {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return n;
}

function parseCsvFilter<T extends string>(
  raw: string | null,
  guard: (item: string) => item is T,
): Set<T> | null {
  if (!raw) return null;
  const values = raw
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  const out = new Set<T>();
  for (const val of values) {
    if (guard(val)) out.add(val);
    else if (guard(val.toUpperCase())) out.add(val.toUpperCase() as T);
  }
  return out.size > 0 ? out : null;
}

function jsonResponse(
  body: unknown,
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
  return new Response(isHead ? null : JSON.stringify(body), { status, headers });
}

export function createStationsApiHandler(
  options: StationsApiHandlerOptions,
): (request: Request) => Promise<Response> {
  const corsOrigin = options.corsOrigin ?? '*';
  const maxFeedStations = options.maxFeedStations ?? DEFAULT_MAX_FEED_STATIONS;
  const normalizedBase = options.basePath
    ? options.basePath.endsWith('/')
      ? options.basePath.slice(0, -1)
      : options.basePath
    : null;

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

    const catalogueDoc =
      typeof options.catalogue === 'function' ? await options.catalogue() : options.catalogue;
    const index = createSpatialIndex(catalogueDoc.stations, 1);
    const byUid = new Map<string, CatalogueStation>(
      catalogueDoc.stations.map(s => [s.uid, s]),
    );

    const selectStations = (defaultLimit?: number): CatalogueStation[] | { error: string } => {
      const idsParam = url.searchParams.get('ids');
      const stationParam = url.searchParams.get('station');
      const bboxParam = url.searchParams.get('bbox');
      const nearParam = url.searchParams.get('near');
      const limit = parseLimitParam(url.searchParams.get('limit'), defaultLimit);
      if (url.searchParams.has('limit') && limit === undefined) {
        return { error: 'invalid limit: expected positive integer' };
      }

      let candidates: CatalogueStation[];
      if (stationParam) {
        const hit = byUid.get(stationParam.trim());
        candidates = hit ? [hit] : [];
      } else if (idsParam) {
        const requested = idsParam
          .split(',')
          .map(part => part.trim())
          .filter(Boolean);
        candidates = requested
          .map(uid => byUid.get(uid))
          .filter((s): s is CatalogueStation => s !== undefined);
      } else if (bboxParam !== null) {
        const bounds = parseBoundsParam(bboxParam);
        if (!bounds) return { error: 'invalid bbox: expected west,south,east,north' };
        candidates = index.queryBounds(bounds);
      } else if (nearParam !== null) {
        const near = parseNearParam(nearParam);
        if (!near) return { error: 'invalid near: expected lat,lon,radiusKm' };
        candidates = index
          .queryRadius({ latitude: near.latitude, longitude: near.longitude }, near.radiusKm, limit)
          .map(m => m.item);
      } else {
        candidates = [...catalogueDoc.stations];
      }

      const countries = parseCsvFilter<RegionCode>(
        url.searchParams.get('country'),
        isRegionCode,
      );
      if (countries) {
        candidates = candidates.filter(s => s.country !== null && countries.has(s.country));
      }

      const vendors = parseCsvFilter<StationVendor>(
        url.searchParams.get('vendor'),
        isStationVendor,
      );
      if (vendors) {
        candidates = candidates.filter(s => vendors.has(s.vendor));
      }

      return limit !== undefined ? candidates.slice(0, limit) : candidates;
    };

    if (isCatalogueRoute) {
      const selected = selectStations();
      if ('error' in selected) {
        return jsonResponse({ error: selected.error }, 400, corsOrigin, isHead);
      }
      const format = url.searchParams.get('format') ?? 'json';
      if (format === 'geojson') {
        return jsonResponse(
          catalogueToGeoJson(selected, catalogueDoc.generatedAt),
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
          stations: selected,
        },
        200,
        corsOrigin,
        isHead,
        { 'Cache-Control': 'public, max-age=300' },
      );
    }

    const isFeedRoute =
      normalizedBase !== null
        ? pathname === `${normalizedBase}/feed`
        : pathname.endsWith('/feed');
    const selected = selectStations(isFeedRoute ? maxFeedStations : undefined);
    if ('error' in selected) {
      return jsonResponse({ error: selected.error }, 400, corsOrigin, isHead);
    }
    const capped = isFeedRoute ? selected.slice(0, maxFeedStations) : selected;
    const stationConfigs = toStationConfigs(capped, options.credentials);

    if (isFeedRoute && url.searchParams.get('format') === 'geojson') {
      const environment = resolveEnvironment(options.environment);
      const feed = await loadStationFeed({
        stations: stationConfigs,
        primaryStationId: capped[0]?.uid,
        environment,
        request,
      });
      return jsonResponse(feedToGeoJson(feed, byUid), 200, corsOrigin, isHead, {
        'Cache-Control': 'public, max-age=30',
      });
    }

    const delegate = createStationFeedHandler({
      stations: stationConfigs,
      primaryStationId: capped[0]?.uid,
      environment: options.environment,
      basePath: normalizedBase ?? undefined,
      maxHistoryHours: options.maxHistoryHours,
      cors: corsOrigin,
    });
    return delegate(request);
  };
}
