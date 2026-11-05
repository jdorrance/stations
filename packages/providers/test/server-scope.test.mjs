import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderFetch } from '../dist/transport.js';
import { memoryCache } from '@azohra/meteo.station/server';
import {
  createRequestEnvironment, createStationFeedHandler, defineStationAdapter,
  fetchUpstreamText, resolveEnvironment,
} from '../dist/server.js';

const quiet = { logger: () => {} };
const request = { url: 'https://weather.test/shared', cacheKey: 'shared', cacheTtlSeconds: 30, subject: 'shared' };
const fast = fetch => createProviderFetch({ fetch, minIntervalMs: 0, maxConcurrent: 20, maxAttempts: 1 });
const turn = () => new Promise(resolve => setTimeout(resolve, 0));

test('one request scope coalesces concurrent misses through nested resolves', async () => {
  let calls = 0;
  let release;
  const fetch = fast(async () => {
    calls += 1;
    await new Promise(resolve => { release = resolve; });
    return new Response('ok');
  });
  const environment = createRequestEnvironment({ fetch, cache: memoryCache(), ...quiet });
  const loads = Array.from({ length: 10 }, () => fetchUpstreamText(resolveEnvironment(environment), request));
  await turn();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all(loads), Array(10).fill('ok'));
});

test('a new request scope never awaits an earlier request-owned load', async () => {
  let calls = 0;
  let release;
  const raw = {
    ...quiet, cache: memoryCache(), fetch: fast(async () => {
      if (++calls === 1) await new Promise(resolve => { release = resolve; });
      return new Response('ok');
    }),
  };
  const firstScope = createRequestEnvironment(raw);
  const first = fetchUpstreamText(firstScope, request);
  await turn();
  const second = fetchUpstreamText(createRequestEnvironment(firstScope), request);
  assert.equal(await second, 'ok');
  assert.equal(calls, 2);
  release();
  assert.equal(await first, 'ok');
});

test('failed coalesced loads settle and can be retried in the same scope', async () => {
  let calls = 0;
  const environment = createRequestEnvironment({
    ...quiet, cache: memoryCache(), fetch: fast(async () => {
      calls += 1;
      return calls === 1 ? new Response(null, { status: 403 }) : new Response('recovered');
    }),
  });
  const settled = await Promise.allSettled(Array.from({ length: 3 }, () => fetchUpstreamText(environment, request)));
  assert.ok(settled.every(result => result.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal(await fetchUpstreamText(environment, request), 'recovered');
  assert.equal(calls, 2);
});

test('cache rejection or timeout cannot discard a successful upstream response', async () => {
  for (const stuck of [false, true]) {
    const unavailable = () => stuck ? new Promise(() => {}) : Promise.reject(new Error('Cache unavailable'));
    const environment = createRequestEnvironment({
      ...quiet, cache: { get: unavailable, put: unavailable }, fetch: fast(async () => new Response('ok')),
    }, 5);
    assert.equal(await fetchUpstreamText(environment, request), 'ok');
  }
});

test('adapters retain the explicit scope while HTTP requests receive separate scopes', async () => {
  let calls = 0;
  const environment = createRequestEnvironment({
    ...quiet, cache: { get: async () => null, put: async () => {} },
    fetch: fast(async () => { calls += 1; await turn(); return new Response('ok'); }),
  });
  const meta = {
    id: 'one', name: 'one', sourceLabel: 'fixture', pageUrl: null,
    latitude: null, longitude: null, elevationM: null, timeZone: null,
    capabilities: { gustLull: false, temperature: false, conditions: false, history: false },
    samplingWindowSeconds: null, recommendedPollSeconds: 60,
  };
  const adapter = defineStationAdapter({
    meta: () => meta,
    load: async (_, context) => {
      await fetchUpstreamText(context.environment, request);
      throw new Error('Only request coalescing is under test');
    },
  });
  await Promise.all([adapter({}, { environment }), adapter({}, { environment })]);
  assert.equal(calls, 1);

  const handler = createStationFeedHandler({
    environment, stations: [{ vendor: 'custom', id: 'one', name: 'one', load: async context => {
      await fetchUpstreamText(context.environment, request);
      throw new Error('Only request ownership is under test');
    } }],
  });
  await Promise.all([handler(new Request('https://app.test/current?station=one')), handler(new Request('https://app.test/current?station=one'))]);
  assert.equal(calls, 3);
});
