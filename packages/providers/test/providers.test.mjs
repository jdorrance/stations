import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryCache } from '@azohra/meteo.station/server';
import {
  INITIAL_SEED_STATIONS,
  createStationsApiHandler,
  discoverStations,
  loadAwcStation,
  loadHolfuyStation,
  loadOpenWindMapStation,
  parseAwcMetarList,
  parseHolfuyObservation,
  parseOpenWindMapArchive,
} from '../dist/index.js';

const openWindMapFixture = JSON.stringify({
  data: [
    {
      id: 618,
      meta: { name: 'Monte Alto Launch (Valle de Bravo)' },
      location: { latitude: 19.1672, longitude: -100.1235, altitude: 2150 },
      measurements: {
        date: '2026-10-26T18:00:00.000Z',
        wind_heading: 225,
        wind_speed_avg: 18.0,
        wind_speed_max: 25.2,
        wind_speed_min: 10.8,
        pressure: 1014.2,
      },
    },
    {
      id: 999,
      meta: { name: 'Chamonix Planpraz' },
      location: { latitude: 45.936, longitude: 6.851, altitude: 2000 },
      measurements: {
        date: '2026-10-26T18:00:00.000Z',
        wind_heading: 180,
        wind_speed_avg: 12.0,
        wind_speed_max: 16.0,
        wind_speed_min: 8.0,
        pressure: null,
      },
    },
  ],
});

const holfuyFixture = JSON.stringify({
  stationId: 1652,
  stationName: 'Hatis 300 Launch',
  dateTime: '2026-10-26 18:02:00',
  wind: {
    speed: 6.4,
    gust: 9.1,
    min: 4.2,
    unit: 'm/s',
    direction: 195,
  },
  temperature: 16.2,
  humidity: 48,
  pressure: 1016.5,
  battery: 12.8,
});

const awcMetarFixture = JSON.stringify([
  {
    icaoId: 'UDYZ',
    name: 'Yerevan Zvartnots International',
    lat: 40.147,
    lon: 44.396,
    elev: 865,
    obsTime: 1793037600,
    wdir: 240,
    wspd: 10,
    wgst: 16,
    temp: 19.0,
    dewp: 7.0,
    slp: 1015.4,
  },
]);

test('OpenWindMap, Holfuy, and AWC parsers normalize upstream payloads to SI units and @azohra/meteo.station Reading contracts', () => {
  const owm = parseOpenWindMapArchive(openWindMapFixture);
  assert.equal(owm.length, 2);
  assert.equal(owm[0].station.uid, 'openwindmap:618');
  assert.equal(owm[0].station.country, 'MX');
  assert.equal(owm[0].reading.windAvgMps, 5);
  assert.equal(owm[0].reading.windGustMps, 7);
  assert.equal(owm[0].reading.windLullMps, 3);
  assert.equal(owm[0].reading.windDirectionDeg, 225);
  assert.equal(owm[0].reading.conditions?.seaLevelPressureHpa, 1014.2);

  const holfuy = parseHolfuyObservation(holfuyFixture, '1652');
  assert.equal(holfuy.reading.windAvgMps, 6.4);
  assert.equal(holfuy.reading.windGustMps, 9.1);
  assert.equal(holfuy.reading.windDirectionDeg, 195);
  assert.equal(holfuy.reading.temperatureC, 16.2);
  assert.equal(holfuy.telemetry?.batteryVoltage, 12.8);

  const awc = parseAwcMetarList(awcMetarFixture);
  assert.equal(awc.length, 1);
  assert.equal(awc[0].station.uid, 'awc:UDYZ');
  assert.equal(awc[0].station.country, 'AM');
  assert.ok(Math.abs(awc[0].reading.windAvgMps - 5.1444) < 0.01);
  assert.equal(awc[0].reading.conditions?.dewPointC, 7.0);
  assert.ok((awc[0].reading.conditions?.relativeHumidityPercent ?? 0) > 40);
});

