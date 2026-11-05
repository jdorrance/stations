import { LIVE_CATALOGUE_PROFILE, type StationCatalogueDocument } from '@stations/contracts';
import {
  createStationsApiHandler,
  type ProviderCredentials,
  type ServerEnvironment,
  type StationCachePolicy,
  type StationRequestContext,
} from '@stations/providers';
import type { PublicCatalogueKind, PublicCatalogueObject } from './catalogue.ts';
import { cachedResponse, cacheResponse, conditionalResponse, type EdgeResponseCache } from './cache.ts';

export const API_BASE_PATH = '/api/stations';

/** Runtime services the router needs; `index.ts` binds them to Cloudflare, tests inject fakes. */
export interface WorkerRouterDeps {
  readonly loadHydrated: (context?: StationRequestContext) => Promise<StationCatalogueDocument>;
  readonly getPublicObject: (
    kind: PublicCatalogueKind,
    ifNoneMatch: string | null,
  ) => Promise<PublicCatalogueObject | null>;
  readonly assetsFetch: (request: Request) => Promise<Response>;
  readonly credentials: ProviderCredentials;
  readonly corsOrigin: string;
  readonly environment?: ServerEnvironment;
  readonly maxFeedStations?: number;
  readonly cachePolicy?: StationCachePolicy;
  readonly responseCache?: EdgeResponseCache;
  /** Deployment/catalogue identity, independent from credentials (which are hashed separately). */
  readonly cacheNamespace?: string;
  readonly responseCacheSeconds?: number;
  readonly catalogueCacheSeconds?: number;
  readonly cacheFillTimeoutMs?: number;
}

const CONTENT_TYPES: Record<PublicCatalogueKind, string> = {
  json: 'application/json; charset=utf-8',
  geojson: 'application/geo+json; charset=utf-8',
  live: 'application/json; charset=utf-8',
};

const CATALOGUE_CACHE_CONTROL = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400';
const SELECTION_PARAMS = new Set(['ids', 'station', 'bbox', 'near', 'limit', 'country', 'vendor', 'category', 'place', 'landform', 'launch']);

/**
 * Identifies `/api/stations/catalogue` requests with no filter parameters.
 * They are the only route whose body is served from the published public
 * objects; `format` selects geojson and `profile=live` selects the lean
 * wind-only object. Unknown parameters are ignored, matching the handler.
 */
export function unfilteredCatalogueKind(url: URL): PublicCatalogueKind | null {
  const pathname =
    url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  if (pathname !== `${API_BASE_PATH}/catalogue`) return null;
  for (const key of url.searchParams.keys()) {
    if (SELECTION_PARAMS.has(key)) return null;
  }
  const profile = url.searchParams.get('profile');
  if (profile !== null) {
    // The lean profile is JSON-only; a GeoJSON request falls through to the
    // handler, which converts the lean station set itself.
    if (profile !== LIVE_CATALOGUE_PROFILE) return null;
    return url.searchParams.get('format') === 'geojson' ? null : 'live';
  }
  return url.searchParams.get('format') === 'geojson' ? 'geojson' : 'json';
}

/**
 * Routes a request: static assets outside `/api/stations`, published public
 * objects for the unfiltered catalogue, and the stations API handler for
 * everything else (feeds, current readings, filtered catalogue queries).
 */
