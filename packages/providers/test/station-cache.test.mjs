import assert from 'node:assert/strict';
import test from 'node:test';
import { unavailableStation } from '@azohra/meteo.station';
import { createStationsApiHandler, createProviderFetch } from '../dist/index.js';
import { createStationCache } from '../dist/station-cache.js';

const anchor = Date.parse('2026-11-05T12:00:00Z');
const quiet = { logger: () => {} };
const request = path => new Request(`https://stations.test/api/stations/${path}`);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const station = (id = '1', overrides = {}) => ({
  uid: `climatenet:${id}`, vendor: 'climatenet', nativeId: id, name: id,
  latitude: 40, longitude: 44, elevationM: null, country: 'AM', region: null,
  timeZone: 'UTC', pageUrl: null,
  capabilities: { gustLull: false, temperature: true, conditions: false, history: true },
  samplingWindowSeconds: null, recommendedPollSeconds: 60, locator: {}, ...overrides,
});
const catalogue = stations => ({ schemaVersion: 1, generatedAt: '2026-11-05T00:00:00Z', regions: ['AM'], stations });
const observation = (meta = station(), speed = 3) => ({
  id: meta.uid, name: meta.name, sourceLabel: 'fixture', pageUrl: meta.pageUrl,
  latitude: meta.latitude, longitude: meta.longitude, elevationM: meta.elevationM,
  timeZone: meta.timeZone, capabilities: meta.capabilities,
  samplingWindowSeconds: meta.samplingWindowSeconds, recommendedPollSeconds: meta.recommendedPollSeconds,
  status: 'ok', history: null,
  reading: {
    observedAt: '2026-11-05T11:59:00.000Z', windAvgMps: speed, windDirectionDeg: 180,
    windGustMps: null, windLullMps: null, temperatureC: null, windChillC: null, conditions: null,
  },
  telemetry: null, samples: null, recentSummaries: null,
});
const storage = () => {
  const values = new Map();
  const writes = [];
  return {
    values, writes,
    async get(key) { return values.get(key) ?? null; },
    async put(key, value, ttl) { values.set(key, value); writes.push({ key, value, ttl }); },
  };
};
const fast = fetch => createProviderFetch({ fetch, minIntervalMs: 0, maxAttempts: 1 });

test('soft expiry serves immediately and leases one background refresh per key', { timeout: 1000 }, async () => {
  let now = anchor;
  let loads = 0;
  const cache = createStationCache({ ...quiet, now: () => new Date(now), cache: storage() }, { freshSeconds: 2, maxAgeSeconds: 5 });
  const meta = station();
  const load = async () => observation(meta, ++loads);
  assert.equal((await cache.read('one', meta, load)).state, 'fill');
  now += 1999;
  assert.equal((await cache.read('one', meta, load)).state, 'hit');
  assert.equal(loads, 1);

  now += 1;
  const pending = deferred();
  const tasks = [];
  const context = { waitUntil: task => tasks.push(task) };
  const refresh = () => { loads += 1; return pending.promise; };
  const stale = await cache.read('one', meta, refresh, context);
  assert.equal(stale.state, 'stale');
  assert.equal(stale.station.reading.windAvgMps, 1);
  assert.equal((await cache.read('one', meta, refresh, context)).state, 'stale');
  assert.equal(loads, 2);
  assert.equal(tasks.length, 1);

  pending.resolve(observation(meta, 2));
  await Promise.all(tasks);
  const refreshed = await cache.read('one', meta, load);
  assert.equal(refreshed.state, 'hit');
  assert.equal(refreshed.station.reading.windAvgMps, 2);
  assert.equal(loads, 2);
});

test('refresh failures preserve last-good data without extending its hard expiry', async () => {
  let now = anchor;
  const store = storage();
  const cache = createStationCache({ ...quiet, now: () => new Date(now), cache: store }, { freshSeconds: 2, maxAgeSeconds: 5 });
  const meta = station();
  const good = observation(meta);
  await cache.read('one', meta, async () => good);
  const unavailable = unavailableStation(good, 'upstream_error');
  now += 2000;
  const stale = await cache.read('one', meta, async () => unavailable);
  assert.equal(stale.state, 'stale');
  assert.deepEqual(stale.station, good);
  now += 2999;
  const failed = await cache.read('one', meta, async () => { throw new Error('Offline'); });
  assert.equal(failed.state, 'stale');
  assert.equal(store.writes.length, 1);
  assert.equal(store.writes[0].ttl, 5);
  now += 1;
  const expired = await cache.read('one', meta, async () => unavailable);
  assert.equal(expired.state, 'miss');
  assert.equal(expired.station.status, 'unavailable');
  await assert.rejects(cache.read('one', meta, async () => { throw new Error('Offline'); }), /Offline/);
});

