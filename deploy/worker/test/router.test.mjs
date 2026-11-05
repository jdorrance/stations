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
    json: { etag: '"json-etag"', bytes: encoder.encode('{"stations":"public-json"}'), contentEncoding: null },
    geojson: { etag: '"geojson-etag"', bytes: encoder.encode('{"type":"FeatureCollection"}'), contentEncoding: null },
    live: { etag: '"live-etag"', bytes: encoder.encode('compressed-live-catalogue'), contentEncoding: 'gzip' },
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
        contentEncoding: object.contentEncoding,
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

function createFixture(options = {}) {
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
    ...options,
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
  assert.equal(kind('/api/stations/catalogue?profile=live'), 'live');
  assert.equal(kind('/api/stations/catalogue?profile=live&format=geojson'), null);
  assert.equal(kind('/api/stations/catalogue?profile=unknown'), null);
  assert.equal(kind('/api/stations/catalogue?bbox=-123,47,-121,49'), null);
  assert.equal(kind('/api/stations/catalogue?format=geojson&limit=1'), null);
  assert.equal(kind('/api/stations/catalogue?profile=live&country=US'), null);
  assert.equal(kind('/api/stations/catalogue?country=US'), null);
  assert.equal(kind('/api/stations/catalogue?v=1'), 'json');
  assert.equal(kind('/api/stations/feed'), null);
  assert.equal(kind('/catalogue'), null);
});

function responseCache() {
  const entries = new Map();
  return {
    async match(key) { return entries.get(key.url)?.clone(); },
    async put(key, response) {
      entries.set(key.url, new Response(await response.arrayBuffer(), { headers: response.headers }));
    },
  };
}

test('public edge cache streams repeat requests and handles HEAD/ETag without R2 or hydration', async () => {
  let nowMs = Date.parse('2026-10-26T18:05:00Z');
  const { router, objects, hydratedLoads } = createFixture({
    responseCache: responseCache(), catalogueCacheSeconds: 10,
    environment: { now: () => new Date(nowMs), cache: memoryCache(), fetch: awcFetch, logger: () => {} },
  });
  assert.equal(await (await router(request('/api/stations/catalogue?v=1'))).text(), '{"stations":"public-json"}');
  nowMs += 2000;
  const hit = await router(request('/api/stations/catalogue'));
  assert.equal(hit.headers.get('Age'), '2');
  assert.equal(await hit.text(), '{"stations":"public-json"}');
  const notModified = await router(request('/api/stations/catalogue', { headers: { 'If-None-Match': 'W/"other", W/"json-etag"' } }));
  assert.equal(notModified.status, 304);
  assert.equal(await notModified.text(), '');
  const head = await router(request('/api/stations/catalogue', { method: 'HEAD' }));
  assert.equal(head.headers.get('Content-Length'), '26');
  assert.equal(await head.text(), '');
  assert.equal(objects.calls.length, 1);
  assert.equal(hydratedLoads(), 0);
  nowMs += 8000;
  await (await router(request('/api/stations/catalogue'))).text();
  assert.equal(objects.calls.length, 2, 'physical cache expiry is checked even by a fake cache');
});

test('zero catalogue cache TTL bypasses cache I/O and streams R2 directly', async () => {
  let cacheCalls = 0;
  const forbidden = {
    match: async () => { cacheCalls++; return undefined; },
    put: async () => { cacheCalls++; },
  };
  const { router, objects, hydratedLoads } = createFixture({ responseCache: forbidden, catalogueCacheSeconds: 0 });
  for (let i = 0; i < 2; i++) {
    assert.equal(await (await router(request('/api/stations/catalogue'))).text(), '{"stations":"public-json"}');
  }
  assert.equal(objects.calls.length, 2);
  assert.equal(cacheCalls, 0);
  assert.equal(hydratedLoads(), 0);
});

test('current response hits avoid catalogue hydration and preserve actual observation age', async () => {
  let nowMs = Date.parse('2026-10-26T18:05:00Z');
  const { router, hydratedLoads } = createFixture({
    responseCache: responseCache(), responseCacheSeconds: 5,
    environment: { now: () => new Date(nowMs), cache: memoryCache(), fetch: awcFetch, logger: () => {} },
  });
  const path = '/api/stations/current?station=awc:KSEA';
  const first = await (await router(request(path))).json();
  nowMs += 2000;
  const response = await router(request(path));
  const second = await response.json();
  assert.equal(response.headers.get('X-Response-Cache'), 'hit');
  assert.equal(response.headers.get('Age'), '2');
  assert.equal(response.headers.get('X-Station-Cache'), 'fill');
  assert.equal(second.servedAt, first.servedAt);
  assert.equal(second.station.reading.observedAt, first.station.reading.observedAt);
  assert.equal(hydratedLoads(), 1, 'cache hit precedes hydrated catalogue access');
  nowMs += 3000;
  await router(request(path));
  assert.equal(hydratedLoads(), 2, 'response cache lifetime is bounded');
});

test('response cache scopes credentials and does not cache failed snapshots', async () => {
  const cache = responseCache();
  const fixture = createFixture({ responseCache: cache });
  const path = '/api/stations/feed?ids=awc:KSEA&history=0';
  assert.equal((await fixture.router(request(path))).status, 200);
  assert.equal((await fixture.router(request(path))).headers.get('X-Response-Cache'), 'hit');
  const other = createFixture({ responseCache: cache, credentials: { synopticToken: 'different-scope' } });
  assert.equal((await other.router(request(path))).headers.get('X-Response-Cache'), null);
  assert.equal(other.hydratedLoads(), 1);
  const missing = '/api/stations/current?station=custom:missing';
  assert.equal((await fixture.router(request(missing))).status, 404);
  assert.equal((await fixture.router(request(missing))).headers.get('X-Response-Cache'), null);
});

