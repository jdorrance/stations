import type { StationCatalogueDocument } from '@stations/contracts';
import {
  createStationsApiHandler,
  type ProviderCredentials,
  type ServerEnvironment,
} from '@stations/providers';
import type { PublicCatalogueKind, PublicCatalogueObject } from './catalogue.ts';

export const API_BASE_PATH = '/api/stations';

/** Runtime services the router needs; `index.ts` binds them to Cloudflare, tests inject fakes. */
export interface WorkerRouterDeps {
  readonly loadHydrated: () => Promise<StationCatalogueDocument>;
  readonly getPublicObject: (
    kind: PublicCatalogueKind,
    ifNoneMatch: string | null,
  ) => Promise<PublicCatalogueObject | null>;
  readonly assetsFetch: (request: Request) => Promise<Response>;
  readonly credentials: ProviderCredentials;
  readonly corsOrigin: string;
  readonly environment?: ServerEnvironment;
  readonly maxFeedStations?: number;
}

const CONTENT_TYPES: Record<PublicCatalogueKind, string> = {
  json: 'application/json; charset=utf-8',
  geojson: 'application/geo+json; charset=utf-8',
};

/**
 * Identifies `/api/stations/catalogue` requests with no filter parameters.
 * They are the only route whose body is served from the published public
 * objects; `format` is the one parameter that does not filter, matching
 * `createStationsApiHandler`.
 */
export function unfilteredCatalogueKind(url: URL): PublicCatalogueKind | null {
  const pathname =
    url.pathname.length > 1 && url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : url.pathname;
  if (pathname !== `${API_BASE_PATH}/catalogue`) return null;
  for (const key of url.searchParams.keys()) {
    if (key !== 'format') return null;
  }
  return url.searchParams.get('format') === 'geojson' ? 'geojson' : 'json';
}

/**
 * Routes a request: static assets outside `/api/stations`, published public
 * objects for the unfiltered catalogue, and the stations API handler for
 * everything else (feeds, current readings, filtered catalogue queries).
 */
export function createWorkerRouter(deps: WorkerRouterDeps): (request: Request) => Promise<Response> {
  const apiHandler = createStationsApiHandler({
    catalogue: deps.loadHydrated,
    credentials: deps.credentials,
    environment: deps.environment,
    basePath: API_BASE_PATH,
    maxFeedStations: deps.maxFeedStations ?? 30,
    corsOrigin: deps.corsOrigin,
  });

  return async request => {
    const url = new URL(request.url);
    if (url.pathname !== API_BASE_PATH && !url.pathname.startsWith(`${API_BASE_PATH}/`)) {
      return deps.assetsFetch(request);
    }
    const isHead = request.method === 'HEAD';
    if (request.method === 'GET' || isHead) {
      const kind = unfilteredCatalogueKind(url);
      if (kind) return publicCatalogueResponse(deps, kind, request.headers.get('If-None-Match'), isHead);
    }
    return apiHandler(request);
  };
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
    'Cache-Control': 'public, max-age=300',
    'Access-Control-Allow-Origin': deps.corsOrigin,
  };
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