test('failed background refreshes cool down without extending retained observations', async () => {
  let now = anchor;
  let loads = 0;
  const store = storage();
  const tasks = [];
  const context = { waitUntil: task => tasks.push(task) };
  const cache = createStationCache({ ...quiet, now: () => new Date(now), cache: store }, { freshSeconds: 2, maxAgeSeconds: 5 });
  const good = observation();
  const load = async () => {
    loads += 1;
    if (loads === 1) return good;
    if (loads === 3) throw new Error('Offline');
    return unavailableStation(good, 'upstream_error');
  };
  await cache.read('one', station(), load);
  now += 2000;
  assert.equal((await cache.read('one', station(), load, context)).state, 'stale');
  await Promise.all(tasks.splice(0));
  assert.equal(loads, 2);
  now += 1999;
  assert.deepEqual((await cache.read('one', station(), load, context)).station, good);
  assert.equal(loads, 2, 'polls during the refresh interval must not retry a failed source');
  assert.equal(tasks.length, 0);
  now += 1;
  assert.equal((await cache.read('one', station(), load, context)).state, 'stale');
  await Promise.all(tasks.splice(0));
  assert.equal(loads, 3);
  assert.equal(store.writes.length, 1);
  assert.equal(JSON.parse(store.writes[0].value).staleUntil, anchor + 5000);
  now += 1000;
  const expired = await cache.read('one', station(), load, context);
  assert.equal(expired.state, 'miss');
  assert.equal(expired.station.status, 'unavailable', 'a failure cooldown cannot keep expired data available');
  assert.equal(loads, 4);
});

test('durable snapshots share success across cache instances and reject expired or malformed entries', async () => {
  let now = anchor;
  const store = storage();
  const env = { ...quiet, now: () => new Date(now), cache: store };
  await createStationCache(env, { freshSeconds: 2, maxAgeSeconds: 5 }).read('one', station(), async () => observation());
  const restored = await createStationCache(env, { freshSeconds: 2, maxAgeSeconds: 5 })
    .read('one', station(), async () => { throw new Error('Must reuse stored snapshot'); });
  assert.equal(restored.state, 'hit');
  now += 5000;
  const unavailable = unavailableStation(observation(), 'upstream_error');
  assert.equal((await createStationCache(env).read('one', station(), async () => unavailable)).station.status, 'unavailable');
  store.values.set('one', '{broken');
  assert.equal((await createStationCache(env).read('one', station(), async () => observation())).state, 'fill');
});

test('zero retention disables cache I/O and zero fresh time revalidates retained data', async () => {
  let loads = 0;
  const forbidden = () => { throw new Error('Disabled caches must not perform I/O'); };
  const disabled = createStationCache({ ...quiet, cache: { get: forbidden, put: forbidden } }, { freshSeconds: 0, maxAgeSeconds: 0 });
  for (let i = 0; i < 2; i++) {
    assert.equal((await disabled.read('one', station(), async () => observation(station(), ++loads))).state, 'miss');
  }
  assert.equal(loads, 2);
  const cache = createStationCache({ ...quiet, now: () => new Date(anchor), cache: storage() }, { freshSeconds: 0, maxAgeSeconds: 5 });
  await cache.read('one', station(), async () => observation());
  const stale = await cache.read('one', station(), async () => unavailableStation(observation(), 'upstream_error'));
  assert.equal(stale.state, 'stale');
});

