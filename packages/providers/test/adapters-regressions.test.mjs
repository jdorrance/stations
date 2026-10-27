import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INITIAL_SEED_STATIONS,
  discoverStations,
  filterCatalogueStations,
  loadAwcStation,
  loadHolfuyStation,
  loadStationCurrent,
  memoryCache,
  parseAwcMetarEntry,
  parseAwcMetarList,
  parseOpenWindMapArchive,
  toStationConfig,
} from '../dist/index.js';

const seattle = INITIAL_SEED_STATIONS.find(station => station.uid === 'awc:KSEA');
const yerevan = INITIAL_SEED_STATIONS.find(station => station.uid === 'awc:UDYZ');
const holfuy = INITIAL_SEED_STATIONS.find(station => station.uid === 'holfuy:1652');
const tempest = INITIAL_SEED_STATIONS.find(station => station.vendor === 'tempest');
assert.ok(seattle && yerevan && holfuy && tempest);

// Synthetic payloads exercise failure handling; they do not verify real station identities.
const metar = {
  icaoId: 'KSEA',
  lat: seattle.latitude,
  lon: seattle.longitude,
  obsTime: 1793037600,
  wspd: 10,
};
const pioupiou = {
  id: 999,
  meta: { name: 'Synthetic Armenian test station' },
  location: { latitude: 40.1, longitude: 44.4 },
  measurements: {
    date: '2026-10-26T18:00:00Z',
    wind_speed_avg: 18,
    wind_speed_max: 25.2,
    wind_speed_min: 10.8,
    pressure: null,
  },
};

function environmentFor(payload, logs = []) {
  return {
    now: () => new Date('2026-10-26T18:05:00Z'),
    cache: memoryCache(),
    logger: event => logs.push(event),
    fetch: async () => new Response(JSON.stringify(payload)),
  };
}

test('AWC missing and malformed wind remains unavailable while explicit zero means calm', async () => {
  for (const wspd of [undefined, null, 'unknown', Number.NaN]) {
    assert.equal(parseAwcMetarEntry({ ...metar, wspd }), null);
    const loaded = await loadAwcStation(
      { station: seattle },
      { environment: environmentFor([{ ...metar, wspd }]) },
    );
    assert.equal(loaded.status, 'unavailable');
    assert.equal(loaded.reading, null);
  }
  assert.equal(parseAwcMetarEntry({ ...metar, wspd: 0 }).reading.windAvgMps, 0);
});

test('batch parsers retain valid observations and report each malformed row once', () => {
  const awcFailures = [];
  const awc = parseAwcMetarList(
    JSON.stringify([metar, { ...metar, icaoId: 'BAD1', wspd: -1 }, {}, metar]),
    (error, index) => awcFailures.push({ error, index }),
  );
  assert.equal(awc.length, 2);
  assert.deepEqual(awcFailures.map(failure => failure.index), [1, 2]);
  assert.ok(awcFailures.every(failure => failure.error instanceof Error));

  const owmFailures = [];
  const owm = parseOpenWindMapArchive(
    JSON.stringify({ data: [
      pioupiou,
      { ...pioupiou, id: 998, measurements: { ...pioupiou.measurements, wind_speed_max: -1 } },
      {},
    ] }),
    (error, index) => owmFailures.push({ error, index }),
  );
  assert.equal(owm.length, 1);
  assert.deepEqual(owmFailures.map(failure => failure.index), [1, 2]);
  assert.throws(() => parseAwcMetarList('{}'), /JSON array/);
  assert.throws(() => parseOpenWindMapArchive('{}'), /data array/);
});

test('remote discovery logs malformed rows without discarding healthy stations', async () => {
  const logs = [];
  const catalogue = await discoverStations({
    vendors: ['openwindmap'],
    regions: ['AM'],
    seeds: [],
    includeRemoteDiscovery: true,
    environment: environmentFor({ data: [
      pioupiou,
      { ...pioupiou, id: 998, measurements: { ...pioupiou.measurements, wind_speed_avg: 10000 } },
    ] }, logs),
  });
  assert.deepEqual(catalogue.stations.map(station => station.uid), ['openwindmap:999']);
  assert.equal(catalogue.stations[0].country, null);
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /Skipped invalid OpenWindMap discovery entry/);
});

