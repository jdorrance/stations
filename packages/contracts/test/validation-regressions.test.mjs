import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogueStationSchema, parseCatalogueStation, parseStationCatalogue,
  serializeCatalogueNdjson, toPublicCatalogueStation, toPublicStationCatalogue,
  deduplicateCatalogueStations, enrichStationsWithLaunches, parseCatalogueNdjson,
} from '../dist/index.js';

const station = {
  uid: 'custom:sample', vendor: 'custom', nativeId: 'sample', name: 'Sample',
  latitude: 40, longitude: 44, elevationM: null, country: null,
  region: null, timeZone: null, pageUrl: null,
  capabilities: { gustLull: false, temperature: false, conditions: false, history: false },
  samplingWindowSeconds: null, recommendedPollSeconds: 60, locator: {},
};

test('schema and nullable parsers reject whitespace IDs without throwing', () => {
  for (const nativeId of ['', ' ', '\t\n']) {
    const invalid = { ...station, nativeId };
    assert.equal(catalogueStationSchema.safeParse(invalid).success, false);
    assert.equal(parseCatalogueStation(invalid), null);
    assert.equal(parseStationCatalogue({
      schemaVersion: 1, generatedAt: '2026-10-26T12:00:00Z', regions: [], stations: [invalid],
    }), null);
  }
  assert.equal(parseCatalogueStation({ ...station, nativeId: ' sample ' }).nativeId, 'sample');
});

test('public JSON and NDJSON serialization cannot expose adapter credentials', () => {
  const secret = 'FAKE_REVIEW_SECRET';
  const privateStation = { ...station, locator: { token: secret, password: secret }, apiKey: secret };
  const document = { schemaVersion: 1, generatedAt: '2026-10-26T12:00:00Z', regions: [], stations: [privateStation] };
  for (const text of [
    JSON.stringify(toPublicCatalogueStation(privateStation)),
    JSON.stringify(toPublicStationCatalogue(document)),
    serializeCatalogueNdjson([privateStation]),
  ]) assert.equal(text.includes(secret), false);
  assert.deepEqual(toPublicCatalogueStation(privateStation).locator, {});
  assert.equal(privateStation.locator.token, secret);
});


function record(vendor, nativeId, overrides = {}) {
  return { ...station, vendor, nativeId, uid: `${vendor}:${nativeId}`, name: `${vendor} ${nativeId}`, ...overrides };
}

test('deduplication merges shared aliases and transitive bridges independently of input order', () => {
  const first = record('holfuy', '1', { aliases: ['custom:shared'], locator: { stationId: '1' } });
  const second = record('windsmobi', '2', { aliases: ['custom:shared', 'windspion:3'], locator: { windsMobiId: '2', token: 'PRIVATE' } });
  const third = record('windspion', '3');
  const expected = deduplicateCatalogueStations([first, second, third]);
  assert.equal(expected.length, 1);
  assert.equal(expected[0].uid, first.uid);
  assert.deepEqual(expected[0].aliases, ['custom:shared', second.uid, third.uid]);
  assert.deepEqual(expected[0].locator, { stationId: '1' });
  assert.deepEqual(deduplicateCatalogueStations([third, second, first]), expected);
  // A bridge discovered after both higher-priority endpoints must collapse both groups.
  const a = record('holfuy', '10');
  const b = record('openwindmap', '20');
  const bridge = record('windsmobi', '30', { aliases: [a.uid, b.uid] });
  assert.equal(deduplicateCatalogueStations([a, b, bridge]).length, 1);
});

test('canonical-code dedup considers every location and does not infer ICAO for non-airport IEM networks', () => {
  const distant = record('awc', 'KABC', { latitude: 0, longitude: 0 });
  const near = record('nws', 'KABC', { latitude: 40, longitude: 44 });
  const duplicate = record('iem', 'ABC', { country: 'US', latitude: 40, longitude: 44, locator: { network: 'WA_ASOS' } });
  const merged = deduplicateCatalogueStations([distant, near, duplicate]);
  assert.equal(merged.length, 2);
  assert.ok(merged.find(item => item.uid === duplicate.uid).aliases.includes(near.uid));
  const dcp = { ...duplicate, locator: { network: 'WA_DCP' } };
  assert.equal(deduplicateCatalogueStations([near, dcp]).length, 2);
});

test('co-location matches across the date line but does not merge separate same-vendor instruments', () => {
  const a = record('holfuy', '1', { name: 'Summit Station', latitude: 0, longitude: 179.9999 });
  const b = record('windsmobi', '2', { name: 'Summit Station', latitude: 0, longitude: -179.9999 });
  assert.equal(deduplicateCatalogueStations([a, b]).length, 1);
  const sameVendor = { ...b, vendor: 'holfuy', uid: 'holfuy:2' };
  assert.equal(deduplicateCatalogueStations([a, sameVendor]).length, 2);
});

test('launch enrichment replaces obsolete contexts and defines bearing from launch to station', () => {
  const launch = { slug: 'launch', name: 'Launch', latitude: 40, longitude: 44 };
  const point = { ...station, latitude: 40.01 };
  const [enriched] = enrichStationsWithLaunches([point], [launch], 5);
  assert.equal(enriched.launchContext.nearestLaunchSlug, 'launch');
  assert.equal(enriched.launchContext.bearingDeg, 0);
  assert.equal(enrichStationsWithLaunches([enriched], [], 5)[0].launchContext, null);
  assert.equal(enrichStationsWithLaunches([enriched], [launch], 0)[0].launchContext, null);
  assert.throws(() => enrichStationsWithLaunches([point], [launch], NaN), RangeError);
});

test('schema validates ISO timestamps and canonical alias IDs; NDJSON skips malformed records', () => {
  for (const aliases of [['bad'], ['unknown:1'], ['holfuy: 1'], ['holfuy:']]) {
    assert.equal(parseCatalogueStation({ ...station, aliases }), null);
  }
  for (const generatedAt of ['0', 'October 26, 2026', '2026-02-30T12:00:00Z']) {
    assert.equal(parseStationCatalogue({ schemaVersion: 1, generatedAt, regions: [], stations: [] }), null);
  }
  assert.ok(parseStationCatalogue({ schemaVersion: 1, generatedAt: '2026-10-26T12:00:00+04:00', regions: [], stations: [] }));
  const valid = JSON.stringify(station);
  assert.deepEqual(parseCatalogueNdjson(`\n${valid}\r\n{\n{}\n${JSON.stringify({ ...station, latitude: 95 })}\n`), [station]);
});


test('network-qualified IEM airport IDs still deduplicate with direct aviation providers', () => {
  const awc = record('awc', 'KSEA', { country: 'US', locator: { icaoId: 'KSEA' } });
  const nws = record('nws', 'KSEA', { country: 'US' });
  const iem = record('iem', 'WA_ASOS:SEA', { country: 'US', locator: { network: 'WA_ASOS', stationId: 'SEA' } });
  const merged = deduplicateCatalogueStations([iem, nws, awc]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].uid, 'awc:KSEA');
  assert.deepEqual(merged[0].aliases, ['iem:WA_ASOS:SEA', 'nws:KSEA']);
  const caAwc = record('awc', 'CYVR', { country: 'CA' });
  const caIem = record('iem', 'CA_ASOS:CYVR', { country: 'CA', locator: { network: 'CA_ASOS', stationId: 'CYVR' } });
  assert.equal(deduplicateCatalogueStations([caAwc, caIem]).length, 1);
  assert.equal(deduplicateCatalogueStations([awc, { ...iem, locator: { network: 'WA_DCP', stationId: 'SEA' } }]).length, 2);
});
