import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryCache } from '@azohra/meteo.station/server';
import { STATION_SCHEMA_VERSION } from '@stations/contracts';
import {
  INITIAL_SEED_STATIONS,
  createStationsApiHandler,
  discoverStations,
} from '../../providers/dist/index.js';
import {
  createCatalogueIndex,
  createStationsClient,
  createViewportStationStore,
} from '../dist/index.js';

const holfuyArmeniaFixture = JSON.stringify({
  stationId: 1652,
  stationName: 'Hatis 300 Launch',
  dateTime: '2026-10-26 18:02:00',
  wind: {
    speed: 7.2,
    gust: 9.8,
    min: 5.0,
    unit: 'm/s',
    direction: 200,
  },
  temperature: 15.4,
  humidity: 44,
  pressure: 1017.0,
  battery: 12.9,
});

const awcArmeniaFixture = JSON.stringify([
  {
    icaoId: 'UDYZ',
    name: 'Yerevan Zvartnots International',
    lat: 40.147,
    lon: 44.396,
    elev: 865,
    obsTime: 1793037600,
    wdir: 220,
    wspd: 12,
    wgst: 18,
    temp: 18.5,
    dewp: 6.0,
    slp: 1016.0,
  },
]);

test('createStationsClient and createViewportStationStore query spatial catalogue and update GeoJSON + StationFeed snapshots', async () => {
  const environment = {
    now: () => new Date('2026-10-26T18:05:00Z'),
    cache: memoryCache(),
    logger: () => {},
    fetch: async input => {
      const url = String(input);
      if (url.includes('api.holfuy.com')) return new Response(holfuyArmeniaFixture, { status: 200 });
      if (url.includes('aviationweather.gov')) return new Response(awcArmeniaFixture, { status: 200 });
      return new Response('unavailable', { status: 502 });
    },
  };

  const catalogue = await discoverStations({
    seeds: INITIAL_SEED_STATIONS,
    includeRemoteDiscovery: false,
    environment,
  });

  const handler = createStationsApiHandler({
    catalogue,
    credentials: { holfuyApiKey: 'test-holfuy-key' },
    environment,
    basePath: '/api/stations',
  });

  const client = createStationsClient({
    baseUrl: 'https://stations.example/api/stations',
    fetch: input => handler(new Request(String(input))),
  });

  const index = await client.loadCatalogueIndex();
  assert.ok(index);
  assert.equal(index.size, INITIAL_SEED_STATIONS.length);

  const armeniaStations = index.inBounds([43.44, 38.84, 46.63, 41.30]);
  assert.ok(armeniaStations.length >= 4);
  assert.ok(armeniaStations.every(s => s.country === 'AM'));

  const nearYerevan = index.near({ latitude: 40.1872, longitude: 44.5152 }, 40, {
    vendors: ['holfuy', 'awc'],
  });
  assert.equal(nearYerevan.length, 2);

  let notifications = 0;
  const viewportStore = createViewportStationStore({
    client,
    vendors: ['holfuy', 'awc'],
    catalogueByUid: index.byUidMap,
  });
  const unsubscribe = viewportStore.subscribe(() => {
    notifications += 1;
  });

  const snap = await viewportStore.setViewport([44.0, 40.0, 45.0, 40.5]);
  unsubscribe();

  assert.ok(notifications >= 2);
  assert.equal(snap.loading, false);
  assert.ok(snap.feed);
  assert.equal(snap.feed.stations.length, 2);
  assert.ok(snap.geojson);
  assert.equal(snap.geojson.features.length, 2);
  assert.equal(snap.geojson.features[0].properties.status, 'ok');
  assert.equal(snap.geojson.features[0].properties.country, 'AM');

  const singleCurrent = await client.loadCurrent('holfuy:1652');
  assert.ok(singleCurrent);
  assert.equal(singleCurrent.station.status, 'ok');
  if (singleCurrent.station.status === 'ok') {
    assert.equal(singleCurrent.station.reading.windAvgMps, 7.2);
  }
});

test('createCatalogueIndex supports filtering by country, vendor, and limit', () => {
  const index = createCatalogueIndex({
    schemaVersion: 1,
    generatedAt: '2026-10-26T18:05:00Z',
    regions: ['US', 'CA', 'MX', 'AM'],
    stations: INITIAL_SEED_STATIONS,
  });

  const usWindnerd = index.all({ countries: ['US'], vendors: ['windnerd'] });
  assert.equal(usWindnerd.length, 2);
  assert.equal(index.byUid('windnerd:tiger-mountain')?.name, 'Tiger Mountain North Launch');
  assert.equal(index.toGeoJson(usWindnerd).features.length, 2);
});