test('sonic overrides and invalid policy values are enforced at the boundary', async () => {
  let now = anchor;
  const cache = createStationCache({ ...quiet, now: () => new Date(now), cache: storage() }, {
    freshSeconds: 2, maxAgeSeconds: 5, sonicFreshSeconds: 1, sonicMaxAgeSeconds: 3,
  });
  const sonic = station('sonic', { recommendedPollSeconds: 15 });
  await cache.read('sonic', sonic, async () => observation(sonic));
  now += 1000;
  assert.equal((await cache.read('sonic', sonic, async () => unavailableStation(observation(sonic), 'upstream_error'))).state, 'stale');
  now += 2000;
  assert.equal((await cache.read('sonic', sonic, async () => unavailableStation(observation(sonic), 'upstream_error'))).state, 'miss');
  for (const policy of [
    { freshSeconds: -1 }, { maxAgeSeconds: NaN }, { sonicFreshSeconds: Infinity },
    { freshSeconds: 5, maxAgeSeconds: 2 }, { sonicFreshSeconds: 5, sonicMaxAgeSeconds: 2 }, { cacheTimeoutMs: -1 },
  ]) assert.throws(() => createStationCache(undefined, policy), RangeError);
});

test('cache rejection and stalled cache operations cannot prevent a successful reading', { timeout: 1000 }, async () => {
  for (const stalled of [false, true]) {
    const fail = () => stalled ? new Promise(() => {}) : Promise.reject(new Error('Cache offline'));
    const cache = createStationCache({ ...quiet, cache: { get: fail, put: fail } }, { cacheTimeoutMs: 2 });
    assert.equal((await cache.read('one', station(), async () => observation())).station.status, 'ok');
    assert.equal((await cache.read('one', station(), async () => { throw new Error('L1 must survive store failure'); })).state, 'hit');
  }
});

test('current, overlapping feeds and GeoJSON share snapshots while preserving order and response time', async () => {
  let now = anchor;
  const urls = [];
  let document = catalogue(['1', '2', '3'].map(id => station(id)));
  const handler = createStationsApiHandler({
    catalogue: () => document, basePath: '/api/stations',
    environment: {
      ...quiet, cache: storage(), now: () => new Date(now), fetch: fast(async input => {
        urls.push(String(input));
        return new Response(JSON.stringify([{ time: '2026-11-05T11:59:00', speed: 3, direction: 'S', temperature: 10 }]));
      }),
    },
  });
  const first = await handler(request('feed?ids=climatenet:1,climatenet:2,climatenet:3&history=0'));
  const initial = await first.json();
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  assert.equal(urls.length, 3);
  now += 1000;
  const reordered = await handler(request('feed?ids=climatenet:1,climatenet:3,climatenet:2&history=0'));
  const feed = await reordered.json();
  assert.equal(reordered.headers.get('X-Station-Cache'), 'hit');
  assert.deepEqual(feed.stations.map(entry => entry.id), ['climatenet:1', 'climatenet:3', 'climatenet:2']);
  assert.equal(feed.servedAt, new Date(now).toISOString());
  assert.equal(feed.stations[0].reading.observedAt, initial.stations[0].reading.observedAt);
  assert.equal(feed.stations.every(entry => entry.history === null), true);
  const current = await handler(request('current?station=climatenet:2'));
  assert.equal(current.headers.get('X-Station-Cache'), 'hit');
  assert.equal((await current.json()).station.status, 'ok');
  const geojson = await handler(request('feed?ids=climatenet:2&history=0&format=geojson'));
  assert.equal(geojson.headers.get('X-Station-Cache'), 'hit');
  assert.equal((await geojson.json()).features[0].properties.windAvgMps, 3);
  assert.equal(urls.length, 3, 'all representations reuse current station snapshots');

  document = { ...document, generatedAt: '2026-11-05T01:00:00Z', stations: document.stations.map(entry => ({ ...entry, name: `Updated ${entry.name}` })) };
  const revised = await handler(request('current?station=climatenet:2'));
  assert.equal(revised.headers.get('X-Station-Cache'), 'fill');
  assert.equal((await revised.json()).station.name, 'Updated 2');
});

