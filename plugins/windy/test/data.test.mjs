import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogueIndex, createStationsClient } from '@stations/client';
import { pilotFreshness } from '@stations/contracts';
import { distanceKm, normalizeLongitude } from '@stations/geography';
import { DEFAULT_MAX_CONCURRENT_REQUESTS, createWindyData, selectWindyStations } from '../src/data.ts';
import { createMemorySnapshotStore } from '../src/persistence.ts';

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
const timeout = { data: null, error: { kind: 'timeout', message: 'timed out' } };
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
function setup(stations, loadFeedResult = async query => feed(query.ids.map(ok)), overrides = {}) {
  const timer = clock();
  const changes = [];
  const calls = [];
  const client = {
    async loadCatalogueResult(query, request) { calls.push({ route: 'catalogue', query, request }); return { data: document(stations), error: null }; },
    loadFeedResult(query, request) { calls.push({ route: 'feed', query, request }); return loadFeedResult(query, request); },
  };
  const store = createWindyData({ client, onChange: value => changes.push(value), maxConcurrentRequests: 2, ...timer, ...overrides });
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

test('bounded selection matches the full-sort oracle across bounds, filters, duplicates and ties', () => {
  let seed = 123456789;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  const entries = Array.from({ length: 2_500 }, (_, i) => ({
    ...station(`s${String(i).padStart(4, '0')}`, i < 160 ? 0 : random() * 360 - 180, i < 160 ? 0 : random() * 160 - 80),
    category: i % 2 ? 'pws' : 'marine',
  }));
  entries.push({ ...entries[10], longitude: 179 }, { ...entries[20], longitude: -179 }, station('edge-east', 180), station('edge-west', -180));
  const fullSort = (index, bounds, category) => {
    const { west, east } = bounds;
    const south = Math.max(-90, bounds.south);
    const north = Math.min(90, bounds.north);
    if (![west, east, south, north].every(Number.isFinite) || south > north) return { stations: [], visibleTotal: 0 };
    const span = east - west;
    const world = Math.abs(span) >= 360;
    const width = world ? 360 : ((span % 360) + 360) % 360;
    const start = normalizeLongitude(west);
    const end = normalizeLongitude(west + width);
    const queries = world ? [[-180, south, 180, north]] : start <= end
      ? [[start, south, end, north]] : [[start, south, 180, north], [-180, south, end, north]];
    const unique = new Map();
    for (const query of queries) {
      for (const item of index.inBounds(query, category ? { categories: [category] } : undefined)) {
        if (!unique.has(item.uid)) unique.set(item.uid, item);
      }
    }
    const center = { latitude: (south + north) / 2, longitude: normalizeLongitude(west + width / 2) };
    const ranked = [...unique.values()].map(item => ({ station: item, distance: distanceKm(center, item) }));
    ranked.sort((a, b) => a.distance - b.distance || (a.station.uid < b.station.uid ? -1 : a.station.uid > b.station.uid ? 1 : 0));
    return { stations: ranked.slice(0, 100).map(item => item.station), visibleTotal: ranked.length };
  };
  const viewports = [box, { ...box, west: 10, east: 370 }, { west: 170, east: -170, south: -90, north: 90 },
    { west: -190, east: -170, south: -20, north: 20 }, { west: -15, east: 15, south: -20, north: 20 },
    { west: 0, east: 0, south: -1, north: 1 }, { ...box, south: 20, north: -20 }, { ...box, west: NaN }];
  for (const size of [0, 1, 99, 100, 101, entries.length]) {
    const index = createCatalogueIndex(document(entries.slice(0, size)));
    for (const viewport of viewports) {
      for (const category of [null, 'pws', 'marine', 'mountain']) {
        assert.deepEqual(selectWindyStations(index, viewport, category), fullSort(index, viewport, category));
      }
    }
  }
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

test('caps concurrency across suspension and ignores late results', async () => {
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
  store.suspend();
  assert.ok(requests.every(request => request.request.signal.aborted));
  store.resume();
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

test('automatic refresh starts 120 seconds after the individual request settles', async () => {
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
  await timer.advance(119_999);
  assert.equal(requests, 1);
  await timer.advance(1);
  assert.equal(requests, 2);
  store.destroy();
});

test('a slow batch does not postpone the deadline of a completed batch', async () => {
  const requests = [];
  const { store, timer } = setup(Array.from({ length: 26 }, (_, i) => station(`s${String(i).padStart(2, '0')}`)), (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  requests[0].resolve(feed(requests[0].query.ids.map(ok)));
  await flush();
  await timer.advance(120_000);
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].query.ids, requests[0].query.ids);
  assert.equal(requests[1].request.signal.aborted, false);
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
  await timer.advance(120_000);
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

test('a timed-out batch splits once and each half settles independently', async () => {
  const requests = [];
  const { store, timer } = setup(Array.from({ length: 22 }, (_, i) => station(`s${String(i).padStart(2, '0')}`)), (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  await timer.advance(15_000);
  requests[0].resolve(timeout);
  await flush();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.slice(1).map(item => item.query.ids.length), [11, 11]);
  assert.deepEqual(requests.slice(1).flatMap(item => item.query.ids), requests[0].query.ids);
  assert.ok(store.getSnapshot().entries.every(entry => entry.refreshing));
  requests[1].resolve(feed(requests[1].query.ids.map(ok)));
  await flush();
  assert.equal(store.getSnapshot().entries.filter(entry => entry.status === 'ok' && !entry.refreshing).length, 11);
  assert.equal(store.getSnapshot().entries.filter(entry => entry.refreshing).length, 11);
  requests[2].resolve(timeout);
  await flush();
  assert.equal(requests.length, 3);
  assert.equal(store.getSnapshot().entries.filter(entry => entry.status === 'refresh-failed' && !entry.refreshing).length, 11);
  await timer.advance(59_999);
  assert.equal(requests.length, 3);
  await timer.advance(1);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3].query.ids, requests[2].query.ids);
  store.destroy();
});

test('split retries preserve cached readings and count a timed-out check once', async () => {
  const requests = [];
  const { store, timer } = setup([station('a'), station('b')], (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  requests[0].resolve(feed(requests[0].query.ids.map(ok)));
  await flush();
  await timer.advance(120_000);
  requests[1].resolve(timeout);
  await flush();
  assert.equal(requests.length, 4);
  assert.ok(store.getSnapshot().entries.every(entry => entry.observation && entry.receivedAtMs === 0 && entry.refreshing));
  requests[2].resolve(feed(requests[2].query.ids.map(ok)));
  requests[3].resolve(timeout);
  await flush();
  const failed = store.getSnapshot().entries.find(entry => entry.status === 'refresh-failed');
  assert.equal(failed.observation.reading.windAvgMps, 0);
  assert.equal(failed.receivedAtMs, 0);
  await timer.advance(59_999);
  assert.equal(requests.length, 4);
  await timer.advance(1);
  assert.equal(requests.length, 5);
  assert.deepEqual(requests[4].query.ids, [failed.station.uid]);
  store.destroy();
});

test('split halves take available slots before unrelated queued batches and never recurse', async () => {
  const requests = [];
  const { store, timer } = setup(Array.from({ length: 100 }, (_, i) => station(`s${String(i).padStart(2, '0')}`)), (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  requests[0].resolve(timeout);
  await flush();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].query.ids, requests[0].query.ids.slice(0, 13));
  requests[2].resolve(timeout);
  await flush();
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[3].query.ids, requests[0].query.ids.slice(13));
  requests[3].resolve(timeout);
  await flush();
  assert.equal(requests.length, 5);
  assert.ok(requests[4].query.ids.every(uid => !requests[0].query.ids.includes(uid)));
  await timer.advance(59_999);
  assert.equal(requests.length, 5);
  store.destroy();
});

test('a split failure preserves prior exponential backoff', async () => {
  const requests = [];
  const { store, timer } = setup([station('a'), station('b')], (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  requests[0].resolve(failure);
  await flush();
  await timer.advance(60_000);
  requests[1].resolve(timeout);
  await flush();
  assert.equal(requests.length, 4);
  requests[2].resolve(feed(requests[2].query.ids.map(ok)));
  requests[3].resolve(timeout);
  await flush();
  await timer.advance(119_999);
  assert.equal(requests.length, 4);
  await timer.advance(1);
  assert.equal(requests.length, 5);
  assert.deepEqual(new Set(requests[4].query.ids), new Set(['a', 'b']));
  store.destroy();
});

test('queued split halves are discarded after a disjoint pan', async () => {
  const requests = [];
  const stations = [...Array.from({ length: 50 }, (_, i) => station(`a${String(i).padStart(2, '0')}`, 0)),
    ...Array.from({ length: 25 }, (_, i) => station(`b${String(i).padStart(2, '0')}`, 10))];
  const { store, timer } = setup(stations, (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport({ west: -1, east: 1, south: -1, north: 1 });
  store.resume();
  await flush();
  requests[0].resolve(timeout);
  await flush();
  assert.deepEqual(requests[2].query.ids, requests[0].query.ids.slice(0, 13));
  store.setViewport({ west: 9, east: 11, south: -1, north: 1 });
  await timer.advance(300);
  requests[2].resolve(feed(requests[2].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 4);
  assert.ok(requests[3].query.ids.every(uid => uid.startsWith('b')));
  store.destroy();
});

test('split retries share the physical concurrency limit with aborted requests', async () => {
  const requests = [];
  let active = 0;
  let peak = 0;
  const { store } = setup(Array.from({ length: 50 }, (_, i) => station(`s${String(i).padStart(2, '0')}`)), (query, request) => {
    const pending = deferred();
    active++;
    peak = Math.max(peak, active);
    requests.push({ ...pending, query, request });
    return pending.promise.then(result => { active--; return result; });
  });
  store.setViewport(box);
  store.resume();
  await flush();
  store.suspend();
  store.resume();
  requests[0].resolve(timeout);
  await flush();
  assert.equal(requests.length, 3);
  requests[2].resolve(timeout);
  await flush();
  assert.equal(requests.length, 4);
  assert.equal(requests[3].query.ids.length, 13);
  requests[1].resolve(timeout);
  await flush();
  assert.equal(requests.length, 5);
  assert.equal(requests[4].query.ids.length, 12);
  assert.equal(peak, 2);
  store.destroy();
});

for (const result of [failure, { data: null, error: { kind: 'network', message: 'offline' } }, { data: null, error: { kind: 'parse', message: 'invalid' } }]) {
  test(`a ${result.error.kind} failure does not split a batch`, async () => {
    const { store, timer, calls } = setup([station('a'), station('b')], async () => result);
    store.setViewport(box);
    store.resume();
    await flush();
    await timer.advance(59_999);
    assert.equal(calls.filter(call => call.route === 'feed').length, 1);
    store.destroy();
  });
}

test('a singleton timeout does not split', async () => {
  const { store, timer, calls } = setup([station('a')], async () => timeout);
  store.setViewport(box);
  store.resume();
  await flush();
  await timer.advance(59_999);
  assert.equal(calls.filter(call => call.route === 'feed').length, 1);
  store.destroy();
});

test('a timeout during viewport debounce retries only stations still selected', async () => {
  const requests = [];
  const stations = Array.from({ length: 20 }, (_, i) => station(`s${String(i).padStart(2, '0')}`, i < 10 ? 0 : 10));
  const { store, timer } = setup(stations, (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  store.setViewport({ west: 9, east: 11, south: -1, north: 1 });
  requests[0].resolve(timeout);
  await flush();
  assert.equal(requests.length, 1);
  await timer.advance(300);
  assert.equal(requests.length, 2);
  assert.ok(requests[1].query.ids.every(id => Number(id.slice(1)) >= 10));
  assert.equal(requests[1].query.ids.length, 10);
  store.destroy();
});

for (const action of ['suspend', 'destroy']) {
  test(`${action} ignores late timeouts and does not start split retries`, async () => {
    const requests = [];
    const { store, timer } = setup([station('a'), station('b')], (query, request) => {
      const pending = deferred();
      requests.push({ ...pending, query, request });
      return pending.promise;
    });
    store.setViewport(box);
    store.resume();
    await flush();
    store[action]();
    assert.equal(requests[0].request.signal.aborted, true);
    requests[0].resolve(timeout);
    await flush();
    await timer.advance(60_000);
    assert.equal(requests.length, 1);
    store.destroy();
  });
}

test('refresh clicks coalesce in flight and retry a failure immediately', async () => {
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
  assert.equal(calls, 1);
  await timer.advance(59_999);
  assert.equal(calls, 1, 'backoff holds until a refresh click or the deadline');
  store.refresh();
  await flush();
  assert.equal(calls, 2);
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
  assert.deepEqual(requests.filter(call => call.ids.length === 25).map(call => call.at), [0, 120_000]);
  assert.deepEqual(requests.filter(call => call.ids.length === 1).map(call => call.at), [0, 60_000]);
  await timer.advance(60_000);
  assert.deepEqual(requests.filter(call => call.ids.length === 1).map(call => call.at), [0, 60_000, 180_000]);
  store.destroy();
});

test('a refresh click reloads a station inside the poll interval', async () => {
  const { store, timer, calls } = setup([station('a')]);
  store.setViewport(box);
  store.resume();
  await flush();
  store.refresh();
  store.refresh();
  await flush();
  assert.equal(calls.filter(call => call.route === 'feed').length, 2);
  await timer.advance(120_000);
  assert.equal(calls.filter(call => call.route === 'feed').length, 3);
  store.destroy();
});

test('pans reuse checked data and preserve separate 120-second deadlines', async () => {
  const { store, timer, calls } = setup([station('a', 0), station('b', 10)]);
  store.setViewport({ west: -1, east: 1, south: -1, north: 1 });
  store.resume();
  await flush();
  store.setViewport({ west: -1, east: 11, south: -1, north: 1 });
  await timer.advance(300);
  const feeds = calls.filter(call => call.route === 'feed');
  assert.deepEqual(feeds.map(call => call.query.ids), [['a'], ['b']]);
  await timer.advance(119_700);
  assert.equal(feeds.length + 1, calls.filter(call => call.route === 'feed').length);
  assert.deepEqual(calls.at(-1).query.ids, ['a']);
  await timer.advance(300);
  assert.deepEqual(calls.at(-1).query.ids, ['b']);
  store.destroy();
});

test('identical viewports do not emit and rapid changes coalesce without starving selection', async () => {
  const { store, timer, changes, calls } = setup([station('a', 0), station('b', 10)]);
  store.setViewport(box);
  store.resume();
  await flush();
  const emissions = changes.length;
  store.setViewport({ ...box });
  store.setViewport({ ...box }, null);
  await timer.advance(300);
  assert.equal(changes.length, emissions);
  for (let i = 0; i < 3; i++) {
    store.setViewport({ west: 9 - i / 10, east: 11, south: -1, north: 1 });
    await timer.advance(100);
  }
  assert.deepEqual(store.getSnapshot().entries.map(entry => entry.station.uid), ['b']);
  assert.equal(calls.filter(call => call.route === 'feed').length, 1);
  store.destroy();
});

test('an early completion waits for pending viewport reconciliation before dispatch', async () => {
  const stations = [
    ...Array.from({ length: 100 }, (_, i) => station(`a${String(i).padStart(2, '0')}`, 0)),
    ...Array.from({ length: 25 }, (_, i) => station(`b${String(i).padStart(2, '0')}`, 10)),
  ];
  const requests = [];
  const { store, timer } = setup(stations, (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  const oldViewport = { west: -1, east: 1, south: -1, north: 1 };
  const newViewport = { west: 9, east: 11, south: -1, north: 1 };
  store.setViewport(oldViewport);
  store.resume();
  await flush();
  assert.equal(requests.length, 2);
  store.setViewport(newViewport);
  requests[0].resolve(feed(requests[0].query.ids.map(ok)));
  await flush();
  store.refresh();
  store.setViewport({ ...newViewport });
  await timer.advance(299);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(item => !item.request.signal.aborted));
  await timer.advance(1);
  assert.equal(requests.length, 3);
  assert.ok(requests[2].query.ids.every(id => id.startsWith('b')));
  assert.ok(store.getSnapshot().entries.every(entry => entry.station.uid.startsWith('b')));
  store.setViewport(oldViewport);
  await timer.advance(300);
  assert.equal(store.getSnapshot().entries.filter(entry => entry.status === 'ok').length, 25);
  assert.equal(requests.length, 3);
  store.destroy();
});

test('a deadline during pending selection dispatches after reconciliation', async () => {
  const requests = [];
  const { store, timer } = setup([station('a')], async query => {
    requests.push({ ids: query.ids, at: timer.now() });
    return feed(query.ids.map(ok));
  });
  store.setViewport(box);
  store.resume();
  await flush();
  await timer.advance(119_900);
  store.setViewport({ west: -1, east: 1, south: -1, north: 1 });
  await timer.advance(100);
  assert.equal(requests.length, 1);
  await timer.advance(200);
  assert.deepEqual(requests.map(request => request.at), [0, 120_200]);
  await timer.advance(120_000);
  assert.deepEqual(requests.map(request => request.at), [0, 120_200, 240_200]);
  store.destroy();
});

test('in-flight batches survive movement, obsolete queue is dropped, and offscreen results are cached', async () => {
  const stations = [
    ...Array.from({ length: 100 }, (_, i) => station(`a${String(i).padStart(2, '0')}`, 0)),
    ...Array.from({ length: 50 }, (_, i) => station(`b${String(i).padStart(2, '0')}`, 10)),
  ];
  const requests = [];
  const { store, timer } = setup(stations, (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  const viewport = longitude => ({ west: longitude - 1, east: longitude + 1, south: -1, north: 1 });
  store.setViewport(viewport(0));
  store.resume();
  await flush();
  assert.equal(requests.length, 2);
  store.setViewport(viewport(10));
  await timer.advance(300);
  assert.ok(requests.every(item => !item.request.signal.aborted));
  assert.equal(store.getSnapshot().entries.length, 50);
  requests[0].resolve(feed(requests[0].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 3);
  assert.ok(requests[2].query.ids.every(id => id.startsWith('b')));
  assert.ok(store.getSnapshot().entries.every(entry => entry.station.uid.startsWith('b') && entry.observation === null));
  requests[1].resolve(feed(requests[1].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 4);
  assert.ok(requests[3].query.ids.every(id => id.startsWith('b')));
  store.setViewport(viewport(0));
  await timer.advance(300);
  assert.equal(store.getSnapshot().entries.filter(entry => entry.status === 'ok').length, 50);
  assert.equal(requests.length, 4);
  requests[2].resolve(feed(requests[2].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 5);
  assert.ok(requests[4].query.ids.every(id => id.startsWith('a') && !requests[0].query.ids.includes(id) && !requests[1].query.ids.includes(id)));
  store.destroy();
});

test('filter and overlapping viewport changes preserve in-flight membership without duplicates', async () => {
  const stations = Array.from({ length: 60 }, (_, i) => ({ ...station(`s${String(i).padStart(2, '0')}`, i < 30 ? 0 : 10), category: i < 30 ? 'pws' : 'marine' }));
  const requests = [];
  const { store, timer } = setup(stations, (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  const started = requests.flatMap(item => item.query.ids);
  store.setViewport({ west: -1, east: 11, south: -1, north: 1 }, 'marine');
  await timer.advance(300);
  assert.ok(store.getSnapshot().entries.every(entry => entry.station.category === 'marine'));
  assert.ok(requests.every(item => !item.request.signal.aborted));
  requests[0].resolve(feed(requests[0].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 3);
  assert.ok(requests[2].query.ids.every(uid => !started.includes(uid) && stations.find(station => station.uid === uid).category === 'marine'));
  store.setViewport(box, 'pws');
  await timer.advance(300);
  assert.ok(store.getSnapshot().entries.every(entry => entry.station.category === 'pws'));
  const allStarted = requests.flatMap(item => item.query.ids);
  assert.equal(new Set(allStarted).size, allStarted.length);
  store.destroy();
});

test('refreshing preserves success, unavailable and failure status until their requests settle', async () => {
  const requests = [];
  const { store, timer } = setup([station('a')], (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  assert.equal(store.getSnapshot().entries[0].status, 'loading');
  assert.equal(store.getSnapshot().entries[0].refreshing, true);
  requests[0].resolve(feed([ok('a')]));
  await flush();
  await timer.advance(120_000);
  assert.equal(store.getSnapshot().entries[0].status, 'ok');
  assert.equal(store.getSnapshot().entries[0].refreshing, true);
  assert.equal(store.getSnapshot().entries[0].observation.reading.windAvgMps, 0);
  requests[1].resolve(feed([{ ...ok('a'), status: 'unavailable', reason: 'upstream_error', reading: null }]));
  await flush();
  await timer.advance(120_000);
  assert.equal(store.getSnapshot().entries[0].status, 'unavailable');
  assert.equal(store.getSnapshot().entries[0].refreshing, true);
  requests[2].resolve(failure);
  await flush();
  await timer.advance(60_000);
  assert.equal(store.getSnapshot().entries[0].status, 'refresh-failed');
  assert.equal(store.getSnapshot().entries[0].refreshing, true);
  assert.equal(store.getSnapshot().degraded, true);
  assert.equal(store.getSnapshot().entries[0].unavailable.reason, 'upstream_error');
  store.destroy();
});

test('continual viewport changes do not postpone observation deadlines', async () => {
  const calls = [];
  const { store, timer } = setup([station('a')], async query => {
    calls.push(timer.now());
    return feed(query.ids.map(ok));
  });
  store.setViewport(box);
  store.resume();
  await flush();
  for (let i = 0; i < 400; i++) {
    store.setViewport({ west: -10 - i / 1000, east: 10, south: -1, north: 1 });
    await timer.advance(300);
  }
  assert.deepEqual(calls, [0, 120_000]);
  store.destroy();
});

test('late cancelled responses cannot clear or overwrite a newer request', async () => {
  const requests = [];
  const { store } = setup(Array.from({ length: 26 }, (_, i) => station(`s${String(i).padStart(2, '0')}`)), (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  });
  store.setViewport(box);
  store.resume();
  await flush();
  store.suspend();
  store.resume();
  requests[0].resolve(feed(requests[0].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 3);
  requests[1].resolve(feed(requests[1].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 4);
  assert.ok(store.getSnapshot().entries.every(entry => entry.observation === null && entry.refreshing));
  requests[2].resolve(feed(requests[2].query.ids.map(ok)));
  await flush();
  assert.equal(store.getSnapshot().entries.filter(entry => entry.status === 'ok').length, 25);
  assert.equal(store.getSnapshot().entries.filter(entry => entry.refreshing).length, 1);
  store.destroy();
  requests[3].resolve(feed(requests[3].query.ids.map(ok)));
  await flush();
});

for (const replaced of [false, true]) {
  test(`catalogue refresh ${replaced ? 'invalidates changed identity' : 'preserves unchanged identity'} during a request`, async () => {
    const timer = clock();
    const requests = [];
    let catalogues = 0;
    const store = createWindyData({ ...timer, onChange() {}, client: {
      async loadCatalogueResult() {
        catalogues++;
        const current = station('a', catalogues === 1 ? 0 : 1);
        if (catalogues > 1 && replaced) current.nativeId = 'replacement';
        return { data: document([current]), error: null };
      },
      loadFeedResult(query, request) {
        const pending = deferred();
        requests.push({ ...pending, query, request });
        return pending.promise;
      },
    } });
    store.setViewport(box);
    store.resume();
    await flush();
    await timer.advance(86_400_000);
    assert.equal(catalogues, 2);
    assert.equal(requests[0].request.signal.aborted, replaced);
    assert.equal(store.getSnapshot().entries[0].station.longitude, 1);
    assert.equal(requests.length, replaced ? 2 : 1);
    requests[0].resolve(feed([ok('a')]));
    await flush();
    assert.equal(store.getSnapshot().entries[0].status, replaced ? 'loading' : 'ok');
    if (replaced) {
      requests[1].resolve(feed([ok('a')]));
      await flush();
      assert.equal(store.getSnapshot().entries[0].status, 'ok');
    }
    store.destroy();
  });
}

test('removing an offscreen cached station does not abort an unrelated active request', async () => {
  const timer = clock();
  const requests = [];
  let catalogues = 0;
  const store = createWindyData({ ...timer, onChange() {}, client: {
    async loadCatalogueResult() {
      catalogues++;
      return { data: document(catalogues === 1 ? [station('a', 0), station('b', 10)] : [station('b', 10)]), error: null };
    },
    loadFeedResult(query, request) {
      const pending = deferred();
      requests.push({ ...pending, query, request });
      return pending.promise;
    },
  } });
  store.setViewport({ west: -1, east: 1, south: -1, north: 1 });
  store.resume();
  await flush();
  requests[0].resolve(feed([ok('a')]));
  await flush();
  store.setViewport({ west: 9, east: 11, south: -1, north: 1 });
  await timer.advance(300);
  await timer.advance(86_400_000 - 300);
  assert.equal(requests[1].request.signal.aborted, false);
  assert.equal(requests.length, 2);
  requests[1].resolve(feed([ok('b')]));
  await flush();
  assert.equal(store.getSnapshot().entries[0].status, 'ok');
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
  await timer.advance(120_000);
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
  await timer.advance(120_000);
  const entry = store.getSnapshot().entries[0];
  assert.equal(entry.status, 'unavailable');
  assert.equal(entry.unavailable.reason, 'upstream_error');
  assert.equal(entry.observation.reading.windAvgMps, 0);
  assert.equal(entry.receivedAtMs, 0);
  serviceFailed = true;
  await timer.advance(120_000);
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
  await timer.advance(120_001);
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

test('defaults to four concurrent batches and honours an explicit cap', async () => {
  const stations = Array.from({ length: 150 }, (_, i) => station(`s${String(i).padStart(3, '0')}`));
  const requests = [];
  const timer = clock();
  const client = {
    async loadCatalogueResult() { return { data: document(stations), error: null }; },
    loadFeedResult(query, request) {
      const pending = deferred();
      requests.push({ ...pending, query, request });
      return pending.promise;
    },
  };
  const store = createWindyData({ client, onChange() {}, maxStations: 150, ...timer });
  store.setViewport(box);
  store.resume();
  await flush();
  assert.equal(DEFAULT_MAX_CONCURRENT_REQUESTS, 4);
  assert.equal(requests.length, 4);
  requests[0].resolve(feed(requests[0].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 5, 'a freed slot starts the next queued batch');
  for (const request of requests) request.resolve(feed(request.query.ids.map(ok)));
  await flush();
  store.destroy();
});

test('maxStations caps the selection but reports the true visible total', () => {
  const entries = Array.from({ length: 250 }, (_, i) => station(String(i).padStart(3, '0')));
  const index = createCatalogueIndex(document(entries));
  assert.equal(selectWindyStations(index, box).stations.length, 100);
  const capped = selectWindyStations(index, box, null, 40);
  assert.equal(capped.stations.length, 40);
  assert.equal(capped.visibleTotal, 250);
});

test('fractional limits below one fall back without stalling or bypassing batch caps', async () => {
  const stations = Array.from({ length: 110 }, (_, i) => station(`s${String(i).padStart(3, '0')}`));
  assert.equal(selectWindyStations(createCatalogueIndex(document(stations)), box, null, 0.5).stations.length, 100);
  const requests = [];
  const { store } = setup(stations, (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  }, { maxStations: 0.5, maxConcurrentRequests: 0.5, feedBatchSize: 0.5 });
  store.setViewport(box);
  store.resume();
  await flush();
  assert.equal(store.getSnapshot().selectedCount, 100);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.query.ids.length === 25));
  store.destroy();
});

for (const mode of ['throw', 'reject']) {
  test(`a snapshot save that ${mode}s cannot interrupt loading or suspension`, async () => {
    let saves = 0;
    const { store, timer, calls } = setup([station('a')], undefined, { snapshotStore: {
      load: () => null,
      save() {
        saves++;
        if (mode === 'throw') throw new Error('storage unavailable');
        return Promise.reject(new Error('storage unavailable'));
      },
    } });
    store.setViewport(box);
    store.resume();
    await flush();
    assert.equal(store.getSnapshot().entries[0].status, 'ok');
    await timer.advance(120_000);
    assert.equal(calls.filter(call => call.route === 'feed').length, 2);
    store.suspend();
    await flush();
    assert.ok(saves >= 2);
    assert.equal(timer.count(), 0);
    store.destroy();
  });
}

test('a rate-limited batch shrinks concurrency and a clean batch recovers it', async () => {
  const stations = Array.from({ length: 150 }, (_, i) => station(`s${String(i).padStart(3, '0')}`));
  const requests = [];
  const { store } = setup(stations, (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  }, { maxConcurrentRequests: 4, maxStations: 150 });
  store.setViewport(box);
  store.resume();
  await flush();
  assert.equal(requests.length, 4, 'the wave starts at full concurrency');

  // One 429 in the wave shrinks the wave; a concurrent sibling must not undo it.
  requests[0].resolve({ data: null, error: { kind: 'http', message: 'busy', status: 429 } });
  await flush();
  requests[1].resolve(feed(requests[1].query.ids.map(ok)));
  await flush();
  assert.equal(requests.length, 5, 'a 429 drops concurrency to three, so a clean sibling refills only one slot');
  store.destroy();
});

test('a persisted snapshot paints markers before the network resolves, then revalidates', async () => {
  const timer = clock();
  const entries = [station('a', 0)];
  const wall = Date.now();
  const persisted = createMemorySnapshotStore({
    version: 1,
    savedAtWallMs: wall,
    catalogue: document(entries),
    readings: [{
      uid: 'a', status: 'ok', observation: ok('a'), unavailable: null,
      servedAt, receivedAtWallMs: wall, checkedAtWallMs: wall, retryAtWallMs: 0, failures: 0,
    }],
  });
  const requests = [];
  let catalogueCalls = 0;
  const client = {
    async loadCatalogueResult() { catalogueCalls++; return { data: document(entries), error: null }; },
    loadFeedResult(query, request) {
      const pending = deferred();
      requests.push({ ...pending, query, request });
      return pending.promise;
    },
  };
  const store = createWindyData({ client, onChange() {}, ...timer, snapshotStore: persisted });
  store.setViewport(box);
  store.resume();
  await flush();
  const warm = store.getSnapshot();
  assert.equal(warm.catalogueStatus, 'ready');
  assert.equal(warm.entries.length, 1);
  assert.equal(warm.entries[0].observation.reading.windAvgMps, 0);
  assert.equal(catalogueCalls, 1, 'the catalogue revalidates in the background');
  store.destroy();
});

test('overlapping pans never request the same station twice across concurrent batches', async () => {
  const stations = [
    ...Array.from({ length: 30 }, (_, i) => station(`a${String(i).padStart(2, '0')}`, 0)),
    ...Array.from({ length: 30 }, (_, i) => station(`b${String(i).padStart(2, '0')}`, 1)),
  ];
  const requests = [];
  const { store, timer } = setup(stations, (query, request) => {
    const pending = deferred();
    requests.push({ ...pending, query, request });
    return pending.promise;
  }, { maxConcurrentRequests: 2 });
  store.setViewport({ west: -1, east: 0.5, south: -1, north: 1 });
  store.resume();
  await flush();
  store.setViewport({ west: -0.5, east: 1.5, south: -1, north: 1 });
  await timer.advance(300);
  const started = requests.flatMap(item => item.query.ids);
  assert.equal(new Set(started).size, started.length, 'no duplicate station across batches');
  for (const request of requests) request.resolve(feed(request.query.ids.map(ok)));
  await flush();
  store.destroy();
});
