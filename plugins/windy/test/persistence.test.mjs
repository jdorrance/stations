import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindyData } from '../src/data.ts';
import { createIndexedDbSnapshotStore, createMemorySnapshotStore } from '../src/persistence.ts';

const capabilities = { gustLull: true, temperature: true, conditions: false, history: true };
const station = (id, longitude = 0) => ({
  uid: id, vendor: 'windnerd', nativeId: id, name: id, latitude: 0, longitude,
  elevationM: null, country: null, region: null, timeZone: null, pageUrl: null,
  capabilities, samplingWindowSeconds: 60, recommendedPollSeconds: 60, locator: {},
});
const document = stations => ({ schemaVersion: 1, generatedAt: '2026-10-26T12:00:00Z', regions: [], stations });
const snapshot = {
  version: 1,
  savedAtWallMs: 1_000,
  catalogue: document([]),
  readings: [],
};
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const clock = () => ({ now: () => 0, random: () => 0, setTimeout: () => 0, clearTimeout: () => {} });

test('the memory store round-trips a snapshot', async () => {
  const store = createMemorySnapshotStore();
  assert.equal(await store.load(), null);
  await store.save(snapshot);
  assert.deepEqual(await store.load(), snapshot);
});

test('the IndexedDB store falls back to memory when IndexedDB is unavailable', async () => {
  // Node has no `indexedDB`; the factory must still produce a working store.
  assert.equal(typeof indexedDB, 'undefined');
  const store = createIndexedDbSnapshotStore({ databaseName: 'test-db' });
  assert.equal(await store.load(), null);
  await store.save(snapshot);
  assert.deepEqual(await store.load(), snapshot);
});

test('a retained refresh-failed reading replays without flashing an error on warm start', async () => {
  const wall = Date.now();
  const store = createMemorySnapshotStore({
    version: 1,
    savedAtWallMs: wall,
    catalogue: document([station('a')]),
    readings: [{
      uid: 'a', status: 'refresh-failed', observation: null, unavailable: null,
      servedAt: null, receivedAtWallMs: wall, checkedAtWallMs: wall, retryAtWallMs: 0, failures: 3,
    }],
  });
  const changes = [];
  const data = createWindyData({
    client: {
      async loadCatalogueResult() { return { data: null, error: { kind: 'timeout', message: 'slow' } }; },
      async loadFeedResult() { return { data: null, error: { kind: 'timeout', message: 'slow' } }; },
    },
    onChange: value => changes.push(value),
    snapshotStore: store,
    ...clock(),
  });
  data.setViewport({ west: -180, south: -90, east: 180, north: 90 });
  data.resume();
  await flush();
  const warm = changes.find(value => value.catalogueStatus === 'ready');
  assert.ok(warm, 'the persisted catalogue paints before the network resolves');
  assert.equal(warm.degraded, false, 'a previous failure is not replayed as an error');
  data.destroy();
});

test('a warm snapshot persists back through the same store', async () => {
  const store = createMemorySnapshotStore();
  const data = createWindyData({
    client: { async loadCatalogueResult() { return { data: document([station('a')]), error: null }; } },
    onChange() {},
    snapshotStore: store,
    ...clock(),
  });
  data.setViewport({ west: -180, south: -90, east: 180, north: 90 });
  data.resume();
  await flush();
  const saved = await store.load();
  assert.ok(saved, 'the catalogue is persisted for the next session');
  assert.deepEqual(saved.catalogue.stations.map(entry => entry.uid), ['a']);
  data.destroy();
});