export function createWorkerRouter(deps: WorkerRouterDeps): (request: Request, context?: StationRequestContext) => Promise<Response> {
  const responseSeconds = cacheSeconds(deps.responseCacheSeconds ?? 5);
  const catalogueSeconds = cacheSeconds(deps.catalogueCacheSeconds ?? 300);
  const cacheTimeoutMs = deps.cachePolicy?.cacheTimeoutMs ?? 100;
  if (deps.cacheFillTimeoutMs !== undefined && (!Number.isFinite(deps.cacheFillTimeoutMs) || deps.cacheFillTimeoutMs <= 0)) {
    throw new RangeError('Cache fill timeout must be positive');
  }
  const now = () => deps.environment?.now?.().getTime() ?? Date.now();
  const scope = identity(JSON.stringify([
    deps.cacheNamespace, deps.credentials, deps.cachePolicy, deps.corsOrigin, deps.maxFeedStations,
    responseSeconds, catalogueSeconds,
  ]));
  let catalogueRevision: string | null = null;
  const loadHydrated = async (context?: StationRequestContext) => {
    const document = await deps.loadHydrated(context);
    catalogueRevision = document.generatedAt;
    return document;
  };
  const apiHandler = createStationsApiHandler({
    catalogue: loadHydrated,
    credentials: deps.credentials,
    environment: deps.environment,
    basePath: API_BASE_PATH,
    maxFeedStations: deps.maxFeedStations ?? 30,
    corsOrigin: deps.corsOrigin,
    cachePolicy: deps.cachePolicy,
  });

  return async (request, context = {}) => {
    const url = new URL(request.url);
    if (url.pathname !== API_BASE_PATH && !url.pathname.startsWith(`${API_BASE_PATH}/`)) {
      return deps.assetsFetch(request);
    }
    const isHead = request.method === 'HEAD';
    if (request.method === 'GET' || isHead) {
      const kind = unfilteredCatalogueKind(url);
      if (kind) {
        const key = new Request(new URL(`/__stations-cache/${await scope}/catalogue/${kind}`, url));
        const hit = catalogueSeconds > 0 ? await cachedResponse(deps.responseCache, key, now(), cacheTimeoutMs) : null;
        if (hit) return conditionalResponse(hit, request);
        const response = await publicCatalogueResponse(deps, kind, request.headers.get('If-None-Match'), isHead);
        if (!isHead) await store(key, response, catalogueSeconds, context);
        return response;
      }
    }
    const eligible = responseSeconds > 0 && (request.method === 'GET' || isHead)
      && !request.headers.has('Authorization') && !request.headers.has('Cookie')
      && !request.headers.has('Range') && url.searchParams.get('format') !== 'geojson'
      && ((url.pathname === `${API_BASE_PATH}/current` && url.searchParams.has('station'))
        || (url.pathname === `${API_BASE_PATH}/feed` && url.searchParams.has('ids') && url.searchParams.get('history') === '0'));
    let key: Request | null = null;
    if (eligible && deps.responseCache) {
      const canonical = new URL(url);
      canonical.searchParams.sort();
      key = new Request(new URL(`/__stations-cache/${await scope}/live/${await identity(canonical.pathname + canonical.search)}`, url));
      const hit = await cachedResponse(deps.responseCache, key, now(), cacheTimeoutMs);
      if (hit && (!catalogueRevision || hit.headers.get('X-Station-Catalogue-Revision') === catalogueRevision)) {
        try {
          const document = await hit.json() as { servedAt: string };
          if (typeof document.servedAt === 'string') {
            document.servedAt = new Date(now()).toISOString();
            const headers = new Headers(hit.headers);
            headers.delete('Content-Length');
            headers.set('Age', '0');
            headers.set('X-Response-Cache', 'hit');
            headers.set('X-Station-Cache', 'hit');
            if (headers.has('X-Feed-Cache')) headers.set('X-Feed-Cache', 'hit');
            if (context.waitUntil) context.waitUntil(loadHydrated(context).catch(() => {}));
            return conditionalResponse(new Response(JSON.stringify(document), { headers }), request);
          }
        } catch {
          // Corrupt/obsolete response: rebuild through the handler.
        }
      }
    }
    const response = await apiHandler(request, context);
    if (key && !isHead) {
      const ttl = Number(response.headers.get('X-Station-Cache-Ttl'));
      if (Number.isFinite(ttl)) await store(key, response, Math.min(responseSeconds, ttl), context);
    }
    return response;
  };

  async function store(key: Request, response: Response, ttl: number, context: StationRequestContext): Promise<void> {
    if (!deps.responseCache || response.status !== 200 || ttl <= 0) return;
    const task = cacheResponse(deps.responseCache, key, response.clone(), ttl, now(), deps.cacheFillTimeoutMs);
    if (context.waitUntil) context.waitUntil(task);
    else await task;
  }
}

function cacheSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Cache seconds must be non-negative');
  return value;
}

async function identity(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function publicCatalogueResponse(
  deps: WorkerRouterDeps,
  kind: PublicCatalogueKind,
  ifNoneMatch: string | null,
  isHead: boolean,
): Promise<Response> {
  const object = await deps.getPublicObject(kind, ifNoneMatch);
  if (!object) {
    return new Response(isHead ? null : JSON.stringify({ error: 'catalogue not published' }), {
      status: 503,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': deps.corsOrigin,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  const headers: Record<string, string> = {
    ETag: object.etag,
    'Cache-Control': CATALOGUE_CACHE_CONTROL,
    'Access-Control-Allow-Origin': deps.corsOrigin,
    Vary: 'Accept-Encoding',
  };
  if (object.contentEncoding) headers['Content-Encoding'] = object.contentEncoding;
  if (object.body === null) return new Response(null, { status: 304, headers });
  headers['Content-Type'] = CONTENT_TYPES[kind];
  headers['Content-Length'] = String(object.size);
  headers['X-Content-Type-Options'] = 'nosniff';
  if (isHead) {
    await object.body.cancel();
    return new Response(null, { status: 200, headers });
  }
  return new Response(object.body, { status: 200, headers });
}
