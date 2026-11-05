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
import { cacheConfigFromEnv, type CacheEnv } from './config.ts';
import { credentialsFromEnv, type ProviderSecretEnv } from './credentials.ts';
import { createWorkerRouter } from './router.ts';

/** Generated `Env` covers bindings and vars; secrets are optional at runtime. */
type WorkerEnv = Env & ProviderSecretEnv & CacheEnv;

// Construction performs no I/O, so the shared transport may live at module scope.
// A ~100-station feed wave fans out one upstream call per station; the default
// concurrency and spacing bound how long that wave takes. Holfuy is polled more
// gently (its adapter makes a page + widget request per station), while the
// batchable, higher-throughput vendors go wider.
const providerFetch = createProviderFetch({
  maxConcurrent: 8,
  minIntervalMs: 60,
  origins: {
    'https://api.holfuy.com': { maxConcurrent: 6, minIntervalMs: 100 },
    'https://holfuy.com': { maxConcurrent: 6, minIntervalMs: 100 },
    'https://api.synopticdata.com': { maxConcurrent: 10, minIntervalMs: 40 },
    'https://aviationweather.gov': { maxConcurrent: 10, minIntervalMs: 40 },
  },
});

let durableCache: FeedCache | undefined;

/**
 * The data-center cache survives isolate replacement. Resolved on the first
 * request because `caches` may be absent while the module evaluates.
 */
const observationCache: FeedCache = {
  get: key => sharedObservationCache().get(key),
  put: (key, value, ttlSeconds) => sharedObservationCache().put(key, value, ttlSeconds),
};

function sharedObservationCache(): FeedCache {
  durableCache ??= workersCache() ?? memoryCache();
  return durableCache;
}

let router: ReturnType<typeof createWorkerRouter> | null = null;

/** Bindings are stable for the life of an isolate, so the router is built once. */
function routerFor(env: WorkerEnv): ReturnType<typeof createWorkerRouter> {
  if (router) return router;
  const keys = catalogueKeys(env.CATALOGUE_PREFIX);
  const config = cacheConfigFromEnv(env);
  router = createWorkerRouter({
    loadHydrated: createHydratedCatalogueLoader({
      store: env.CATALOGUE, key: keys.hydrated,
      revalidateMs: config.catalogueRevalidateMs, timeoutMs: config.catalogueTimeoutMs,
    }),
    getPublicObject: (kind, ifNoneMatch) => getPublicCatalogueObject(env.CATALOGUE, keys[kind], ifNoneMatch),
    assetsFetch: request => env.ASSETS.fetch(request),
    credentials: credentialsFromEnv(env),
    corsOrigin: env.CORS_ORIGIN,
    environment: { fetch: providerFetch, cache: observationCache },
    responseCache: typeof caches === 'undefined' ? undefined : caches.default,
    cacheNamespace: `${env.VERSION.id}/${env.CATALOGUE_PREFIX}`,
    ...config,
  });
  return router;
}

export default {
  fetch(request, env, ctx) {
    return routerFor(env)(request, { waitUntil: task => ctx.waitUntil(task) });
  },
} satisfies ExportedHandler<WorkerEnv>;