test('upstream failure fallback applies the same bounds and unknown-country coverage', async () => {
  const unknownCountrySeed = { ...yerevan, uid: 'awc:TEST', nativeId: 'TEST', country: null };
  const seeds = [seattle, yerevan, unknownCountrySeed];
  const options = { vendors: ['awc'], regions: ['US', 'AM'], bounds: [43, 38, 47, 42], seeds };
  const offline = await discoverStations({ ...options, includeRemoteDiscovery: false });
  const failed = await discoverStations({
    ...options,
    includeRemoteDiscovery: true,
    environment: {
      cache: memoryCache(),
      logger: () => {},
      fetch: async () => new Response('', { status: 502 }),
    },
  });
  assert.deepEqual(failed.stations, offline.stations);
  assert.deepEqual(failed.stations.map(station => station.uid), ['awc:TEST', 'awc:UDYZ']);
});

test('remote discovery preserves seed country and timezone without inventing either', async () => {
  const parsed = parseAwcMetarEntry(metar);
  assert.equal(parsed.station.timeZone, null);
  assert.equal(parsed.station.country, null);
  const owm = parseOpenWindMapArchive(JSON.stringify({ data: [pioupiou] }))[0];
  assert.equal(owm.station.timeZone, null);
  assert.equal(owm.station.country, null);

  const catalogue = await discoverStations({
    vendors: ['awc'],
    regions: ['US'],
    bounds: [-123, 47, -122, 48],
    seeds: [seattle],
    includeRemoteDiscovery: true,
    environment: environmentFor([metar]),
  });
  assert.equal(catalogue.stations[0].timeZone, 'America/Los_Angeles');
  assert.equal(catalogue.stations[0].country, 'US');
  assert.deepEqual(filterCatalogueStations([yerevan], { regions: ['US'] }), []);
});

test('toStationConfig uses shortName as the feed label without mutating the catalogue station', () => {
  const catalogueStation = {
    ...holfuy,
    name: 'Hatis 300 Launch',
    shortName: 'Hatis',
  };
  const config = toStationConfig(catalogueStation);
  assert.equal(config.name, 'Hatis');
  assert.equal(catalogueStation.name, 'Hatis 300 Launch');
  assert.equal(catalogueStation.shortName, 'Hatis');
});

test('catalogue secrets never become upstream credentials', async () => {
  const legacyTempest = { ...tempest, locator: { ...tempest.locator, token: 'catalogue-secret' } };
  const unconfiguredTempest = toStationConfig(legacyTempest);
  assert.equal(unconfiguredTempest.vendor, 'custom');
  assert.equal((await unconfiguredTempest.load()).reason, 'not_configured');
  const configuredTempest = toStationConfig(legacyTempest, {
    tempestToken: 'shared-server-secret',
    tempestTokens: { [tempest.nativeId]: 'station-server-secret' },
  });
  let tempestRequest;
  await configuredTempest.load({
    environment: {
      ...environmentFor({}),
      fetch: async input => {
        tempestRequest = new URL(input);
        return new Response('', { status: 403 });
      },
    },
    mode: 'current',
    historyHours: 1,
  });
  assert.equal(tempestRequest.searchParams.get('token'), 'station-server-secret');

  const legacyHolfuy = {
    ...holfuy,
    locator: { ...holfuy.locator, password: 'catalogue-secret', requiresPassword: false },
  };
  const unconfiguredHolfuy = toStationConfig(legacyHolfuy);
  let request;
  const publicResult = await unconfiguredHolfuy.load({
    environment: {
      ...environmentFor({}),
      fetch: async input => {
        request = new URL(input);
        return new Response(JSON.stringify({ stationId: Number(holfuy.nativeId), dateTime: '2026-10-26 18:00:00', wind: { speed: 2 } }));
      },
    },
    mode: 'current',
    historyHours: 1,
  });
  assert.equal(publicResult.status, 'ok');
  assert.equal(request.searchParams.has('pw'), false);
  const configuredHolfuy = toStationConfig(legacyHolfuy, {
    holfuyPasswords: { [holfuy.nativeId]: 'station-server-secret' },
  });
  await configuredHolfuy.load({
    environment: {
      ...environmentFor({ stationId: Number(holfuy.nativeId), dateTime: '2026-10-26 18:00:00', wind: { speed: 2 } }),
      fetch: async input => {
        request = new URL(input);
        return new Response(JSON.stringify({ stationId: Number(holfuy.nativeId), dateTime: '2026-10-26 18:00:00', wind: { speed: 2 } }));
      },
    },
    mode: 'current',
    historyHours: 1,
  });
  assert.equal(request.searchParams.get('pw'), 'station-server-secret');
});

