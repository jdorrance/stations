import assert from 'node:assert/strict';
import test from 'node:test';
import {
  coverageCountryHint,
  defaultTimeZoneForPoint,
  defaultTimeZoneForRegion,
  hilltopSpeedToMps,
  parseEcanObservation,
  parseEcanWindFeatures,
  parseHilltopGetData,
  parseOgimetSynopBatch,
  parseOgimetSynopLine,
  parseZephyrObservation,
  parseZephyrStations,
  unwrapAggregatorStation,
} from '../dist/index.js';

const NOW = Date.parse('2026-10-27T13:00:00.000Z');

test('NZ coverage hints cover mainland, Chathams and Kermadec and exclude Norfolk Island', () => {
  assert.equal(coverageCountryHint({ latitude: -41.29, longitude: 174.78 }), 'NZ');
  assert.equal(coverageCountryHint({ latitude: -43.95, longitude: -176.55 }), 'NZ');
  assert.equal(coverageCountryHint({ latitude: -29.24, longitude: -177.93 }), 'NZ');
  assert.equal(coverageCountryHint({ latitude: -29.04, longitude: 167.95 }), null);
  assert.equal(coverageCountryHint({ latitude: 40.27, longitude: 44.71 }), 'AM');
  assert.equal(coverageCountryHint({ latitude: 40.7, longitude: 45.6 }), null);
  assert.equal(defaultTimeZoneForRegion('NZ'), 'Pacific/Auckland');
  assert.equal(
    defaultTimeZoneForPoint({ latitude: -41.29, longitude: 174.78 }),
    'Pacific/Auckland',
  );
  assert.equal(
    defaultTimeZoneForPoint({ latitude: -43.95, longitude: -176.55 }),
    'Pacific/Chatham',
  );
});

test('NZ WMO SYNOP Ogimet parser accepts block-93 AAXX lines', () => {
  const line =
    '93439,2026,10,27,12,00,AAXX 27121 93439 329// 21408 10112 20085 40182 52003 333 91112=';
  const parsed = parseOgimetSynopLine(line);
  assert.equal(parsed.wmoId, '93439');
  assert.equal(parsed.reading.windAvgMps, 8);
  assert.equal(parsed.reading.windDirectionDeg, 140);
  assert.equal(parsed.reading.windGustMps, 12);
  const batch = parseOgimetSynopBatch(`${line}\nmalformed\n`, '93439');
  assert.equal(batch.reading.windAvgMps, 8);

  const knots =
    '93439,2026,10,27,12,00,AAXX 27124 93439 329// 21499 00105 10112 20085 40182 333 91215=';
  const extended = parseOgimetSynopLine(knots);
  assert.ok(Math.abs(extended.reading.windAvgMps - 105 * 0.5144444444444445) < 1e-9);
  assert.ok(Math.abs(extended.reading.windGustMps - 15 * 0.5144444444444445) < 1e-9);
  assert.equal(
    parseOgimetSynopLine(
      '93439,2026,10,27,12,00,AAXX 27124 93439 329// 21499 10112 20085 40182=',
    ),
    null,
  );
  assert.equal(
    parseOgimetSynopLine(
      '93439,2026,10,27,12,00,AAXX 2712/ 93439 329// 21408 10112 20085 40182=',
    ),
    null,
  );
});

test('Hilltop GetData parser converts units and rejects unknown or missing units', () => {
  const xml = `<?xml version="1.0"?>
<HilltopServer>
  <Measurement>
    <DataSource Name="Wind">
      <Units>km/h</Units>
    </DataSource>
    <Data>
      <E><T>2026-10-27T12:00:00</T><I1>18.5</I1></E>
      <E><T>2026-10-27T12:10:00</T><I1>22.2</I1></E>
    </Data>
  </Measurement>
</HilltopServer>`;
  const parsed = parseHilltopGetData(xml, { timeZone: 'Pacific/Auckland' });
  assert.ok(parsed);
  assert.equal(parsed.value, 22.2);
  assert.equal(parsed.units, 'km/h');
  assert.ok(Math.abs(hilltopSpeedToMps(parsed.value, parsed.units) - 22.2 / 3.6) < 1e-9);
  assert.equal(hilltopSpeedToMps(10, 'furlongs/fortnight'), null);
  assert.equal(hilltopSpeedToMps(10, ''), null);
  assert.equal(hilltopSpeedToMps(10, null), null);
  assert.equal(parseHilltopGetData('<HilltopServer><Error>No data</Error></HilltopServer>'), null);
});