function emptyFeed(servedAt = '2026-10-26T18:05:00Z') {
  return { schemaVersion: STATION_SCHEMA_VERSION, servedAt, primaryStationId: null, stations: [] };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('viewport keeps the latest request when requests finish in either order', async t => {
  for (const completionOrder of ['old-first', 'new-first']) {
    await t.test(completionOrder, async () => {
      const requests = [];
      const store = createViewportStationStore({
        client: {
          loadFeed(query, request) {
            const pending = deferred();
            requests.push({ query, request, ...pending });
            return pending.promise; // Deliberately ignores cancellation to exercise the generation guard.
          },
        },
      });
      const oldBounds = [0, 0, 1, 1];
      const newBounds = [10, 10, 11, 11];
      const oldLoad = store.setViewport(oldBounds);
      await Promise.resolve();
      const newLoad = store.setViewport(newBounds);
      await Promise.resolve();
      assert.equal(requests[0].request.signal.aborted, true);
      assert.equal(requests[1].request.signal.aborted, false);
      const oldFeed = emptyFeed('2026-10-26T18:04:00Z');
      const newFeed = emptyFeed();
      if (completionOrder === 'old-first') {
        requests[0].resolve(oldFeed);
        await oldLoad;
        assert.deepEqual(store.getSnapshot().bounds, newBounds);
        assert.equal(store.getSnapshot().loading, true);
        assert.equal(store.getSnapshot().feed, null);
        requests[1].resolve(newFeed);
        await newLoad;
      } else {
        requests[1].resolve(newFeed);
        await newLoad;
        requests[0].resolve(oldFeed);
        await oldLoad;
      }
      assert.deepEqual(store.getSnapshot().bounds, newBounds);
      assert.deepEqual(store.getSnapshot().dataBounds, newBounds);
      assert.equal(store.getSnapshot().feed, newFeed);
      assert.equal(store.getSnapshot().loading, false);
      assert.equal(store.getSnapshot().stale, false);
      assert.equal(store.getSnapshot().error, null);
    });
  }
});

test('viewport coalesces identical in-flight bounds', async () => {
  const pending = deferred();
  let requests = 0;
  const store = createViewportStationStore({ client: { loadFeed: () => { requests += 1; return pending.promise; } } });
  const first = store.setViewport([0, 0, 1, 1]);
  const second = store.setViewport([0, 0, 1, 1]);
  const refresh = store.refresh();
  assert.equal(first, second);
  assert.equal(first, refresh);
  await Promise.resolve();
  assert.equal(requests, 1);
  pending.resolve(emptyFeed());
  await first;
});

test('viewport retains data bounds and reports errors during failed refreshes', async () => {
  let status = 200;
  const client = createStationsClient({
    baseUrl: '/api/stations',
    fetch: async () => new Response(JSON.stringify(emptyFeed()), { status }),
  });
  const store = createViewportStationStore({ client });
  const firstBounds = [0, 0, 1, 1];
  const nextBounds = [10, 10, 11, 11];
  const initial = await store.setViewport(firstBounds);
  status = 503;
  const failedLoad = store.setViewport(nextBounds);
  assert.equal(store.getSnapshot().stale, true);
  assert.equal(store.getSnapshot().loading, true);
  assert.deepEqual(store.getSnapshot().dataBounds, firstBounds);
  const failed = await failedLoad;
  assert.deepEqual(failed.bounds, nextBounds);
  assert.deepEqual(failed.dataBounds, firstBounds);
  assert.equal(failed.feed, initial.feed);
  assert.equal(failed.geojson, initial.geojson);
  assert.equal(failed.updatedAtMs, initial.updatedAtMs);
  assert.equal(failed.loading, false);
  assert.equal(failed.stale, true);
  assert.equal(failed.error.kind, 'http');
  assert.equal(failed.error.status, 503);
  status = 200;
  const retry = store.refresh();
  assert.equal(store.getSnapshot().stale, true);
  const recovered = await retry;
  assert.deepEqual(recovered.dataBounds, nextBounds);
  assert.equal(recovered.stale, false);
  assert.equal(recovered.error, null);
  const sameBoundsRefresh = store.refresh();
  assert.equal(store.getSnapshot().stale, true);
  await sameBoundsRefresh;
});

test('viewport clears loading when a custom client throws or returns no feed', async () => {
  let shouldThrow = true;
  const store = createViewportStationStore({
    client: { loadFeed: async () => { if (shouldThrow) throw new Error('offline'); return null; } },
  });
  let snapshot = await store.setViewport([0, 0, 1, 1]);
  assert.equal(snapshot.loading, false);
  assert.equal(snapshot.error.kind, 'unknown');
  assert.equal(snapshot.error.message, 'offline');
  assert.equal(snapshot.dataBounds, null);
  assert.equal(snapshot.stale, false);
  shouldThrow = false;
  snapshot = await store.refresh();
  assert.equal(snapshot.loading, false);
  assert.equal(snapshot.error.kind, 'unknown');
});

test('client distinguishes HTTP, network, and invalid document failures while nullable methods stay compatible', async t => {
  const scenarios = [
    { name: 'http', fetch: async () => new Response('unavailable', { status: 502 }), kind: 'http', status: 502 },
    { name: 'network', fetch: async () => { throw new Error('offline'); }, kind: 'network' },
    { name: 'invalid JSON', fetch: async () => new Response('{'), kind: 'parse' },
    { name: 'invalid schema', fetch: async () => new Response('{}'), kind: 'parse' },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const client = createStationsClient({ baseUrl: '/api/stations', fetch: scenario.fetch });
      const result = await client.loadFeedResult();
      assert.equal(result.data, null);
      assert.equal(result.error.kind, scenario.kind);
      assert.equal(result.error.status, scenario.status);
      assert.equal(await client.loadFeed(), null);
    });
  }
});

