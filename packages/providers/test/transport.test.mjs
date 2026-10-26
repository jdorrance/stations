import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createProviderFetch, resolveEnvironment, fetchUpstreamText, memoryCache,
  createStationFeedHandler, defineStationAdapter, loadStationCurrent,
} from '../dist/index.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fast = fetch => createProviderFetch({ fetch, minIntervalMs: 0, baseDelayMs: 0 });
const quiet = { logger: () => {} };

test('transient statuses retry within the attempt bound and discard failed bodies', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    let calls = 0;
    let cancelled = 0;
    const fetch = fast(async () => {
      calls += 1;
      return calls < 3
        ? new Response(new ReadableStream({ cancel() { cancelled += 1; } }), { status })
        : new Response('recovered');
    });
    assert.equal(await (await fetch('https://weather.test/current')).text(), 'recovered');
    assert.equal(calls, 3);
    assert.equal(cancelled, 2);
  }
  let calls = 0;
  const fetch = fast(async () => { calls += 1; return new Response('still down', { status: 503 }); });
  const response = await fetch('https://weather.test/current');
  assert.equal(calls, 3);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'still down');
});

test('network failures retry, but terminal HTTP errors and non-idempotent requests do not', async () => {
  let calls = 0;
  const fetch = fast(async () => {
    if (++calls === 1) throw new TypeError('network disconnected');
    return new Response('ok');
  });
  assert.equal((await fetch('https://weather.test')).status, 200);
  assert.equal(calls, 2);
  for (const status of [400, 401, 403, 404, 422, 501]) {
    let requests = 0;
    const terminal = fast(async () => { requests += 1; return new Response(null, { status }); });
    assert.equal((await terminal('https://weather.test')).status, status);
    assert.equal(requests, 1);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    let requests = 0;
    const once = fast(async () => { requests += 1; return new Response(null, { status: 503 }); });
    assert.equal((await once('https://weather.test', { method, body: 'unchanged' })).status, 503);
    assert.equal(requests, 1);
  }
});

test('request objects, headers, signals and init overrides survive HEAD retries', async () => {
  let calls = 0;
  const caller = new AbortController();
  const request = new Request('https://weather.test/current', { method: 'HEAD', headers: { 'X-Fixture': 'value' }, signal: caller.signal });
  const fetch = fast(async (input, init) => {
    const actual = new Request(input, init);
    assert.equal(actual.url, request.url);
    assert.equal(actual.method, 'HEAD');
    assert.equal(actual.headers.get('X-Fixture'), 'value');
    assert.equal(init.redirect, 'error');
    assert.equal(actual.signal.aborted, false);
    return new Response(null, { status: ++calls === 1 ? 502 : 200 });
  });
  assert.equal((await fetch(request, { redirect: 'error' })).status, 200);
  assert.equal(calls, 2);
});

test('Retry-After pauses other calls at the same origin, including after retries are exhausted', async () => {
  const starts = [];
  const fetch = createProviderFetch({ minIntervalMs: 0, maxAttempts: 1, baseDelayMs: 0,
    fetch: async input => {
      starts.push({ url: String(input), time: Date.now() });
      return new Response(null, { status: starts.length === 1 ? 429 : 200, headers: { 'Retry-After': '0.08' } });
    },
  });
  await fetch('https://weather.test/one');
  const same = fetch('https://weather.test/two');
  await fetch('https://other.test/current');
  assert.equal(starts[1].url, 'https://other.test/current');
  await same;
  assert.equal(starts[2].url, 'https://weather.test/two');
  assert.ok(starts[2].time - starts[0].time >= 70);
});

test('HTTP-date cooldowns outlive a caller deadline and are not truncated to maxDelayMs', async () => {
  let calls = 0;
  const fetch = createProviderFetch({ minIntervalMs: 0, maxDelayMs: 0, maxElapsedMs: 25,
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 503, headers: { 'Retry-After': new Date(Date.now() + 3000).toUTCString() } });
    },
  });
  await assert.rejects(fetch('https://weather.test/one'), { name: 'TimeoutError' });
  await assert.rejects(fetch('https://weather.test/two'), { name: 'TimeoutError' });
  assert.equal(calls, 1);
});

test('invalid Retry-After falls back to bounded jitter and does not trap the origin', async () => {
  for (const header of ['garbage', '-1', '', 'Infinity']) {
    let calls = 0;
    const fetch = createProviderFetch({ minIntervalMs: 0, baseDelayMs: 5, maxDelayMs: 5,
      fetch: async () => new Response(null, { status: ++calls === 1 ? 503 : 200, headers: { 'Retry-After': header } }),
    });
    assert.equal((await fetch('https://weather.test')).status, 200);
    assert.equal(calls, 2);
  }
});

test('spacing and concurrency apply across independent requests, while other origins make progress', async () => {
  let active = 0;
  let peak = 0;
  const starts = [];
  const fetch = createProviderFetch({ maxConcurrent: 2, minIntervalMs: 15,
    fetch: async input => {
      if (new URL(String(input)).hostname === 'other.test') return new Response('other');
      active += 1;
      peak = Math.max(peak, active);
      starts.push(Date.now());
      await pause(40);
      active -= 1;
      return new Response('ok');
    },
  });
  const requests = Array.from({ length: 5 }, (_, i) => fetch(`https://weather.test/${i}`));
  assert.equal(await (await fetch('https://other.test')).text(), 'other');
  await Promise.all(requests);
  assert.equal(peak, 2);
  for (let i = 1; i < starts.length; i += 1) assert.ok(starts[i] - starts[i - 1] >= 13);
});