test('API stale reads return retained observations while one host-owned refresh is pending', { timeout: 1000 }, async () => {
  let now = anchor;
  let fetches = 0;
  const store = storage();
  const pending = deferred();
  const tasks = [];
  const handler = createStationsApiHandler({
    catalogue: catalogue([station()]), basePath: '/api/stations',
    cachePolicy: { freshSeconds: 1, maxAgeSeconds: 5 },
    environment: {
      ...quiet, now: () => new Date(now),
      cache: {
        get: key => key.startsWith('station/') ? store.get(key) : Promise.resolve(null),
        put: (key, value, ttl) => key.startsWith('station/') ? store.put(key, value, ttl) : Promise.resolve(),
      },
      fetch: fast(async () => {
        if (++fetches === 2) await pending.promise;
        return new Response(JSON.stringify([{ time: '2026-11-05T11:59:00', speed: fetches === 1 ? 3 : 6, direction: 'S' }]));
      }),
    },
  });
  const first = await (await handler(request('current?station=climatenet:1'))).json();
  now += 1000;
  const context = { waitUntil: task => tasks.push(task) };
  const stale = await handler(request('current?station=climatenet:1'), context);
  const body = await stale.json();
  assert.equal(stale.headers.get('X-Station-Cache'), 'stale');
  assert.equal(body.station.reading.windAvgMps, 3);
  assert.equal(body.station.reading.observedAt, first.station.reading.observedAt);
  assert.equal(body.servedAt, new Date(now).toISOString());
  const overlapping = await handler(request('feed?ids=climatenet:1&history=0'), context);
  assert.equal(overlapping.headers.get('X-Station-Cache'), 'stale');
  assert.equal(fetches, 2);
  pending.resolve();
  await Promise.all(tasks);
  const refreshed = await (await handler(request('current?station=climatenet:1'))).json();
  assert.equal(refreshed.station.reading.windAvgMps, 6);
  assert.equal(fetches, 2);
});

test('history windows stay separate from current snapshots and equivalent hours share a key', async () => {
  const handler = createStationsApiHandler({
    catalogue: catalogue([station()]), basePath: '/api/stations',
    environment: { ...quiet, cache: storage(), now: () => new Date(anchor), fetch: fast(async input => new Response(JSON.stringify(
      String(input).includes('/graph/')
        ? [{ time_interval: '2026-11-05T11:58:00', speed: 2, direction: 'S' }, { time_interval: '2026-11-05T11:59:00', speed: 3, direction: 'S' }]
        : [{ time: '2026-11-05T11:59:00', speed: 3, direction: 'S' }],
    ))) },
  });
  const full = await handler(request('feed?ids=climatenet:1&hours=1'));
  assert.equal((await full.json()).stations[0].history.points.length, 2);
  assert.equal((await handler(request('feed?ids=climatenet:1&hours=1.0'))).headers.get('X-Station-Cache'), 'hit');
  assert.equal((await handler(request('feed?ids=climatenet:1&hours=2'))).headers.get('X-Station-Cache'), 'fill');
  const current = await handler(request('feed?ids=climatenet:1&history=0'));
  assert.equal(current.headers.get('X-Station-Cache'), 'fill');
  assert.equal((await current.json()).stations[0].history, null);
  assert.equal((await handler(request('feed?ids=climatenet:1&hours=NaN'))).status, 400);
});

test('shared storage never reuses station snapshots across credentials or cache policies', async () => {
  const store = storage();
  const meta = station('PWS', { uid: 'wunderground:PWS', vendor: 'wunderground' });
  const keys = [];
  const environment = { ...quiet, cache: store, now: () => new Date(anchor), fetch: fast(async input => {
    const key = new URL(String(input)).searchParams.get('apiKey');
    keys.push(key);
    return new Response(JSON.stringify({ observations: [{ stationID: 'PWS', obsTimeUtc: '2026-11-05T11:59:00Z', winddir: 180,
      metric_si: { windSpeed: key === 'first-secret' ? 3 : 6 } }] }));
  }) };
  const create = (wuApiKey, cachePolicy) => createStationsApiHandler({
    catalogue: catalogue([meta]), basePath: '/api/stations', environment, credentials: { wuApiKey }, cachePolicy,
  });
  for (const [secret, speed] of [['first-secret', 3], ['second-secret', 6]]) {
    const response = await create(secret)(request('current?station=wunderground:PWS'));
    assert.equal(response.headers.get('X-Station-Cache'), 'fill');
    assert.equal((await response.json()).station.reading.windAvgMps, speed);
  }
  const scoped = await create('first-secret', { freshSeconds: 1 })(request('current?station=wunderground:PWS'));
  assert.equal(scoped.headers.get('X-Station-Cache'), 'fill');
  const missing = await create(undefined)(request('current?station=wunderground:PWS'));
  assert.equal((await missing.json()).station.reason, 'not_configured');
  assert.deepEqual(keys, ['first-secret', 'second-secret']);
  assert.ok([...store.values.keys()].every(key => !key.includes('first-secret') && !key.includes('second-secret')));
});
