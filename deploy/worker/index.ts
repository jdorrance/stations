/**
 * Cloudflare Worker entry for the station explorer.
 *
 * Serves the built explorer from Static Assets and mounts the stations API at
 * `/api/stations`, mirroring `scripts/serve-explorer.mjs` for production.
 *
 * Inputs come from `wrangler.json`: the `ASSETS` and `CATALOGUE` (R2) bindings,
 * the `CORS_ORIGIN` and `CATALOGUE_PREFIX` vars, plus the provider secrets in
 * `credentials.ts`. Operations are documented in `docs/deploy.md`.
 */
import { createProviderFetch, memoryCache, workersCache, type FeedCache } from '@stations/providers';
import { catalogueKeys, createHydratedCatalogueLoader, getPublicCatalogueObject } from './catalogue.ts';
import { credentialsFromEnv, type ProviderSecretEnv } from './credentials.ts';
import { createWorkerRouter } from './router.ts';

/** Generated `Env` covers bindings and vars; secrets are optional at runtime. */
type WorkerEnv = Env & ProviderSecretEnv;

// Construction performs no I/O, so the shared transport may live at module scope.
const providerFetch = createProviderFetch({ maxConcurrent: 6, minIntervalMs: 100 });

let durableCache: FeedCache | undefined;

/**
 * `caches.default` survives across isolates. The object passed into the router
 * is stable; `resolveEnvironment` wraps it per load so in-flight misses are not.
 * Resolved on the first request — `caches` may be absent while the module evaluates.
 */
const observationCache: FeedCache = {
  get: key => sharedObservationCache().get(key),
  put: (key, value, ttlSeconds) => sharedObservationCache().put(key, value, ttlSeconds),
};

function sharedObservationCache(): FeedCache {
  durableCache ??= workersCache() ?? memoryCache();
  return durableCache;
}

let router: ((request: Request) => Promise<Response>) | null = null;

/** Bindings are stable for the life of an isolate, so the router is built once. */
function routerFor(env: WorkerEnv): (request: Request) => Promise<Response> {
  if (router) return router;
  const keys = catalogueKeys(env.CATALOGUE_PREFIX);
  router = createWorkerRouter({
    loadHydrated: createHydratedCatalogueLoader({ store: env.CATALOGUE, key: keys.hydrated }),
    getPublicObject: (kind, ifNoneMatch) => getPublicCatalogueObject(env.CATALOGUE, keys[kind], ifNoneMatch),
    assetsFetch: request => env.ASSETS.fetch(request),
    credentials: credentialsFromEnv(env),
    corsOrigin: env.CORS_ORIGIN,
    environment: { fetch: providerFetch, cache: observationCache },
  });
  return router;
}

export default {
  fetch(request, env) {
    return routerFor(env)(request);
  },
} satisfies ExportedHandler<WorkerEnv>;