test('queued cancellation and queue overflow do not consume a request or strand permits', async () => {
  let finish;
  let calls = 0;
  const fetch = createProviderFetch({ minIntervalMs: 0, maxConcurrent: 1, maxQueueSize: 1,
    fetch: async () => {
      calls += 1;
      if (calls === 1) await new Promise(resolve => { finish = resolve; });
      return new Response('ok');
    },
  });
  const first = fetch('https://weather.test/one');
  await pause(0);
  const controller = new AbortController();
  const queued = fetch('https://weather.test/two', { signal: controller.signal });
  const cancelled = assert.rejects(queued, { name: 'AbortError' });
  await assert.rejects(fetch('https://weather.test/overflow'), /queue is full/);
  controller.abort();
  await cancelled;
  finish();
  await first;
  assert.equal((await fetch('https://weather.test/three')).status, 200);
  assert.equal(calls, 2);
});

test('caller cancellation interrupts backoff and a signal-ignoring custom fetch', async () => {
  let calls = 0;
  const fetch = fast(async () => {
    calls += 1;
    return new Response(null, { status: 429, headers: { 'Retry-After': '60' } });
  });
  const controller = new AbortController();
  const pending = assert.rejects(fetch('https://weather.test', { signal: controller.signal }), { name: 'AbortError' });
  await pause(5);
  controller.abort();
  await pending;
  assert.equal(calls, 1);
  const hung = fast(() => new Promise(() => {}));
  await assert.rejects(hung('https://weather.test', { signal: AbortSignal.timeout(15) }), { name: 'TimeoutError' });
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(fetch('https://weather.test', { signal: aborted.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('attempt timeouts retry within the total budget and late responses are cancelled', async () => {
  let calls = 0;
  let cancelled = 0;
  const fetch = createProviderFetch({ minIntervalMs: 0, baseDelayMs: 0, attemptTimeoutMs: 10, maxElapsedMs: 200,
    fetch: async () => {
      if (++calls > 1) return new Response('recovered');
      await pause(50);
      return new Response(new ReadableStream({ cancel() { cancelled += 1; } }));
    },
  });
  assert.equal(await (await fetch('https://weather.test')).text(), 'recovered');
  await pause(60);
  assert.equal(calls, 2);
  assert.equal(cancelled, 1);
});

test('a successful stream is returned unchanged and is never replayed on body failure', async () => {
  let calls = 0;
  const response = new Response(new ReadableStream({ start(controller) { controller.error(new Error('stream broke')); } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  const fetch = fast(async () => { calls += 1; return response; });
  const result = await fetch('https://weather.test/live');
  assert.equal(result, response);
  await assert.rejects(result.text(), /stream broke/);
  assert.equal(calls, 1);
});

test('origin overrides and invalid configuration are handled before network access', async () => {
  for (const options of [
    { maxAttempts: 0 }, { maxAttempts: 1.5 }, { maxConcurrent: 0 }, { minIntervalMs: -1 },
    { maxQueueSize: 0 }, { maxElapsedMs: Infinity }, { attemptTimeoutMs: 2 ** 32 },
    { origins: { 'https://weather.test/path': {} } },
  ]) assert.throws(() => createProviderFetch(options));
  const starts = [];
  const fetch = createProviderFetch({ minIntervalMs: 1000, origins: { 'https://weather.test': { minIntervalMs: 0 } },
    fetch: async () => { starts.push(Date.now()); return new Response('ok'); },
  });
  await fetch('https://weather.test/one');
  await fetch('https://weather.test/two');
  assert.ok(starts[1] - starts[0] < 500);
});

test('environment defaults share limiter state, and explicit transports are not wrapped again', async () => {
  const mock = async () => new Response('ok');
  assert.equal(resolveEnvironment({ fetch: mock }).fetch, resolveEnvironment({ fetch: mock }).fetch);
  assert.equal(resolveEnvironment().fetch, resolveEnvironment().fetch);
  const managed = fast(mock);
  assert.equal(resolveEnvironment({ fetch: managed }).fetch, managed);
  let calls = 0;
  const retrying = fast(async () => { calls += 1; return new Response(null, { status: 503 }); });
  await assert.rejects(fetchUpstreamText(resolveEnvironment({ fetch: retrying, cache: memoryCache() }), {
    url: 'https://weather.test', cacheKey: 'transport-fixture', cacheTtlSeconds: 1, subject: 'fixture',
  }));
  assert.equal(calls, 3);
});

test('public adapter and handler entry points inject retries into upstream loaders', async () => {
  const metadata = { id: 'fixture', name: 'fixture', latitude: 40, longitude: 44, elevationM: 100, timeZone: 'UTC', pageUrl: null,
    capabilities: { gustLull: false, temperature: false, conditions: false, history: false },
    samplingWindowSeconds: null, recommendedPollSeconds: 60, sourceLabel: 'fixture',
  };
  const adapter = defineStationAdapter({ meta: () => metadata, load: async (_, { environment }) => {
    await environment.fetch('https://weather.test/adapter');
    throw new Error('No observation needed for this transport test');
  } });
  let calls = 0;
  const mock = async () => new Response(null, { status: ++calls % 2 === 1 ? 503 : 200 });
  await adapter({}, { environment: { ...quiet, fetch: mock } });
  assert.equal(calls, 2);
  const station = { vendor: 'custom', id: 'fixture', name: 'fixture', async load({ environment }) {
    await environment.fetch('https://weather.test/custom');
    throw new Error('No observation needed for this transport test');
  } };
  const environment = { ...quiet, fetch: mock };
  const current = await loadStationCurrent({ stations: [station], stationId: 'fixture', environment });
  assert.equal(current.station.status, 'unavailable');
  assert.equal(calls, 4);
  const handler = createStationFeedHandler({ stations: [station], environment });
  assert.equal((await handler(new Request('https://app.test/current?station=fixture'))).status, 200);
  assert.equal(calls, 6);
});