test('a new isolate serves a short-lived current response before loading its catalogue', async () => {
  const cache = responseCache();
  const first = createFixture({ responseCache: cache });
  const path = '/api/stations/current?station=awc:KSEA';
  await first.router(request(path));
  const cold = createFixture({ responseCache: cache, loadHydrated: async () => { throw new Error('must not hydrate'); } });
  const response = await cold.router(request(path));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Response-Cache'), 'hit');
});

test('response retention cannot exceed remaining station freshness or a known catalogue revision', async () => {
  let nowMs = Date.parse('2026-10-26T18:05:00Z');
  let document = hydratedDocument();
  let loads = 0;
  const { router } = createFixture({
    responseCache: responseCache(), responseCacheSeconds: 30,
    cachePolicy: { freshSeconds: 2, maxAgeSeconds: 30 },
    loadHydrated: async () => { loads++; return document; },
    environment: { now: () => new Date(nowMs), cache: memoryCache(), fetch: awcFetch, logger: () => {} },
  });
  const path = '/api/stations/current?station=awc:KSEA';
  await router(request(path));
  nowMs += 1000;
  const hit = await router(request(path));
  assert.equal(hit.headers.get('X-Response-Cache'), 'hit');
  assert.equal(hit.headers.get('X-Station-Cache-Ttl'), '1');
  document = { ...document, generatedAt: '2026-10-28T00:00:00Z' };
  await router(request('/api/stations/catalogue?limit=1'));
  const revised = await router(request(path));
  assert.equal(revised.headers.get('X-Response-Cache'), null);
  assert.equal(revised.headers.get('X-Station-Catalogue-Revision'), document.generatedAt);
  nowMs += 2000;
  const expired = await router(request(path));
  assert.equal(expired.headers.get('X-Response-Cache'), null);
  assert.equal(loads, 4);
});

test('edge cache failures leave successful source responses intact', async () => {
  const broken = { match: async () => { throw new Error('offline'); }, put: async () => { throw new Error('offline'); } };
  const { router } = createFixture({ responseCache: broken });
  assert.equal((await router(request('/api/stations/catalogue'))).status, 200);
  assert.equal((await router(request('/api/stations/current?station=awc:KSEA'))).status, 200);
});

test('a stalled edge cache falls through within the configured cache I/O budget', async () => {
  const stalled = { match: () => new Promise(() => {}), put: () => new Promise(() => {}) };
  const { router, objects } = createFixture({ responseCache: stalled, cachePolicy: { cacheTimeoutMs: 5 }, cacheFillTimeoutMs: 5 });
  assert.equal((await router(request('/api/stations/catalogue'))).status, 200);
  assert.equal(objects.calls.length, 1);
});

test('streaming catalogue fills have a longer deadline than cache reads', async () => {
  let reads = 0;
  const { router } = createFixture({
    responseCache: responseCache(), cachePolicy: { cacheTimeoutMs: 1 }, cacheFillTimeoutMs: 100,
    getPublicObject: async () => {
      reads++;
      return {
        etag: '"slow"', size: 4, contentEncoding: null,
        body: new ReadableStream({
          start(controller) {
            setTimeout(() => { controller.enqueue(encoder.encode('slow')); controller.close(); }, 20);
          },
        }),
      };
    },
  });
  assert.equal(await (await router(request('/api/stations/catalogue'))).text(), 'slow');
  assert.equal(await (await router(request('/api/stations/catalogue'))).text(), 'slow');
  assert.equal(reads, 1, 'body transfer outlives the read budget and still fills the cache');
});

test('unfiltered catalogue streams the published object with cache and CORS headers', async () => {
  const { router, objects, hydratedLoads } = createFixture();

  const json = await router(request('/api/stations/catalogue'));
  assert.equal(json.status, 200);
  assert.equal(json.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(json.headers.get('ETag'), '"json-etag"');
  assert.equal(json.headers.get('Cache-Control'), 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400');
  assert.equal(json.headers.get('Vary'), 'Accept-Encoding');
  assert.equal(json.headers.get('Content-Encoding'), null);
  assert.equal(json.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(json.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(json.headers.get('Content-Length'), '26');
  assert.equal(await json.text(), '{"stations":"public-json"}');

  const geojson = await router(request('/api/stations/catalogue?format=geojson'));
  assert.equal(geojson.status, 200);
  assert.equal(geojson.headers.get('Content-Type'), 'application/geo+json; charset=utf-8');
  assert.equal(geojson.headers.get('ETag'), '"geojson-etag"');
  assert.equal(await geojson.text(), '{"type":"FeatureCollection"}');

  // The lean profile streams the pre-gzipped object with its encoding echoed.
  const live = await router(request('/api/stations/catalogue?profile=live'));
  assert.equal(live.status, 200);
  assert.equal(live.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(live.headers.get('Content-Encoding'), 'gzip');
  assert.equal(live.headers.get('Vary'), 'Accept-Encoding');
  assert.equal(live.headers.get('ETag'), '"live-etag"');
  assert.equal(await live.text(), 'compressed-live-catalogue');

  assert.deepEqual(objects.calls, [
    { kind: 'json', ifNoneMatch: null },
    { kind: 'geojson', ifNoneMatch: null },
    { kind: 'live', ifNoneMatch: null },
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
