import { AsyncLocalStorage } from 'node:async_hooks';
import * as upstream from '@azohra/meteo.station/server';
import { withDeadline } from './deadline.ts';
import { providerFetch } from './transport.ts';

const requestCaches = new WeakMap<upstream.FeedCache, upstream.FeedCache>();
const requestScope = new AsyncLocalStorage<upstream.FeedCache>();

/** One cache identity per operation: share misses within it, never its I/O with another request. */
export function createRequestEnvironment(
  environment?: upstream.ServerEnvironment,
  cacheTimeoutMs = 100,
): upstream.ResolvedEnvironment {
  if (!Number.isFinite(cacheTimeoutMs) || cacheTimeoutMs < 0) {
    throw new RangeError('cacheTimeoutMs must be a non-negative finite number');
  }
  const resolved = managedEnvironment(environment);
  const cache = requestCaches.get(resolved.cache) ?? resolved.cache;
  async function bestEffort<T>(load: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await withDeadline(Promise.resolve().then(load), cacheTimeoutMs, 'Cache timed out');
    } catch {
      return fallback;
    }
  }
  const scoped: upstream.FeedCache = {
    get: key => bestEffort(() => cache.get(key), null),
    put: (key, value, ttlSeconds) => bestEffort(() => cache.put(key, value, ttlSeconds), undefined),
  };
  requestCaches.set(scoped, cache);
  return { ...resolved, cache: scoped };
}

function managedEnvironment(environment?: upstream.ServerEnvironment): upstream.ResolvedEnvironment {
  return upstream.resolveEnvironment({ ...environment, fetch: providerFetch(environment?.fetch) });
}

/** Preserve upstream environment contracts while sharing a managed transport. */
export function resolveEnvironment(environment?: upstream.ServerEnvironment): upstream.ResolvedEnvironment {
  const resolved = managedEnvironment(environment);
  return requestCaches.has(resolved.cache) ? resolved : createRequestEnvironment(resolved);
}

function withEnvironment<T extends { environment?: upstream.ServerEnvironment }>(options: T) {
  return { ...options, environment: resolveEnvironment(options.environment) };
}

export function defineStationAdapter<C, O extends upstream.StationAdapterOptions = upstream.StationAdapterOptions>(
  definition: upstream.StationAdapterDefinition<C, O>,
): upstream.StationAdapter<C, O> {
  return upstream.defineStationAdapter({
    ...definition,
    load: (config, context) => definition.load(config, {
      ...context, environment: resolveEnvironment(context.options.environment),
    }),
  });
}

export function createStationFeedHandler(
  options: upstream.StationFeedHandlerOptions,
  cacheTimeoutMs = 100,
): upstream.StationFeedHandler {
  const base = managedEnvironment(options.environment);
  const environment: upstream.ServerEnvironment = {
    fetch: base.fetch,
    logger: base.logger,
    userAgent: base.userAgent,
    now: base.now,
    get cache() {
      return requestScope.getStore() ?? base.cache;
    },
  };
  const handler = upstream.createStationFeedHandler({ ...options, environment });
  return request => {
    const scoped = createRequestEnvironment(base, cacheTimeoutMs);
    return requestScope.run(scoped.cache, () => handler(request));
  };
}

export function loadStationCurrent(options: upstream.LoadStationCurrentOptions) {
  return upstream.loadStationCurrent(withEnvironment(options));
}

export function loadStationFeed(options: upstream.LoadStationFeedOptions) {
  return upstream.loadStationFeed(withEnvironment(options));
}

export function loadStationHistory(options: upstream.LoadStationHistoryOptions) {
  return upstream.loadStationHistory(withEnvironment(options));
}

export function loadStationClimatology(options: upstream.LoadStationClimatologyOptions) {
  return upstream.loadStationClimatology(withEnvironment(options));
}

export function openStationLive(options: upstream.OpenStationLiveOptions) {
  return upstream.openStationLive(withEnvironment(options));
}

export function fetchUpstreamText(environment: upstream.ResolvedEnvironment, request: upstream.UpstreamTextRequest) {
  return upstream.fetchUpstreamText(resolveEnvironment(environment), request);
}

export function fetchUpstreamStream(environment: upstream.ResolvedEnvironment, request: upstream.UpstreamStreamRequest) {
  return upstream.fetchUpstreamStream(resolveEnvironment(environment), request);
}
