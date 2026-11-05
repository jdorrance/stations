import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheConfigFromEnv } from '../config.ts';

test('worker cache timings preserve handler defaults and accept deployment overrides', () => {
  const defaults = cacheConfigFromEnv({});
  assert.equal(defaults.cachePolicy.freshSeconds, undefined);
  assert.equal(defaults.responseCacheSeconds, 5);
  assert.equal(defaults.catalogueCacheSeconds, 300);
  assert.equal(defaults.catalogueRevalidateMs, 300000);
  assert.equal(defaults.cacheFillTimeoutMs, undefined);
  assert.equal(defaults.catalogueTimeoutMs, undefined);
  const config = cacheConfigFromEnv({
    STATION_CACHE_FRESH_SECONDS: '60', STATION_CACHE_MAX_AGE_SECONDS: '600',
    SONIC_CACHE_FRESH_SECONDS: '10', SONIC_CACHE_MAX_AGE_SECONDS: '90',
    RESPONSE_CACHE_SECONDS: '0', CATALOGUE_CACHE_SECONDS: '120', CATALOGUE_REVALIDATE_SECONDS: '30', CACHE_TIMEOUT_MS: '50',
    CACHE_FILL_TIMEOUT_MS: '2000', CATALOGUE_TIMEOUT_MS: '8000',
  });
  assert.deepEqual(config.cachePolicy, { freshSeconds: 60, maxAgeSeconds: 600, sonicFreshSeconds: 10, sonicMaxAgeSeconds: 90, cacheTimeoutMs: 50 });
  assert.equal(config.responseCacheSeconds, 0);
  assert.equal(config.catalogueCacheSeconds, 120);
  assert.equal(config.catalogueRevalidateMs, 30000);
  assert.equal(config.cacheFillTimeoutMs, 2000);
  assert.equal(config.catalogueTimeoutMs, 8000);
  for (const value of ['-1', '', 'NaN', 'Infinity']) assert.throws(() => cacheConfigFromEnv({ RESPONSE_CACHE_SECONDS: value }), /RESPONSE_CACHE_SECONDS/);
});