test('discoverStations aggregates US, CA, MX, and AM stations and filters out out-of-scope regions', async () => {
  const environment = {
    now: () => new Date('2026-10-26T18:05:00Z'),
    cache: memoryCache(),
    logger: () => {},
    fetch: async input => {
      const url = String(input);
      if (url.includes('pioupiou.fr')) {
        return new Response(openWindMapFixture, { status: 200 });
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  };

  const catalogue = await discoverStations({
    regions: ['US', 'CA', 'MX', 'AM'],
    seeds: INITIAL_SEED_STATIONS,
    includeRemoteDiscovery: true,
    environment,
  });

  const countries = new Set(catalogue.stations.map(s => s.country));
  assert.deepEqual([...countries].sort(), ['AM', 'CA', 'MX', 'US']);
  assert.equal(
    catalogue.stations.some(s => s.uid === 'openwindmap:999'),
    false,
    'Chamonix (FR) must be filtered out of US/CA/MX/AM scope',
  );
  assert.equal(
    catalogue.stations.some(s => s.uid === 'openwindmap:618'),
    true,
    'Valle de Bravo (MX) must be retained',
  );
});

test('defineStationAdapter wrappers load OpenWindMap, Holfuy, and AWC stations and degrade cleanly on error', async () => {
  const environment = {
    now: () => new Date('2026-10-26T18:05:00Z'),
    cache: memoryCache(),
    logger: () => {},
    fetch: async input => {
      const url = String(input);
      if (url.includes('pioupiou.fr/v1/live-with-meta/618')) {
        return new Response(JSON.stringify({ data: JSON.parse(openWindMapFixture).data[0] }), {
          status: 200,
        });
      }
      if (url.includes('api.holfuy.com')) {
        return new Response(holfuyFixture, { status: 200 });
      }
      if (url.includes('aviationweather.gov')) {
        return new Response(awcMetarFixture, { status: 200 });
      }
      return new Response('upstream error', { status: 502 });
    },
  };

  const owmStation = INITIAL_SEED_STATIONS.find(s => s.uid === 'openwindmap:618');
  const holfuyStation = INITIAL_SEED_STATIONS.find(s => s.uid === 'holfuy:1652');
  const awcStation = INITIAL_SEED_STATIONS.find(s => s.uid === 'awc:UDYZ');
  assert.ok(owmStation && holfuyStation && awcStation);

  const loadedOwm = await loadOpenWindMapStation({ station: owmStation }, { environment });
  assert.equal(loadedOwm.status, 'ok');
  assert.equal(loadedOwm.reading.windAvgMps, 5);

  const loadedHolfuy = await loadHolfuyStation({ station: holfuyStation }, { environment });
  assert.equal(loadedHolfuy.status, 'ok');
  assert.equal(loadedHolfuy.reading.windAvgMps, 6.4);

  const loadedAwc = await loadAwcStation({ station: awcStation }, { environment });
  assert.equal(loadedAwc.status, 'ok');
  assert.equal(loadedAwc.reading.temperatureC, 19.0);
});

test('createStationsApiHandler serves spatial /catalogue slices and live /feed in both Azohra JSON and GeoJSON formats', async () => {
  const environment = {
    now: () => new Date('2026-10-26T18:05:00Z'),
    cache: memoryCache(),
    logger: () => {},
    fetch: async input => {
      const url = String(input);
      if (url.includes('api.holfuy.com')) {
        return new Response(holfuyFixture, { status: 200 });
      }
      if (url.includes('aviationweather.gov')) {
        return new Response(awcMetarFixture, { status: 200 });
      }
      return new Response('not mocked', { status: 502 });
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

  // 1. Spatial query for Armenia stations
  const catRes = await handler(
    new Request('https://stations.example/api/stations/catalogue?country=AM'),
  );
  assert.equal(catRes.status, 200);
  const catJson = await catRes.json();
  assert.ok(catJson.stations.length >= 4);
  assert.ok(catJson.stations.every(s => s.country === 'AM'));

  // 2. Live Azohra StationFeed for selected Armenia stations
  const feedRes = await handler(
    new Request('https://stations.example/api/stations/feed?ids=holfuy:1652,awc:UDYZ'),
  );
  assert.equal(feedRes.status, 200);
  const feedJson = await feedRes.json();
  assert.equal(feedJson.stations.length, 2);
  assert.equal(feedJson.stations[0].status, 'ok');
  assert.equal(feedJson.stations[1].status, 'ok');

  // 3. Live GeoJSON feed for custom maps / Windy plugin
  const geoRes = await handler(
    new Request(
      'https://stations.example/api/stations/feed?ids=holfuy:1652,awc:UDYZ&format=geojson',
    ),
  );
  assert.equal(geoRes.status, 200);
  const geoJson = await geoRes.json();
  assert.equal(geoJson.type, 'FeatureCollection');
  assert.equal(geoJson.features.length, 2);
  assert.equal(geoJson.features[0].properties.status, 'ok');
  assert.equal(geoJson.features[0].properties.country, 'AM');
});
