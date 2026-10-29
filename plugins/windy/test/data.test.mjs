import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogueIndex, createStationsClient } from '@stations/client';
import { pilotFreshness } from '@stations/contracts';
import { createWindyData, selectWindyStations } from '../src/data.ts';

const capabilities = { gustLull: true, temperature: true, conditions: false, history: true };
const servedAt = '2026-10-26T12:00:30Z';
const box = { west: -180, south: -90, east: 180, north: 90 };
const station = (id, longitude = 0, latitude = 0) => ({
  uid: id, vendor: 'windnerd', nativeId: id, name: id, latitude, longitude,
  elevationM: null, country: null, region: null, timeZone: null, pageUrl: null,
  capabilities, samplingWindowSeconds: 60, recommendedPollSeconds: 60, locator: {},
});
const document = stations => ({ schemaVersion: 1, generatedAt: servedAt, regions: [], stations });
const ok = id => ({
  id, name: id, sourceLabel: 'Test', pageUrl: null, latitude: 0, longitude: 0,
  timeZone: null, elevationM: null, capabilities, samplingWindowSeconds: 60,
  recommendedPollSeconds: 60, status: 'ok',
  reading: { observedAt: '2026-10-26T12:00:00Z', windAvgMps: 0, windDirectionDeg: 0, windGustMps: null, windLullMps: null, temperatureC: null, windChillC: null, conditions: null },
  history: null,
});
const feed = stations => ({ data: { schemaVersion: 1, servedAt, primaryStationId: null, stations }, error: null });
const failure = { data: null, error: { kind: 'http', message: 'busy', status: 429 } };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function clock() {
  let time = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => time,
    random: () => 0,
    setTimeout(fn, delay) { const key = ++id; timers.set(key, { at: time + delay, fn }); return key; },
    clearTimeout(key) { timers.delete(key); },
    async advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      time = end;
      await flush();
    },
    count: () => timers.size,
  };
}
function setup(stations, loadFeedResult = async query => feed(query.ids.map(ok))) {
  const timer = clock();
  const changes = [];
  const calls = [];
  const client = {
    async loadCatalogueResult(query, request) { calls.push({ route: 'catalogue', query, request }); return { data: document(stations), error: null }; },
    loadFeedResult(query, request) { calls.push({ route: 'feed', query, request }); return loadFeedResult(query, request); },
  };
  const store = createWindyData({ client, onChange: value => changes.push(value), ...timer });
  return { store, timer, changes, calls, client };
}

test('selection handles wrapped, dateline, world bounds, filters and unique stable nearest 100', () => {
  const entries = [station('west', -179), station('east', 179), station('edge', 180), station('middle', 0)];
  const index = createCatalogueIndex(document([...entries, entries[0]]));
  for (const bounds of [
    { west: 170, east: -170, south: -10, north: 10 },
    { west: 170, east: 190, south: -10, north: 10 },
    { west: -190, east: -170, south: -10, north: 10 },
  ]) assert.deepEqual(new Set(selectWindyStations(index, bounds).stations.map(item => item.uid)), new Set(['west', 'east', 'edge']));
  for (const bounds of [box, { ...box, west: 10, east: 370 }, { ...box, west: 180, east: -180 }]) {
    assert.equal(selectWindyStations(index, bounds).visibleTotal, 4);
  }
  assert.equal(selectWindyStations(index, box, 'marine').visibleTotal, 0);
  const many = Array.from({ length: 110 }, (_, i) => station(String(i).padStart(3, '0'))).reverse();
  const selection = selectWindyStations(createCatalogueIndex(document(many)), box);
  assert.equal(selection.visibleTotal, 110);
  assert.deepEqual(selection.stations.map(item => item.uid), Array.from({ length: 100 }, (_, i) => String(i).padStart(3, '0')));
});

for (const size of [0, 1, 25, 26, 100, 101]) {
  test(`loads ${size} stations in bounded batches`, async () => {
    const stations = Array.from({ length: size }, (_, i) => station(`s${i}`));
    const { store, calls } = setup(stations);
    store.setViewport(box);
    assert.equal(calls.length, 0);
    store.resume();
    await flush();
    const feedCalls = calls.filter(call => call.route === 'feed');
    assert.equal(feedCalls.length, Math.ceil(Math.min(size, 100) / 25));
    assert.equal(store.getSnapshot().visibleTotal, size);
    assert.equal(store.getSnapshot().selectedCount, Math.min(size, 100));
    assert.equal(store.getSnapshot().capped, size > 100);
    for (const call of feedCalls) {
      assert.equal(call.query.history, false);
      assert.equal(call.query.limit, 25);
      assert.ok(call.query.ids.length <= 25);
      assert.equal(call.request.timeoutMs, 15_000);
    }
    assert.ok(store.getSnapshot().entries.every(entry => entry.status === 'ok'));
    store.destroy();
  });
}