test('Holfuy requests battery telemetry only for a battery-capable station', async () => {
  for (const battery of [true, false]) {
    let request;
    await loadHolfuyStation(
      { station: { ...holfuy, capabilities: { ...holfuy.capabilities, battery } }, password: 'test-only' },
      { environment: {
        ...environmentFor({}),
        fetch: async input => {
          request = new URL(input);
          return new Response(JSON.stringify({ stationId: Number(holfuy.nativeId), dateTime: '2026-10-26 18:00:00', wind: { speed: 2 } }));
        },
      } },
    );
    assert.equal(request.searchParams.has('batt'), battery);
  }
});

for (const vendor of ['tempest', 'ecowitt']) {
  test(`${vendor} wrapper isolates cached observations by every credential`, async () => {
    const station = INITIAL_SEED_STATIONS.find(station => station.vendor === vendor);
    assert.ok(station);
    const variants = vendor === 'tempest'
      ? [
          { tempestToken: 'tempest-secret-one' },
          { tempestToken: 'tempest-secret-two' },
          { tempestToken: 'tempest-invalid-secret' },
        ]
      : [
          { ecowittApplicationKey: 'ecowitt-application-one', ecowittApiKey: 'ecowitt-api-one' },
          { ecowittApplicationKey: 'ecowitt-application-one', ecowittApiKey: 'ecowitt-api-two' },
          { ecowittApplicationKey: 'ecowitt-application-two', ecowittApiKey: 'ecowitt-api-one' },
          { ecowittApplicationKey: 'ecowitt-invalid-application', ecowittApiKey: 'ecowitt-invalid-api' },
        ];
    const secrets = variants.flatMap(credentials => Object.values(credentials));
    const underlying = memoryCache();
    const cacheKeys = [];
    let requests = 0;
    const environment = {
      now: () => new Date('2026-10-26T18:05:00Z'),
      logger: () => {},
      cache: {
        get(key) { cacheKeys.push(key); return underlying.get(key); },
        put(key, value, ttlSeconds) { cacheKeys.push(key); return underlying.put(key, value, ttlSeconds); },
      },
      fetch: async input => {
        requests += 1;
        const url = new URL(input);
        const variant = variants.findIndex(credentials => vendor === 'tempest'
          ? url.searchParams.get('token') === credentials.tempestToken
          : url.searchParams.get('application_key') === credentials.ecowittApplicationKey &&
            url.searchParams.get('api_key') === credentials.ecowittApiKey);
        if (variant < 0 || variant === variants.length - 1) return new Response('', { status: 403 });
        const speed = variant + 2;
        const payload = vendor === 'tempest'
          ? { station_id: Number(station.nativeId), obs: [{ timestamp: 1793037600, wind_avg: speed, wind_direction: 180, wind_gust: speed + 1, air_temperature: 20 }] }
          : { code: 0, data: { wind: { wind_speed: { value: speed, time: 1793037600 }, wind_direction: { value: 180 } } } };
        return new Response(JSON.stringify(payload));
      },
    };
    const load = credentials => loadStationCurrent({
      stations: [toStationConfig(station, credentials)], stationId: station.uid, environment,
    });
    const first = await Promise.all([load(variants[0]), load(variants[0])]);
    assert.ok(first.every(result => result.station.status === 'ok' && result.station.reading.windAvgMps === 2));
    assert.equal(requests, 1);
    for (let index = 1; index < variants.length - 1; index++) {
      const next = await load(variants[index]);
      assert.equal(next.station.status, 'ok');
      assert.equal(next.station.reading.windAvgMps, index + 2);
    }
    const rejected = await load(variants.at(-1));
    assert.equal(rejected.station.status, 'unavailable');
    assert.equal(requests, variants.length);
    assert.equal((await load(variants[0])).station.reading.windAvgMps, 2);
    assert.equal(requests, variants.length);
    assert.equal(new Set(cacheKeys).size, variants.length);
    assert.ok(cacheKeys.every(key => /^authenticated-[a-f0-9]{64}\//.test(key)));
    assert.ok(cacheKeys.every(key => secrets.every(secret => !key.includes(secret))));
  });
}

test('default seeds contain no executable example.com endpoints or public Holfuy bypass', () => {
  for (const station of INITIAL_SEED_STATIONS) {
    const urls = [station.pageUrl, station.locator.baseUrl].filter(Boolean);
    assert.ok(urls.every(url => !new URL(url).hostname.endsWith('example.com')));
    if (station.vendor === 'holfuy') assert.notEqual(station.locator.requiresPassword, false);
  }
});
