import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOGUE_SCHEMA_VERSION } from '@stations/contracts';
import { INITIAL_SEED_STATIONS, memoryCache } from '@stations/providers';
import { createWorkerRouter, unfilteredCatalogueKind } from '../router.ts';

const ORIGIN = 'https://stations.example';
const encoder = new TextEncoder();

function hydratedDocument() {
  return {
    schemaVersion: CATALOGUE_SCHEMA_VERSION,
    generatedAt: '2026-10-27T00:00:00.000Z',
    regions: ['US', 'CA'],
    stations: INITIAL_SEED_STATIONS,
  };
}

function publicObjects() {
  const objects = {
    json: { etag: '"json-etag"', bytes: encoder.encode('{"stations":"public-json"}') },
    geojson: { etag: '"geojson-etag"', bytes: encoder.encode('{"type":"FeatureCollection"}') },
  };
  const calls = [];
  return {
    calls,
    published: true,
    async getPublicObject(kind, ifNoneMatch) {
      calls.push({ kind, ifNoneMatch });
      if (!this.published) return null;
      const object = objects[kind];
      return {
        etag: object.etag,
        size: object.bytes.byteLength,
        body: ifNoneMatch === object.etag ? null : new Blob([object.bytes]).stream(),
      };
    },
  };
}

function awcFetch(input) {
  if (String(input).includes('aviationweather.gov')) {
    return Promise.resolve(new Response(JSON.stringify([{
      icaoId: 'KSEA', name: 'Seattle-Tacoma International', lat: 47.449, lon: -122.309, elev: 132,
      obsTime: 1793037600, wdir: 210, wspd: 12, wgst: 18, temp: 14.5, dewp: 8.0, slp: 1016.2,
    }]), { status: 200 }));
  }
  return Promise.resolve(new Response('offline', { status: 502 }));
}

function createFixture() {
  const objects = publicObjects();
  let hydratedLoads = 0;
  const router = createWorkerRouter({
    loadHydrated: async () => {
      hydratedLoads += 1;
      return hydratedDocument();
    },
    getPublicObject: (kind, ifNoneMatch) => objects.getPublicObject(kind, ifNoneMatch),
    assetsFetch: async request => new Response(`asset:${new URL(request.url).pathname}`),
    credentials: {},
    corsOrigin: ORIGIN,
    environment: {
      now: () => new Date('2026-10-26T18:05:00Z'),
      cache: memoryCache(),
      logger: () => {},
      fetch: awcFetch,
    },
  });
  return { router, objects, hydratedLoads: () => hydratedLoads };
}

const request = (path, init) => new Request(`https://stations.example${path}`, init);

test('unfilteredCatalogueKind only matches the catalogue route without filter parameters', () => {
  const kind = path => unfilteredCatalogueKind(new URL(`https://stations.example${path}`));
  assert.equal(kind('/api/stations/catalogue'), 'json');
  assert.equal(kind('/api/stations/catalogue/'), 'json');
  assert.equal(kind('/api/stations/catalogue?format=json'), 'json');
  assert.equal(kind('/api/stations/catalogue?format=geojson'), 'geojson');
  assert.equal(kind('/api/stations/catalogue?bbox=-123,47,-121,49'), null);
  assert.equal(kind('/api/stations/catalogue?format=geojson&limit=1'), null);
  assert.equal(kind('/api/stations/catalogue?country=US'), null);
  assert.equal(kind('/api/stations/feed'), null);
  assert.equal(kind('/catalogue'), null);
});

test('unfiltered catalogue streams the published object with cache and CORS headers', async () => {
  const { router, objects, hydratedLoads } = createFixture();

  const json = await router(request('/api/stations/catalogue'));
  assert.equal(json.status, 200);
  assert.equal(json.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(json.headers.get('ETag'), '"json-etag"');
  assert.equal(json.headers.get('Cache-Control'), 'public, max-age=300');
  assert.equal(json.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(json.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(json.headers.get('Content-Length'), '26');
  assert.equal(await json.text(), '{"stations":"public-json"}');

  const geojson = await router(request('/api/stations/catalogue?format=geojson'));
  assert.equal(geojson.status, 200);
  assert.equal(geojson.headers.get('Content-Type'), 'application/geo+json; charset=utf-8');
  assert.equal(geojson.headers.get('ETag'), '"geojson-etag"');
  assert.equal(await geojson.text(), '{"type":"FeatureCollection"}');

  assert.deepEqual(objects.calls, [
    { kind: 'json', ifNoneMatch: null },
    { kind: 'geojson', ifNoneMatch: null },
  ]);
  assert.equal(hydratedLoads(), 0, 'public objects never load the hydrated catalogue');
});

test('unfiltered catalogue honours If-None-Match and HEAD', async () => {
  const { router } = createFixture();

  const notModified = await router(
    request('/api/stations/catalogue', { headers: { 'If-None-Match': '"json-etag"' } }),
  );
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get('ETag'), '"json-etag"');
  assert.equal(notModified.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(await notModified.text(), '');

  const head = await router(request('/api/stations/catalogue', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), '26');
  assert.equal(head.headers.get('ETag'), '"json-etag"');
  assert.equal(await head.text(), '');
});

test('unpublished catalogue objects answer 503 without caching', async () => {
  const { router, objects } = createFixture();
  objects.published = false;
  const response = await router(request('/api/stations/catalogue?format=geojson'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.deepEqual(await response.json(), { error: 'catalogue not published' });
});

test('filtered catalogue and feed requests reach the API handler with the hydrated catalogue', async () => {
  const { router, objects, hydratedLoads } = createFixture();

  const filtered = await router(request('/api/stations/catalogue?country=US&limit=5'));
  assert.equal(filtered.status, 200);
  const catalogue = await filtered.json();
  assert.ok(catalogue.stations.length > 0 && catalogue.stations.length <= 5);
  assert.ok(catalogue.stations.every(station => Object.keys(station.locator).length === 0));
  assert.equal(filtered.headers.get('Access-Control-Allow-Origin'), ORIGIN);

  const feed = await router(request('/api/stations/feed?ids=awc:KSEA'));
  assert.equal(feed.status, 200);
  const stations = (await feed.json()).stations;
  assert.equal(stations.length, 1);
  assert.equal(stations[0].status, 'ok');
  assert.equal(stations[0].reading.temperatureC, 14.5);

  assert.equal(objects.calls.length, 0, 'handler routes never touch the public objects');
  assert.equal(hydratedLoads(), 2);
});

test('non-GET methods on the catalogue route go to the API handler', async () => {
  const { router, objects } = createFixture();
  const preflight = await router(request('/api/stations/catalogue', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Methods'), 'GET, HEAD, OPTIONS');
  const post = await router(request('/api/stations/catalogue', { method: 'POST' }));
  assert.equal(post.status, 405);
  assert.equal(objects.calls.length, 0);
});

test('requests outside /api/stations are delegated to static assets', async () => {
  const { router, hydratedLoads } = createFixture();
  for (const path of ['/', '/dist/app.js', '/index.html', '/api/stationsx/catalogue', '/missing']) {
    const response = await router(request(path));
    assert.equal(await response.text(), `asset:${path}`);
  }
  const notFound = await router(request('/api/stations'));
  assert.equal(notFound.status, 404);
  assert.equal(hydratedLoads(), 0, 'unknown API routes are rejected before the catalogue is loaded');
});
