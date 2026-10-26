import assert from 'node:assert/strict';
import test from 'node:test';
import { createStationsApiHandler } from '../dist/index.js';

function station(id, overrides = {}) {
  return {
    uid: `custom:${id}`, vendor: 'custom', nativeId: id, name: id,
    latitude: 40, longitude: 44, elevationM: null, country: 'AM',
    region: null, timeZone: null, pageUrl: null,
    capabilities: { gustLull: false, temperature: false, conditions: false, history: false },
    samplingWindowSeconds: null, recommendedPollSeconds: 60, locator: {},
    ...overrides,
  };
}

function catalogue(stations) {
  return { schemaVersion: 1, generatedAt: '2026-10-26T12:00:00Z', regions: ['US', 'CA', 'MX', 'AM'], stations };
}

const request = path => new Request(`https://stations.test/api/stations/${path}`);

test('public catalogue strips all private locators and unexpected fields without mutating the source', async () => {
  const secret = 'FAKE_REVIEW_SECRET';
  const original = station('private', {
    locator: { token: secret, password: secret, arbitraryCredential: secret, locationId: 201 },
    privateKey: secret,
  });
  const handler = createStationsApiHandler({ catalogue: catalogue([original]), basePath: '/api/stations' });
  for (const suffix of ['', '?format=geojson']) {
    const response = await handler(request(`catalogue${suffix}`));
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(text.includes(secret), false);
    if (!suffix) assert.deepEqual(JSON.parse(text).stations[0].locator, {});
  }
  assert.equal(original.locator.token, secret);
  assert.equal(original.locator.locationId, 201);
});

test('near searches filter country and vendor before limit for both catalogue and feed', async () => {
  const stations = [
    station('closest', { uid: 'awc:TEST', vendor: 'awc', nativeId: 'TEST', country: 'US' }),
    station('wrong-country', { latitude: 40.01, country: 'CA' }),
    station('match', { latitude: 40.02, country: 'US' }),
  ];
  const handler = createStationsApiHandler({ catalogue: catalogue(stations), basePath: '/api/stations' });
  for (const route of ['catalogue', 'feed']) {
    const response = await handler(request(`${route}?near=40,44,20&country=US&vendor=custom&limit=1`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.stations.map(station => station.uid ?? station.id), ['custom:match']);
  }
});

test('invalid filters fail closed and repeated station IDs are deduplicated', async () => {
  const handler = createStationsApiHandler({ catalogue: catalogue([station('one')]), basePath: '/api/stations' });
  for (const query of ['country=typo', 'country=', 'vendor=custom,typo', 'vendor=']) {
    assert.equal((await handler(request(`catalogue?${query}`))).status, 400);
  }
  const body = await (await handler(request('feed?ids=custom:one,custom:one'))).json();
  assert.equal(body.stations.length, 1);
  assert.equal((await handler(request('catalogue?country=am&vendor=CUSTOM'))).status, 200);
});

test('catalogue indexes are reused and invalidated for changed revisions or station arrays', async () => {
  let latitudeReads = 0;
  const entry = station('one');
  Object.defineProperty(entry, 'latitude', { get() { latitudeReads += 1; return 40; } });
  let document = catalogue([entry]);
  const handler = createStationsApiHandler({ catalogue: () => document, basePath: '/api/stations' });
  assert.equal((await handler(request('current?station=missing'))).status, 404);
  const initialReads = latitudeReads;
  assert.ok(initialReads > 0);
  assert.equal((await handler(request('current?station=missing'))).status, 404);
  assert.equal(latitudeReads, initialReads);
  document = { ...document, generatedAt: '2026-10-26T13:00:00Z' };
  await handler(request('current?station=missing'));
  assert.ok(latitudeReads > initialReads);
  document = { ...document, stations: [station('replacement', { longitude: 45 })] };
  const body = await (await handler(request('catalogue?bbox=44.9,39.9,45.1,40.1'))).json();
  assert.deepEqual(body.stations.map(station => station.uid), ['custom:replacement']);
});

test('world bounds include catalogue stations away from the antimeridian', async () => {
  const handler = createStationsApiHandler({ catalogue: catalogue([station('one')]), basePath: '/api/stations' });
  const body = await (await handler(request('catalogue?bbox=-180,-90,180,90'))).json();
  assert.deepEqual(body.stations.map(station => station.uid), ['custom:one']);
});

test('aliases resolve consistently for catalogue, current, history and live routes', async () => {
  const handler = createStationsApiHandler({
    catalogue: catalogue([station('canonical', { aliases: ['custom:legacy'] })]),
    basePath: '/api/stations',
  });
  const current = await handler(request('current?station=custom:legacy'));
  assert.equal(current.status, 200);
  assert.equal((await current.json()).station.id, 'custom:canonical');
  const history = await handler(request('history?station=custom:legacy&from=2026-10-25T00:00:00Z&to=2026-10-25T01:00:00Z&period=5'));
  assert.equal((await history.json()).error, 'station has no browsable archive');
  const live = await handler(request('live?station=custom:legacy'));
  assert.equal((await live.json()).error, 'station has no live stream');
});

test('GeoJSON and JSON feeds apply the same history-window validation', async () => {
  const handler = createStationsApiHandler({ catalogue: catalogue([station('one')]), basePath: '/api/stations', maxHistoryHours: 2 });
  for (const suffix of ['', '&format=geojson']) {
    for (const hours of ['3', '0', 'NaN']) {
      const response = await handler(request(`feed?hours=${hours}${suffix}`));
      assert.equal(response.status, 400);
    }
    assert.equal((await handler(request(`feed?hours=1${suffix}`))).status, 200);
  }
});

test('invalid limits and incomplete near parameters cannot broaden expensive feed requests', async () => {
  for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createStationsApiHandler({ catalogue: catalogue([]), maxFeedStations: value }));
  }
  const handler = createStationsApiHandler({ catalogue: catalogue([station('one')]) });
  for (const query of ['near=,44,20', 'near=40,,20', 'limit=9007199254740992']) {
    assert.equal((await handler(request(`feed?${query}`))).status, 400);
  }
});
