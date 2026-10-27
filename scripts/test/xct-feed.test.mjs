import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { createStationsClient } from '@stations/client';
import { STATION_SCHEMA_VERSION } from '@stations/contracts';

const bundle = await build({
  entryPoints: [new URL('../../web/xct-feed.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { loadNearbyWind, observationAgeMs } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const servedAt = '2026-10-27T12:00:00Z';
const query = { position: { latitude: 40, longitude: 44 }, radiusKm: 300, maxAgeMs: 3_600_000 };
const capabilities = { gustLull: true, temperature: false, conditions: false, history: false };
const candidate = index => ({
  uid: `custom:${index}`, nativeId: String(index), vendor: 'custom', name: `Station ${index}`,
  latitude: 40 + index / 1_000, longitude: 44, elevationM: null, country: 'AM',
  region: null, timeZone: null, pageUrl: null, capabilities, samplingWindowSeconds: 60,
  recommendedPollSeconds: 60, category: 'freeflight', locator: {},
});
const station = (entry, status = 'ok', observedAt = servedAt) => ({
  id: entry.uid, name: entry.name, sourceLabel: 'Test', latitude: entry.latitude,
  longitude: entry.longitude, elevationM: null, pageUrl: null, timeZone: null,
  capabilities, samplingWindowSeconds: 60, recommendedPollSeconds: 60, status,
  ...(status === 'unavailable' ? { reason: 'upstream_error' } : {}),
  reading: status === 'unavailable' ? null : {
    observedAt, windAvgMps: 0, windGustMps: 0, windLullMps: null, windDirectionDeg: null,
    temperatureC: null, windChillC: null, conditions: null,
  },
  history: null,
});
const catalogueDocument = stations => ({ schemaVersion: 1, generatedAt: servedAt, regions: ['AM'], stations });
const feedDocument = stations => ({ schemaVersion: STATION_SCHEMA_VERSION, servedAt, primaryStationId: null, stations });
const success = data => ({ data, error: null });

function fixtureClient(entries, feedFor) {
  const calls = [];
  const client = createStationsClient({
    baseUrl: 'https://stations.test/api/stations',
    fetch: async input => {
      const url = new URL(input);
      calls.push(url);
      if (url.pathname.endsWith('/catalogue')) return Response.json(catalogueDocument(entries));
      const ids = url.searchParams.get('ids').split(',');
      return feedFor(ids, url);
    },
  });
  return { client, calls };
}

test('refills past unavailable and expired nearest stations, preserving curated categories and zero readings', async () => {
  const entries = Array.from({ length: 31 }, (_, index) => candidate(index + 1));
  const { client, calls } = fixtureClient([...entries].reverse(), ids => Response.json(feedDocument(
    ids.map(id => {
      const entry = entries.find(item => item.uid === id);
      const index = Number(entry.nativeId);
      return station(entry, index <= 15 ? 'unavailable' : 'ok', index <= 30 ? '2026-10-27T10:00:00Z' : servedAt);
    }),
  )));
  const result = await loadNearbyWind(client, query);
  assert.deepEqual(calls.slice(1).map(url => url.searchParams.get('ids').split(',').length), [30, 1]);
  assert.equal(calls[0].searchParams.get('limit'), '91');
  assert.equal(result.checkedUids.length, 31);
  assert.equal(result.failedUids.length, 15);
  const usable = result.observations.filter(item => observationAgeMs(item) <= query.maxAgeMs);
  assert.deepEqual(usable.map(item => item.station.id), ['custom:31']);
  assert.equal(usable[0].category, 'freeflight');
  assert.equal(usable[0].categorySource, 'catalogue');
  assert.equal(usable[0].station.reading.windAvgMps, 0);
  assert.equal(usable[0].station.reading.windGustMps, 0);
  assert.equal(result.complete, false);
  assert.equal(result.coverageLimited, false);
});

test('stops discovery after finding 30 usable observations', async () => {
  const entries = Array.from({ length: 91 }, (_, index) => candidate(index + 1));
  const { client, calls } = fixtureClient(entries, ids => Response.json(feedDocument(
    ids.map(id => station(entries.find(item => item.uid === id))),
  )));
  const result = await loadNearbyWind(client, query);
  assert.equal(calls.length, 2);
  assert.equal(result.observations.length, 30);
  assert.equal(result.checkedUids.length, 30);
  assert.equal(result.candidateUids.length, 90);
  assert.equal(result.coverageLimited, false);
  assert.equal(result.complete, true);
});

test('reports the bounded search when 90 candidates cannot fill the display', async () => {
  const entries = Array.from({ length: 91 }, (_, index) => candidate(index + 1));
  const { client, calls } = fixtureClient(entries, ids => Response.json(feedDocument(
    ids.map(id => station(entries.find(item => item.uid === id), 'unavailable')),
  )));
  const result = await loadNearbyWind(client, query);
  assert.equal(calls.length, 4);
  assert.equal(result.checkedUids.length, 90);
  assert.equal(result.failedUids.length, 90);
  assert.equal(result.checkedUids.includes('custom:91'), false);
  assert.equal(result.coverageLimited, true);
  assert.equal(result.complete, false);
});

test('distinguishes catalogue HTTP, network, and invalid-document errors', async t => {
  for (const [kind, fetch] of [
    ['http', async () => new Response('offline', { status: 503 })],
    ['network', async () => { throw new Error('No connection'); }],
    ['parse', async () => Response.json({ stations: [] })],
  ]) {
    await t.test(kind, async () => {
      const client = createStationsClient({ baseUrl: 'https://stations.test', fetch });
      const result = await loadNearbyWind(client, query);
      assert.equal(result.catalogueError.kind, kind);
      assert.deepEqual(result.checkedUids, []);
      assert.equal(result.complete, false);
    });
  }
});

test('marks missing feed rows and transport failures for retained-reading handling', async () => {
  const entries = Array.from({ length: 31 }, (_, index) => candidate(index + 1));
  const { client } = fixtureClient(entries, ids => ids.length === 30
    ? Response.json(feedDocument([station(entries[0])]))
    : new Response('offline', { status: 502 }));
  const result = await loadNearbyWind(client, query);
  assert.equal(result.catalogueError, null);
  assert.equal(result.feedErrors[0].kind, 'http');
  assert.deepEqual(result.observations.map(item => item.station.id), ['custom:1']);
  assert.deepEqual(result.failedUids, entries.slice(1).map(item => item.uid));
  assert.equal(result.complete, false);
});

test('successful empty discovery finishes without a feed request', async () => {
  const { client, calls } = fixtureClient([], () => { throw new Error('Unexpected feed request'); });
  const result = await loadNearbyWind(client, query);
  assert.equal(calls.length, 1);
  assert.equal(result.catalogueError, null);
  assert.equal(result.complete, true);
  assert.deepEqual(result.observations, []);
});

test('observation age follows server and monotonic elapsed time despite device-clock skew', t => {
  t.mock.method(Date, 'now', () => Date.parse('2036-01-01T00:00:00Z'));
  const observation = {
    station: station(candidate(1), 'ok', '2026-10-27T11:55:00Z'),
    servedAt, receivedAtMs: 10_000,
  };
  assert.equal(observationAgeMs(observation, 70_000), 360_000);
  assert.equal(observationAgeMs(observation, 9_000), 300_000);
  assert.equal(observationAgeMs({ ...observation, servedAt: 'invalid' }, 70_000), Infinity);
});

test('one timeout budget covers catalogue discovery and every refill batch', async t => {
  let now = 1_000;
  t.mock.method(performance, 'now', () => now);
  const entries = Array.from({ length: 61 }, (_, index) => candidate(index + 1));
  let feeds = 0;
  const client = {
    async loadCatalogueResult() {
      now += 10;
      return success(catalogueDocument(entries));
    },
    async loadFeedResult(_query, request) {
      feeds += 1;
      assert.equal(request.timeoutMs, 35);
      now += 40;
      return success(feedDocument([]));
    },
  };
  const result = await loadNearbyWind(client, query, { timeoutMs: 45 });
  assert.equal(feeds, 1);
  assert.equal(result.checkedUids.length, 30);
  assert.equal(result.failedUids.length, 61);
  assert.equal(result.feedErrors[0].kind, 'timeout');
  assert.equal(result.complete, false);
});
