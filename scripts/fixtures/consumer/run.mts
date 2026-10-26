// Smoke test: discover catalogue, mount handler, query via client and viewport store.
import assert from 'node:assert/strict';
import { INITIAL_SCOPE_REGIONS, inferRegionCode } from '@stations/geography';
import { formatStationUid, parseStationUid } from '@stations/contracts';
import {
  INITIAL_SEED_STATIONS,
  createStationsApiHandler,
  discoverStations,
  memoryCache,
} from '@stations/providers';
import {
  createCatalogueIndex,
  createStationsClient,
  createViewportStationStore,
} from '@stations/client';

assert.deepEqual(INITIAL_SCOPE_REGIONS, ['US', 'CA', 'MX', 'AM']);
assert.equal(inferRegionCode({ latitude: 40.2727, longitude: 44.7074 }), 'AM');
assert.equal(formatStationUid('windnerd', 'tiger-mountain'), 'windnerd:tiger-mountain');
assert.deepEqual(parseStationUid('holfuy:1652'), { vendor: 'holfuy', nativeId: '1652' });

const environment = {
  now: () => new Date('2026-10-26T18:05:00Z'),
  cache: memoryCache(),
  logger: () => {},
  fetch: async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes('api.holfuy.com')) {
      return new Response(
        JSON.stringify({
          stationId: 1652,
          dateTime: '2026-10-26 18:02:00',
          wind: { speed: 6.8, gust: 9.4, min: 4.5, unit: 'm/s', direction: 190 },
          temperature: 16.0,
          humidity: 45,
          pressure: 1016.0,
          battery: 12.8,
        }),
        { status: 200 },
      );
    }
    return new Response('unavailable', { status: 502 });
  },
};

const catalogue = await discoverStations({
  seeds: INITIAL_SEED_STATIONS,
  includeRemoteDiscovery: false,
  environment,
});
assert.ok(catalogue.stations.length >= 14);

const handler = createStationsApiHandler({
  catalogue,
  environment,
  basePath: '/api/stations',
});

const client = createStationsClient({
  baseUrl: 'https://stations.example/api/stations',
  fetch: input => handler(new Request(input instanceof Request ? input.url : String(input))),
});

const index = await client.loadCatalogueIndex();
assert.ok(index);
assert.equal(index.size, catalogue.stations.length);
assert.equal(createCatalogueIndex(catalogue).size, catalogue.stations.length);

const viewport = createViewportStationStore({
  client,
  countries: ['AM'],
  vendors: ['holfuy'],
  catalogueByUid: index.byUidMap,
});
const snap = await viewport.setViewport([43.44, 38.84, 46.63, 41.30]);
assert.ok(snap.feed);
assert.equal(snap.feed.stations.length, 1);
assert.equal(snap.feed.stations[0]!.status, 'ok');
assert.ok(snap.geojson);
assert.equal(snap.geojson.features.length, 1);
assert.equal(snap.geojson.features[0]!.properties.windAvgMps, 6.8);

console.log('Independent typed consumer: discovery -> spatial index -> handler -> viewport GeoJSON/Feed store passed.');
