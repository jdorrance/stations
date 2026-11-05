import type { StationCachePolicy } from '@stations/providers';

/** Optional deployment overrides; handler defaults own station cache policy. */
export interface CacheEnv {
  readonly STATION_CACHE_FRESH_SECONDS?: string;
  readonly STATION_CACHE_MAX_AGE_SECONDS?: string;
  readonly SONIC_CACHE_FRESH_SECONDS?: string;
  readonly SONIC_CACHE_MAX_AGE_SECONDS?: string;
  readonly CACHE_TIMEOUT_MS?: string;
  readonly CACHE_FILL_TIMEOUT_MS?: string;
  readonly CATALOGUE_TIMEOUT_MS?: string;
  readonly RESPONSE_CACHE_SECONDS?: string;
  readonly CATALOGUE_CACHE_SECONDS?: string;
  readonly CATALOGUE_REVALIDATE_SECONDS?: string;
}

export function cacheConfigFromEnv(env: CacheEnv) {
  const setting = (name: keyof CacheEnv, fallback?: number): number | undefined => {
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`Invalid ${name}`);
    return value;
  };
  const cachePolicy: StationCachePolicy = {
    freshSeconds: setting('STATION_CACHE_FRESH_SECONDS'),
    maxAgeSeconds: setting('STATION_CACHE_MAX_AGE_SECONDS'),
    sonicFreshSeconds: setting('SONIC_CACHE_FRESH_SECONDS'),
    sonicMaxAgeSeconds: setting('SONIC_CACHE_MAX_AGE_SECONDS'),
    cacheTimeoutMs: setting('CACHE_TIMEOUT_MS'),
  };
  return {
    cachePolicy,
    responseCacheSeconds: setting('RESPONSE_CACHE_SECONDS', 5)!,
    catalogueCacheSeconds: setting('CATALOGUE_CACHE_SECONDS', 300)!,
    catalogueRevalidateMs: setting('CATALOGUE_REVALIDATE_SECONDS', 300)! * 1000,
    cacheFillTimeoutMs: setting('CACHE_FILL_TIMEOUT_MS'),
    catalogueTimeoutMs: setting('CATALOGUE_TIMEOUT_MS'),
  };
}
