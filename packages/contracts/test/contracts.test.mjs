import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATALOGUE_SCHEMA_VERSION,
  STATION_SCHEMA_VERSION,
  catalogueToGeoJson,
  feedToGeoJson,
  formatStationUid,
  mergeCatalogueStations,
  parseCatalogueStation,
  parseStationCatalogueJson,
  parseStationFeedJson,
  parseStationUid,
} from '../dist/index.js';

const sampleCatalogueStation = {
  uid: 'windnerd:tiger-mtn',
  vendor: 'windnerd',
  nativeId: 'tiger-mtn',
  name: 'Tiger Mountain North',
  latitude: 47.4995,
  longitude: -122.009,
  elevationM: 730,
  country: 'US',
  region: 'WA',
  timeZone: 'America/Los_Angeles',
  pageUrl: 'https://windnerd.net/stations/tiger-mtn',
  capabilities: {
    gustLull: true,
    temperature: true,
    conditions: false,
    history: true,
    live: true,
  },
  samplingWindowSeconds: 60,
  recommendedPollSeconds: 60,
  locator: {
    stationKey: 'tiger-mtn',
    locationId: 101,
  },
};

test('formatStationUid, parseStationUid, and parseCatalogueStation validate station records', () => {
  assert.equal(formatStationUid('windnerd', 'tiger-mtn'), 'windnerd:tiger-mtn');
  assert.deepEqual(parseStationUid('openwindmap:412'), { vendor: 'openwindmap', nativeId: '412' });
  assert.equal(parseStationUid('unknown:412'), null);
  assert.equal(parseStationUid('invalid'), null);

  const valid = parseCatalogueStation(sampleCatalogueStation);
  assert.ok(valid);
  assert.equal(valid.uid, 'windnerd:tiger-mtn');

  const mismatchedUid = parseCatalogueStation({
    ...sampleCatalogueStation,
    uid: 'windnerd:wrong-id',
  });
  assert.equal(mismatchedUid, null);
});

test('parseStationCatalogueJson and mergeCatalogueStations deduplicate and enrich records', () => {
  const merged = mergeCatalogueStations([
    [{ ...sampleCatalogueStation, elevationM: null, region: null }],
    [{ ...sampleCatalogueStation, elevationM: 730, region: 'WA' }],
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].elevationM, 730);
  assert.equal(merged[0].region, 'WA');

  const doc = {
    schemaVersion: CATALOGUE_SCHEMA_VERSION,
    generatedAt: '2026-10-26T12:00:00Z',
    regions: ['US', 'CA', 'MX', 'AM'],
    stations: merged,
  };
  const parsed = parseStationCatalogueJson(JSON.stringify(doc));
  assert.ok(parsed);
  assert.equal(parsed.stations.length, 1);
});

test('catalogueToGeoJson and feedToGeoJson emit valid GeoJSON FeatureCollections for maps and Windy', () => {
  const catalogueGeo = catalogueToGeoJson([sampleCatalogueStation], '2026-10-26T12:00:00Z');
  assert.equal(catalogueGeo.type, 'FeatureCollection');
  assert.equal(catalogueGeo.features.length, 1);
  assert.deepEqual(catalogueGeo.features[0].geometry.coordinates, [-122.009, 47.4995, 730]);
  assert.equal(catalogueGeo.features[0].properties.status, 'catalogue');

  const rawFeed = {
    schemaVersion: STATION_SCHEMA_VERSION,
    servedAt: '2026-10-26T12:00:30Z',
    primaryStationId: 'windnerd:tiger-mtn',
    stations: [
      {
        id: 'windnerd:tiger-mtn',
        name: 'Tiger Mountain North',
        sourceLabel: 'WindNerd',
        pageUrl: 'https://windnerd.net/stations/tiger-mtn',
        latitude: 47.4995,
        longitude: -122.009,
        timeZone: 'America/Los_Angeles',
        elevationM: 730,
        capabilities: {
          gustLull: true,
          temperature: true,
          conditions: false,
          history: true,
        },
        samplingWindowSeconds: 60,
        recommendedPollSeconds: 60,
        status: 'ok',
        reading: {
          observedAt: '2026-10-26T12:00:00Z',
          windAvgMps: 6.2,
          windDirectionDeg: 315,
          windGustMps: 8.4,
          windLullMps: 4.1,
          temperatureC: 14.5,
          windChillC: null,
          conditions: null,
        },
        history: null,
      },
    ],
  };
  const feed = parseStationFeedJson(JSON.stringify(rawFeed));
  assert.ok(feed);
  const byUid = new Map([[sampleCatalogueStation.uid, sampleCatalogueStation]]);
  const liveGeo = feedToGeoJson(feed, byUid);
  assert.equal(liveGeo.features.length, 1);
  assert.equal(liveGeo.features[0].properties.status, 'ok');
  assert.equal(liveGeo.features[0].properties.freshness, 'live');
  assert.equal(liveGeo.features[0].properties.windCompass, 'NW');
  assert.equal(liveGeo.features[0].properties.country, 'US');
});
