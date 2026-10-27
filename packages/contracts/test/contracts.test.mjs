import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CATALOGUE_SCHEMA_VERSION,
  STATION_SCHEMA_VERSION,
  catalogueToGeoJson,
  deduplicateCatalogueStations,
  enrichStationsWithLaunches,
  feedToGeoJson,
  formatStationUid,
  mergeCatalogueStations,
  parseCatalogueNdjson,
  parseCatalogueStation,
  parseStationCatalogueJson,
  parseStationFeedJson,
  parseStationUid,
  pilotFreshness,
  pilotFreshnessThresholds,
  serializeCatalogueNdjson,
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

test('formatStationUid, parseStationUid, and parseCatalogueStation validate station records across all vendors', () => {
  assert.equal(formatStationUid('windnerd', 'tiger-mtn'), 'windnerd:tiger-mtn');
  assert.deepEqual(parseStationUid('openwindmap:412'), { vendor: 'openwindmap', nativeId: '412' });
  assert.deepEqual(parseStationUid('raws:451702'), { vendor: 'raws', nativeId: '451702' });
  assert.deepEqual(parseStationUid('windsmobi:holfuy-1652'), {
    vendor: 'windsmobi',
    nativeId: 'holfuy-1652',
  });
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

test('parseStationCatalogueJson, deduplicateCatalogueStations, and enrichStationsWithLaunches work as expected', () => {
  const merged = mergeCatalogueStations([
    [{ ...sampleCatalogueStation, elevationM: null, region: null }],
    [{ ...sampleCatalogueStation, elevationM: 730, region: 'WA' }],
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].elevationM, 730);
  assert.equal(merged[0].region, 'WA');

  const awcKsea = {
    ...sampleCatalogueStation,
    uid: 'awc:KSEA',
    vendor: 'awc',
    nativeId: 'KSEA',
    name: 'Seattle-Tacoma International',
    latitude: 47.449,
    longitude: -122.309,
    locator: { icaoId: 'KSEA' },
  };
  const iemSea = {
    ...sampleCatalogueStation,
    uid: 'iem:SEA',
    vendor: 'iem',
    nativeId: 'SEA',
    name: 'Seattle Tacoma Airport',
    latitude: 47.4492,
    longitude: -122.3094,
    locator: { network: 'WA_ASOS' },
  };
  const nwsKsea = {
    ...sampleCatalogueStation,
    uid: 'nws:KSEA',
    vendor: 'nws',
    nativeId: 'KSEA',
    name: 'Seattle, Seattle-Tacoma International Airport',
    latitude: 47.4447,
    longitude: -122.3136,
    locator: { stationId: 'KSEA' },
  };

  const deduped = deduplicateCatalogueStations([nwsKsea, iemSea, awcKsea]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].uid, 'awc:KSEA');
  assert.deepEqual(deduped[0].aliases, ['iem:SEA', 'nws:KSEA']);
  assert.equal(deduped[0].category, 'synoptic');

  const enriched = enrichStationsWithLaunches(
    [sampleCatalogueStation],
    [{ slug: 'wa-tiger-mountain', name: 'Tiger Mountain', latitude: 47.4995, longitude: -122.009 }],
    50,
  );
  assert.ok(enriched[0].launchContext);
  assert.equal(enriched[0].launchContext.nearestLaunchSlug, 'wa-tiger-mountain');
  assert.equal(enriched[0].launchContext.distanceKm, 0);

  const ndjson = serializeCatalogueNdjson(enriched);
  const roundTrip = parseCatalogueNdjson(ndjson);
  assert.equal(roundTrip.length, 1);
  assert.equal(roundTrip[0].launchContext?.nearestLaunchSlug, 'wa-tiger-mountain');

  const doc = {
    schemaVersion: CATALOGUE_SCHEMA_VERSION,
    generatedAt: '2026-10-26T12:00:00Z',
    regions: ['US', 'CA', 'MX', 'AM'],
    stations: enriched,
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
  assert.equal(catalogueGeo.features[0].properties.category, 'freeflight');

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

  // Pilot freshness thresholds: free-flight windtalkers become aging after 4m and stale after 15m
  const ffLimits = pilotFreshnessThresholds({ recommendedPollSeconds: 60 }, 'freeflight');
  assert.deepEqual(ffLimits, { currentForMs: 240_000, staleAfterMs: 900_000 });
  const nowMs = Date.parse('2026-10-26T12:20:00Z');
  const servedAt = '2026-10-26T12:20:00Z';
  assert.equal(
    pilotFreshness({ observedAt: '2026-10-26T12:17:00Z', servedAt, receivedAtMs: nowMs, nowMs }, { recommendedPollSeconds: 60 }, 'freeflight'),
    'live',
  );
  assert.equal(
    pilotFreshness({ observedAt: '2026-10-26T12:10:00Z', servedAt, receivedAtMs: nowMs, nowMs }, { recommendedPollSeconds: 60 }, 'freeflight'),
    'aging',
  );
  assert.equal(
    pilotFreshness({ observedAt: '2026-10-26T12:04:00Z', servedAt, receivedAtMs: nowMs, nowMs }, { recommendedPollSeconds: 60 }, 'freeflight'),
    'stale',
  );

  // Distant records (>50km) with the same UID must not inherit wrong country/region from an unverified seed
  const distantMerge = mergeCatalogueStations([
    [{ ...sampleCatalogueStation, uid: 'holfuy:1652', vendor: 'holfuy', nativeId: '1652', country: 'AM', region: 'Kotayk', latitude: 40.27, longitude: 44.71 }],
    [{ ...sampleCatalogueStation, uid: 'holfuy:1652', vendor: 'holfuy', nativeId: '1652', country: null, region: null, timeZone: null, latitude: 46.67, longitude: 2.53 }],
  ]);
  assert.equal(distantMerge[0].country, null);
  assert.equal(distantMerge[0].region, null);
  assert.equal(distantMerge[0].timeZone, null);
});