test('ECan ArcGIS parser keeps recent gauges and normalizes km/h', () => {
  const payload = {
    features: [
      {
        attributes: {
          station: 'Woolston',
          date_time: NOW - 60_000,
          windspeed: 0.7,
          windspeed_kph: 18,
          winddirection: 112,
          windmax: 25,
        },
        geometry: { x: 172.6818, y: -43.5568 },
      },
      {
        attributes: {
          station: 'Stale',
          date_time: NOW - 40 * 86_400_000,
          windspeed_kph: 10,
          winddirection: 90,
          windmax: 12,
        },
        geometry: { x: 172.7, y: -43.5 },
      },
    ],
  };
  const stations = parseEcanWindFeatures(JSON.stringify(payload), NOW);
  assert.equal(stations.length, 1);
  assert.equal(stations[0].uid, 'ecan:Woolston');
  assert.equal(stations[0].country, 'NZ');
  assert.equal(stations[0].region, 'Canterbury');
  const reading = parseEcanObservation(JSON.stringify(payload), 'Woolston');
  assert.ok(Math.abs(reading.windAvgMps - 18 / 3.6) < 1e-9);
  assert.ok(Math.abs(reading.windGustMps - 25 / 3.6) < 1e-9);
  assert.equal(reading.windDirectionDeg, 112);
});

test('Zephyr parser keeps live-only types, skips direct-provider types, and unwraps residuals', () => {
  const payload = [
    {
      _id: 'z1',
      name: 'Harvest FENZ',
      type: 'harvest',
      externalId: 'abc',
      externalLink: 'https://example.test/h',
      elevation: 120,
      isOffline: false,
      lastUpdate: new Date(NOW - 120_000).toISOString(),
      location: { type: 'Point', coordinates: [174.78, -41.29] },
      currentAverage: 18.5,
      currentGust: 27,
      currentBearing: 250,
      currentTemperature: 14.2,
    },
    {
      _id: 'z2',
      name: 'WU Dup',
      type: 'wu',
      externalId: 'INORTH123',
      isOffline: false,
      lastUpdate: new Date(NOW - 60_000).toISOString(),
      location: { type: 'Point', coordinates: [174.7, -41.2] },
    },
    {
      _id: 'z3',
      name: 'Offline',
      type: 'metservice',
      isOffline: true,
      lastUpdate: new Date(NOW - 60_000).toISOString(),
      location: { type: 'Point', coordinates: [172.6, -43.5] },
    },
    {
      _id: 'z4',
      name: 'Chatham Windy',
      type: 'windy',
      externalId: 'wd-1',
      isOffline: false,
      lastUpdate: new Date(NOW - 90_000).toISOString(),
      location: { type: 'Point', coordinates: [-176.55, -43.95] },
    },
  ];
  const stations = parseZephyrStations(JSON.stringify(payload), NOW);
  assert.equal(stations.length, 2);
  assert.equal(stations[0].uid, 'zephyr:z1');
  assert.equal(stations[0].country, 'NZ');
  assert.equal(stations[0].category, 'pws');
  assert.equal(stations[1].uid, 'zephyr:z4');
  assert.equal(stations[1].timeZone, 'Pacific/Chatham');

  const reading = parseZephyrObservation(JSON.stringify({ ...payload[0], isError: false }));
  assert.ok(Math.abs(reading.windAvgMps - 18.5 / 3.6) < 1e-9);
  assert.equal(reading.windDirectionDeg, 250);
  assert.equal(reading.temperatureC, 14.2);
  assert.equal(reading.conditions, null);

  assert.throws(() => parseZephyrObservation(JSON.stringify({ ...payload[0], isError: true })));
  assert.throws(() =>
    parseZephyrObservation(JSON.stringify({ ...payload[0], lastUpdate: undefined })),
  );

  const residual = {
    ...stations[0],
    locator: { zephyrId: 'z9', zephyrType: 'wu', externalId: 'INORTH999' },
  };
  const unwrapped = unwrapAggregatorStation(residual);
  assert.equal(unwrapped.vendor, 'wunderground');
  assert.equal(unwrapped.uid, 'wunderground:INORTH999');
  assert.ok(unwrapped.aliases.includes('zephyr:z1'));
});