test('client supports cancellation even when injected fetch ignores the signal', async () => {
  let requestSignal;
  const client = createStationsClient({
    baseUrl: '/api/stations',
    fetch: (_input, request) => { requestSignal = request.signal; return new Promise(() => {}); },
  });
  const controller = new AbortController();
  const pending = client.loadFeedResult(undefined, { signal: controller.signal });
  controller.abort();
  const result = await pending;
  assert.equal(requestSignal.aborted, true);
  assert.equal(result.error.kind, 'aborted');
  assert.equal(result.data, null);
  const preAborted = await client.loadCatalogueResult(undefined, { signal: controller.signal });
  assert.equal(preAborted.error.kind, 'aborted');
});

test('client times out both fetch and response body reads', async t => {
  for (const stalledPart of ['fetch', 'body']) {
    await t.test(stalledPart, async () => {
      let requestSignal;
      const client = createStationsClient({
        baseUrl: '/api/stations',
        timeoutMs: 10,
        fetch: async (_input, request) => {
          requestSignal = request.signal;
          if (stalledPart === 'fetch') return new Promise(() => {});
          return new Response(new ReadableStream({ start() {} }));
        },
      });
      const result = await client.loadCurrentResult('holfuy:1652');
      assert.equal(result.error.kind, 'timeout');
      assert.equal(requestSignal.aborted, true);
    });
  }
});

test('client helpers can be destructured', async () => {
  const client = createStationsClient({
    baseUrl: '/api/stations',
    fetch: async input => new Response(JSON.stringify(String(input).includes('/catalogue')
      ? { schemaVersion: 1, generatedAt: '2026-10-26T18:05:00Z', regions: ['AM'], stations: [] }
      : emptyFeed())),
  });
  const { loadCatalogueIndex, loadGeoJsonFeed } = client;
  assert.equal((await loadCatalogueIndex()).size, 0);
  assert.equal((await loadGeoJsonFeed()).features.length, 0);
});


test('catalogue aliases resolve without overriding canonical IDs and all spatial methods share filters', () => {
  const base = INITIAL_SEED_STATIONS[0];
  const launchContext = { nearestLaunchSlug: 'launch', nearestLaunchName: 'Launch', distanceKm: 2, bearingDeg: 0 };
  const wrong = { ...base, uid: 'custom:wrong', vendor: 'custom', nativeId: 'wrong', latitude: 40, longitude: 44, category: 'pws' };
  const target = { ...base, uid: 'custom:target', vendor: 'custom', nativeId: 'target', latitude: 40.01, longitude: 44, category: 'freeflight', aliases: ['custom:old', 'custom:wrong'], launchContext };
  const index = createCatalogueIndex({ schemaVersion: 1, generatedAt: '2026-10-26T18:05:00Z', regions: [], stations: [wrong, target] });
  assert.equal(index.byUid('custom:old'), target);
  assert.equal(index.byUidMap.get('custom:old'), target);
  assert.equal(index.byUid('custom:wrong'), wrong);
  assert.equal(index.size, 2);
  const filter = { categories: ['freeflight'], launchSlug: 'launch', maxLaunchDistanceKm: 3, limit: 1 };
  assert.deepEqual(index.all(filter), [target]);
  assert.deepEqual(index.inBounds([43, 39, 45, 41], filter), [target]);
  assert.deepEqual(index.near({ latitude: 40, longitude: 44 }, 10, filter).map(match => match.item), [target]);
  assert.deepEqual(index.near({ latitude: 40, longitude: 44 }, 10, { ...filter, maxLaunchDistanceKm: 1 }), []);
  for (const limit of [0, -1, NaN, Infinity]) {
    assert.deepEqual(index.all({ limit }), []);
    assert.deepEqual(index.near({ latitude: 40, longitude: 44 }, 10, { limit }), []);
  }
});

test('viewport forwards category and launch selection to the client', async () => {
  let requested;
  const store = createViewportStationStore({
    client: { loadFeed: async query => { requested = query; return emptyFeed(); } },
    categories: ['freeflight'], launch: 'launch',
  });
  await store.setViewport([43, 39, 45, 41]);
  assert.deepEqual(requested.categories, ['freeflight']);
  assert.equal(requested.launch, 'launch');
});
