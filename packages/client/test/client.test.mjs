import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryCache } from '@azohra/meteo.station/server';
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