test('caps concurrency across cancelled generations and ignores late results', async () => {
  const requests = [];
  const { store, timer } = setup(Array.from({ length: 100 }, (_, i) => station(`s${i}`)), (query, request) => {
    const pending = deferred();
    requests.push({ query, request, ...pending });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  assert.equal(requests.length, 2);
  store.setViewport({ west: -1, east: 1, south: -1, north: 1 });
  assert.ok(requests.every(request => request.request.signal.aborted));
  await timer.advance(300);
  assert.equal(requests.length, 2);
  requests[0].resolve(feed(requests[0].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 3);
  assert.ok(store.getSnapshot().entries.every(entry => entry.observation === null));
  requests[1].resolve(feed(requests[1].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 4);
  store.destroy();
  requests[2].resolve(feed(requests[2].query.ids.map(ok)));
  requests[3].resolve(feed(requests[3].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 4);
  assert.equal(timer.count(), 0);
});

test('automatic refresh starts sixty seconds after the full cycle settles', async () => {
  const pending = deferred();
  let requests = 0;
  const { store, timer } = setup([station('a')], async query => {
    requests++;
    return requests === 1 ? pending.promise : feed(query.ids.map(ok));
  });
  store.setViewport(box);
  store.resume();
  await flush();
  await timer.advance(30_000);
  assert.equal(requests, 1);
  pending.resolve(feed([ok('a')]));
  await flush();
  await timer.advance(59_999);
  assert.equal(requests, 1);
  await timer.advance(1);
  assert.equal(requests, 2);
  store.destroy();
});

test('partial failure and missing results retain successful observations and age', async () => {
  let round = 0;
  const { store, timer } = setup(Array.from({ length: 26 }, (_, i) => station(`s${String(i).padStart(2, '0')}`)), async query => {
    if (round === 0) return feed(query.ids.map(ok));
    if (query.ids.length === 1) return failure;
    return feed(query.ids.slice(1).map(ok));
  });
  store.setViewport(box);
  store.resume();
  await flush();
  const before = store.getSnapshot().entries[0];
  assert.equal(before.observation.reading.windAvgMps, 0);
  assert.equal(before.observation.reading.windDirectionDeg, 0);
  round++;
  await timer.advance(60_000);
  const entries = store.getSnapshot().entries;
  assert.equal(entries[0].status, 'unavailable');
  assert.equal(entries[0].observation.reading.windAvgMps, 0);
  assert.equal(entries[25].status, 'refresh-failed');
  assert.equal(entries[25].error.status, 429);
  assert.equal(entries[25].servedAt, servedAt);
  assert.equal(entries[25].receivedAtMs, 0);
  assert.equal(store.getSnapshot().degraded, true);
  assert.equal(pilotFreshness({ observedAt: entries[25].observation.reading.observedAt, servedAt, receivedAtMs: 0, nowMs: 1_000_000 }, entries[25].station), 'stale');
  store.destroy();
});

test('failed batches back off and refresh clicks coalesce without bypassing retry', async () => {
  const pending = deferred();
  let calls = 0;
  const { store, timer } = setup([station('a')], () => { calls++; return calls === 1 ? pending.promise : Promise.resolve(failure); });
  store.setViewport(box);
  store.resume();
  await flush();
  store.refresh();
  store.refresh();
  assert.equal(calls, 1);
  pending.resolve(failure);
  await flush();
  store.refresh();
  await timer.advance(59_999);
  assert.equal(calls, 1);
  await timer.advance(1);
  assert.equal(calls, 2);
  await timer.advance(119_999);
  assert.equal(calls, 2);
  await timer.advance(1);
  assert.equal(calls, 3);
  store.destroy();
});

test('a failed batch backs off without slowing successful stations', async () => {
  const requests = [];
  const { store, timer } = setup(Array.from({ length: 26 }, (_, i) => station(`s${String(i).padStart(2, '0')}`)), async query => {
    requests.push({ ids: query.ids, at: timer.now() });
    return query.ids.length === 1 ? failure : feed(query.ids.map(ok));
  });
  store.setViewport(box);
  store.resume();
  await flush();
  await timer.advance(60_000);
  await timer.advance(60_000);
  assert.deepEqual(requests.filter(call => call.ids.length === 25).map(call => call.at), [0, 60_000, 120_000]);
  assert.deepEqual(requests.filter(call => call.ids.length === 1).map(call => call.at), [0, 60_000]);
  await timer.advance(60_000);
  assert.deepEqual(requests.filter(call => call.ids.length === 1).map(call => call.at), [0, 60_000, 180_000]);
  store.destroy();
});

test('manual refresh respects recently checked station budgets', async () => {
  const { store, timer, calls } = setup([station('a')]);
  store.setViewport(box);
  store.resume();
  await flush();
  for (let i = 0; i < 10; i++) {
    store.refresh();
    await flush();
  }
  assert.equal(calls.filter(call => call.route === 'feed').length, 1);
  await timer.advance(60_000);
  assert.equal(calls.filter(call => call.route === 'feed').length, 2);
  store.destroy();
});

test('pans reuse checked data, fetch new ids, and expire after 60 seconds', async () => {
  const { store, timer, calls } = setup([station('a', 0), station('b', 10)]);
  store.setViewport({ west: -1, east: 1, south: -1, north: 1 });
  store.resume();
  await flush();
  store.setViewport({ west: -1, east: 11, south: -1, north: 1 });
  await timer.advance(300);
  const feeds = calls.filter(call => call.route === 'feed');
  assert.deepEqual(feeds.map(call => call.query.ids), [['a'], ['b']]);
  await timer.advance(60_000);
  assert.equal(feeds.length + 1, calls.filter(call => call.route === 'feed').length);
  assert.deepEqual(new Set(calls.at(-1).query.ids), new Set(['a', 'b']));
  store.destroy();
});

test('observation LRU evicts offscreen entries after 500 unique stations', async () => {
  const stations = Array.from({ length: 600 }, (_, i) => station(`s${i}`, Math.floor(i / 100) * 10));
  const { store, timer, calls } = setup(stations);
  const viewport = group => ({ west: group * 10 - 1, east: group * 10 + 1, south: -1, north: 1 });
  store.setViewport(viewport(0));
  store.resume();
  await flush();
  for (let group = 1; group < 6; group++) {
    store.setViewport(viewport(group));
    await timer.advance(300);
    assert.equal(store.getSnapshot().entries.length, 100);
  }
  assert.equal(calls.filter(call => call.route === 'feed').length, 24);
  store.setViewport(viewport(0));
  await timer.advance(300);
  assert.equal(calls.filter(call => call.route === 'feed').length, 28);
  store.destroy();
});

test('malformed station result is a failed refresh and retains previous data', async () => {
  let malformed = false;
  const { store, timer } = setup([station('a')], async () => feed([malformed ? { id: 'a', status: 'ok' } : ok('a')]));
  store.setViewport(box);
  store.resume();
  await flush();
  malformed = true;
  await timer.advance(60_000);
  const entry = store.getSnapshot().entries[0];
  assert.equal(entry.status, 'refresh-failed');
  assert.equal(entry.error.kind, 'parse');
  assert.equal(entry.observation.reading.windAvgMps, 0);
  store.destroy();
});

test('explicit unavailable results preserve their reason and last successful reading', async () => {
  let available = true;
  let serviceFailed = false;
  const { store, timer } = setup([station('a')], async () => {
    if (serviceFailed) return failure;
    const result = ok('a');
    return feed([available ? result : { ...result, status: 'unavailable', reason: 'upstream_error', reading: null }]);
  });
  store.setViewport(box);
  store.resume();
  await flush();
  available = false;
  await timer.advance(60_000);
  const entry = store.getSnapshot().entries[0];
  assert.equal(entry.status, 'unavailable');
  assert.equal(entry.unavailable.reason, 'upstream_error');
  assert.equal(entry.observation.reading.windAvgMps, 0);
  assert.equal(entry.receivedAtMs, 0);
  serviceFailed = true;
  await timer.advance(60_000);
  assert.equal(store.getSnapshot().entries[0].status, 'refresh-failed');
  assert.equal(store.getSnapshot().entries[0].unavailable.reason, 'upstream_error');
  store.destroy();
});

test('suspending a pending catalogue ignores late completion and reloads on resume', async () => {
  const timer = clock();
  const requests = [];
  const store = createWindyData({ ...timer, onChange() {}, client: {
    loadCatalogueResult(_query, request) {
      const pending = deferred();
      requests.push({ ...pending, request });
      return pending.promise;
    },
    async loadFeedResult(query) { return feed(query.ids.map(ok)); },
  } });
  store.setViewport(box);
  store.resume();
  store.suspend();
  assert.equal(requests[0].request.signal.aborted, true);
  requests[0].resolve({ data: document([station('old')]), error: null });
  await flush();
  assert.equal(store.getSnapshot().catalogueStatus, 'idle');
  store.resume();
  requests[1].resolve({ data: document([station('new')]), error: null });
  await flush();
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.station.uid), ['new']);
  store.destroy();
});

test('catalogue failure requires explicit retry and background refresh preserves metadata', async () => {
  const timer = clock();
  let catalogues = 0;
  let feeds = 0;
  const store = createWindyData({ ...timer, onChange() {}, client: {
    async loadCatalogueResult() { catalogues++; return catalogues === 2 ? { data: document([station('a')]), error: null } : failure; },
    async loadFeedResult(query) { feeds++; return feed(query.ids.map(ok)); },
  } });
  store.setViewport(box);
  store.resume();
  await flush();
  assert.equal(store.getSnapshot().catalogueStatus, 'error');
  await timer.advance(100_000);
  assert.equal(catalogues, 1);
  assert.equal(feeds, 0);
  store.refresh();
  await flush();
  assert.equal(store.getSnapshot().catalogueStatus, 'ready');
  assert.equal(feeds, 1);
  await timer.advance(86_400_000);
  assert.equal(catalogues, 3);
  assert.equal(store.getSnapshot().catalogueStatus, 'ready');
  assert.equal(store.getSnapshot().catalogueError.status, 429);
  assert.equal(store.getSnapshot().selectedCount, 1);
  store.destroy();
});

test('catalogue retry deadline survives suspension and resumes immediately when overdue', async () => {
  const timer = clock();
  const calls = [];
  const store = createWindyData({ ...timer, onChange() {}, client: {
    async loadCatalogueResult() {
      calls.push(timer.now());
      return calls.length === 1 ? { data: document([]), error: null } : failure;
    },
    async loadFeedResult() { return feed([]); },
  } });
  store.resume();
  await flush();
  await timer.advance(86_400_000);
  assert.equal(calls.length, 2);
  store.suspend();
  await timer.advance(10_000);
  store.resume();
  await flush();
  assert.equal(calls.length, 2);
  await timer.advance(49_999);
  assert.equal(calls.length, 2);
  await timer.advance(1);
  assert.equal(calls.length, 3);
  store.suspend();
  await timer.advance(120_001);
  store.resume();
  await flush();
  assert.equal(calls.length, 4);
  store.destroy();
});

test('suspend and destroy cancel work, clear timers, and resume expired entries', async () => {
  const requests = [];
  const { store, timer } = setup([station('a')], (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  store.suspend();
  assert.equal(requests[0].request.signal.aborted, true);
  assert.equal(timer.count(), 0);
  requests[0].resolve(feed([ok('a')]));
  await flush();
  assert.equal(store.getSnapshot().entries[0].observation, null);
  store.resume();
  await flush();
  assert.equal(requests.length, 2);
  requests[1].resolve(feed([ok('a')]));
  await flush();
  assert.equal(store.getSnapshot().entries[0].status, 'ok');
  store.suspend();
  await timer.advance(60_001);
  store.resume();
  await flush();
  assert.equal(requests.length, 3);
  store.destroy();
  assert.equal(requests[2].request.signal.aborted, true);
  assert.equal(timer.count(), 0);
});

test('real client requests only catalogue during initial load', async () => {
  const urls = [];
  const client = createStationsClient({ baseUrl: 'https://example.test/api/stations', fetch: async url => {
    urls.push(String(url));
    return new Response(JSON.stringify(document([])), { status: 200 });
  } });
  assert.equal(new URL(client.endpointUrl('feed', { ids: ['a'], limit: 25, history: false })).searchParams.get('history'), '0');
  const store = createWindyData({ client, onChange() {} });
  store.resume();
  for (let i = 0; i < 10 && store.getSnapshot().catalogueStatus !== 'ready'; i++) await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(urls, ['https://example.test/api/stations/catalogue']);
  store.destroy();
});
