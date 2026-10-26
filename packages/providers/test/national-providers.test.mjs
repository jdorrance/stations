import assert from 'node:assert/strict';
import test from 'node:test';
import {
  awcProvider, conaguaProvider, ecccProvider, nwsProvider, loadEcccStation, loadIemStation,
  loadNdbcStation, loadRawsStation, loadSnotelStation, loadWuPwsStation, loadSynopticStation, loadAmbientStation, memoryCache,
  parseAmbientDeviceObservation, parseAprsWxPacket, parseAvalancheCanadaMeasurements,
  parseAwcMetarEntry, parseConaguaEmaObservation, parseEcccSwobRealtime,
  parseEcccSwobStations, parseIemCurrentRow, parseIemNetworkGeoJson,
  parseNdbcLatestObs, parseNdbcRealtime2, parseNwsLatestObservation,
  parseNwsStationsCollection, parseRawsFeature, parseSnotelDataResponse,
  parseSnotelStationsList, parseSynopticLatest, parseWindyPwsResponse,
  parseWuPwsCurrent, synopticProvider, wundergroundProvider, ambientProvider,
} from '../dist/index.js';

const time = '2026-10-26T18:00:00Z';
const now = Date.parse('2026-10-26T18:05:00Z');
const station = (vendor, nativeId = 'TEST', locator = {}) => ({
  uid: `${vendor}:${nativeId}`, vendor, nativeId, name: 'Synthetic fixture',
  latitude: 47, longitude: -122, elevationM: null, country: null, region: null,
  timeZone: null, pageUrl: null, capabilities: { gustLull: true, temperature: true, conditions: true, history: false },
  samplingWindowSeconds: 600, recommendedPollSeconds: 120, locator,
});
const environment = (payload, requests = [], logs = []) => ({
  now: () => new Date(now), cache: memoryCache(), logger: event => logs.push(event),
  fetch: async input => {
    requests.push(String(input));
    const body = typeof payload === 'function' ? payload(new URL(input)) : payload;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body));
  },
});
const collection = properties => ({ features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-122, 47] }, properties }] });

test('NWS requires measured wind and interprets explicit measurement units', () => {
  const props = { timestamp: time, windSpeed: { value: 36, unitCode: 'wmoUnit:km_h-1' },
    temperature: { value: 50, unitCode: 'wmoUnit:degF' },
    seaLevelPressure: { value: 101325, unitCode: 'wmoUnit:Pa' } };
  const parsed = parseNwsLatestObservation(JSON.stringify({ properties: props }));
  assert.equal(parsed.windAvgMps, 10);
  assert.equal(parsed.temperatureC, 10);
  assert.equal(parsed.conditions.seaLevelPressureHpa, 1013.25);
  for (const windSpeed of [null, { value: null }, { value: -1, unitCode: 'wmoUnit:km_h-1' }, { value: 10, unitCode: 'unknown' }]) {
    assert.throws(() => parseNwsLatestObservation(JSON.stringify({ properties: { ...props, windSpeed } })), /wind/);
  }
  assert.equal(parseNwsLatestObservation(JSON.stringify({ properties: { ...props, windSpeed: { value: 0, unitCode: 'wmoUnit:m_s-1' } } })).windAvgMps, 0);
  const metadata = parseNwsStationsCollection(JSON.stringify(collection({ stationIdentifier: 'TEST' })))[0];
  assert.equal(metadata.timeZone, null);
});

test('ECCC parses documented minute fields, units and exact station identity', async () => {
  // Shape follows official SWOB GeoJSON: identity/date use -value; measurements use -uom.
  const properties = { 'msc_id-value': '4016699', 'tc_id-value': 'WDJ', 'date_tm-value': time,
    avg_wnd_spd_10m_pst1mt: 18, 'avg_wnd_spd_10m_pst1mt-uom': 'km/h',
    avg_wnd_dir_10m_pst1mt: 325, mslp: 101.3, 'mslp-uom': 'kPa' };
  const payload = collection(properties);
  payload.features.push({ properties: { ...properties, 'msc_id-value': 'OTHER', 'tc_id-value': 'XYZ', 'date_tm-value': '2026-10-26T18:04:00Z', avg_wnd_spd_10m_pst1mt: 90 } });
  const parsed = parseEcccSwobRealtime(JSON.stringify(payload), '4016699');
  assert.equal(parsed.windAvgMps, 5);
  assert.equal(parsed.windDirectionDeg, 325);
  assert.equal(parsed.conditions.seaLevelPressureHpa, 1013);
  assert.throws(() => parseEcccSwobRealtime(JSON.stringify(collection({ ...properties, avg_wnd_spd_10m_pst1mt: null }))), /valid/);
  assert.throws(() => parseEcccSwobRealtime(JSON.stringify(payload), 'MISSING'), /valid/);
  const requests = [];
  const loaded = await loadEcccStation({ station: station('eccc', 'CWDJ', { mscId: '4016699' }) }, { environment: environment(payload, requests) });
  assert.equal(loaded.status, 'ok');
  assert.equal(new URL(requests[0]).searchParams.get('msc_id-value'), '4016699');
  assert.equal(new URL(requests[0]).searchParams.has('bbox'), false);
  const metadata = parseEcccSwobStations(JSON.stringify(collection({ iata_id: 'CWDJ', msc_id: '4016699', province_territory: 'Saskatchewan' })))[0];
  assert.equal(metadata.timeZone, null);
  assert.equal(metadata.region, 'Saskatchewan');
});

test('SNOTEL converts the declared data timezone and does not combine different observation times', async () => {
  const triplet = '999:WA:SNTL';
  const payload = [{ stationTriplet: triplet, data: [
    { stationElement: { elementCode: 'WSPDV', storedUnitCode: 'mph' }, values: [{ date: '2026-10-26 10:00', value: 10 }, { date: 'invalid', value: 30 }] },
    { stationElement: { elementCode: 'TOBS', storedUnitCode: 'degF' }, values: [{ date: '2026-10-26 09:00', value: 50 }] },
  ] }];
  const parsed = parseSnotelDataResponse(JSON.stringify(payload), -8, triplet);
  assert.equal(parsed.observedAt, '2026-10-26T18:00:00.000Z');
  assert.ok(Math.abs(parsed.windAvgMps - 4.4704) < 1e-8);
  assert.equal(parsed.temperatureC, null);
  assert.throws(() => parseSnotelDataResponse(JSON.stringify(payload)), /timestamp/);
  const requests = [];
  const loaded = await loadSnotelStation({ station: station('snotel', triplet, { dataTimeZone: -8 }) }, { environment: environment(payload, requests) });
  assert.equal(loaded.status, 'ok');
  assert.equal(new URL(requests[0]).searchParams.get('beginDate'), '-24');
  const metadata = parseSnotelStationsList(JSON.stringify([{ stationTriplet: triplet, latitude: 47, longitude: -122, dataTimeZone: -8, elevation: 1000 }]))[0];
  assert.equal(metadata.locator.dataTimeZone, -8);
  assert.equal(metadata.timeZone, null);
});

test('IEM uses UTC timestamps, network-scoped identities, and never substitutes another station', async () => {
  const row = { station: 'TEST', utc_valid: '2026-10-26 18:00:00', sknt: 10, alti: 29.92 };
  assert.equal(parseIemCurrentRow(row).reading.observedAt, '2026-10-26T18:00:00.000Z');
  assert.equal(parseIemCurrentRow({ ...row, utc_valid: undefined, local_valid: '2026-10-26 18:00:00' }), null);
  assert.equal(parseIemCurrentRow(row).reading.conditions.seaLevelPressureHpa, null);
  const feature = { ...collection({ sname: 'Example', country: 'US' }).features[0], id: 'TEST' };
  const one = parseIemNetworkGeoJson(JSON.stringify({ features: [feature] }), 'WA_ASOS')[0];
  const two = parseIemNetworkGeoJson(JSON.stringify({ features: [feature] }), 'WA_DCP')[0];
  assert.notEqual(one.uid, two.uid);
  assert.equal(one.timeZone, null);
  const requests = [];
  const loaded = await loadIemStation({ station: one }, { environment: environment({ data: [{ ...row, station: 'OTHER' }] }, requests) });
  assert.equal(loaded.status, 'unavailable');
  assert.equal(new URL(requests[0]).searchParams.get('station'), 'TEST');
});

test('RAWS rejects neighboring station substitution and malformed timestamps', async () => {
  const raw = { attributes: { NWSID: 'OTHER', StationName: 'Other', ObservationTime: time, WindSpeed: 10 }, geometry: { x: -122, y: 47 } };
  assert.equal(parseRawsFeature({ ...raw, attributes: { ...raw.attributes, ObservationTime: 'yesterday' } }).reading, null);
  const loaded = await loadRawsStation({ station: station('raws') }, { environment: environment({ features: [raw] }) });
  assert.equal(loaded.status, 'unavailable');
  const realShape = parseRawsFeature({ attributes: {
    StationID: '18053677', NESSID: '32D3E21C', ObservedDate: 1793037600000,
    WindSpeedMPH: '5 mph', WindDirDegrees: '295 degrees ', WindSpeedPeak: '13 mph',
    AirTempStandPlace: '50 deg. F', RelativeHumidity: '21 % ', RainAccumulation: '0 inches',
    SolarRadiation: '694 w/m2', Latitude: 37.7, Longitude: -119.6,
  } });
  assert.equal(realShape.reading.temperatureC, 10);
  assert.equal(realShape.reading.windDirectionDeg, 295);
  assert.ok(Math.abs(realShape.reading.windAvgMps - 2.2352) < 1e-8);
});

test('NDBC preserves valid numeric values, validates dates, and requests lowercase realtime filenames', async () => {
  const line = 'TEST 10 99.0 2026 10 26 18 00 180 5 7 MM MM MM MM 999 MM 12 14 10 MM MM';
  const parsed = parseNdbcLatestObs(line)[0];
  assert.equal(parsed.station.longitude, 99);
  assert.equal(parsed.reading.conditions.seaLevelPressureHpa, 999);
  assert.deepEqual(parseNdbcLatestObs(line.replace('2026 10 26', '2026 02 30')), []);
  const realtime = '2026 10 26 18 00 180 5 7 MM MM MM MM 999 12 14 10';
  const requests = [];
  const loaded = await loadNdbcStation({ station: station('ndbc', 'ABCD1') }, { environment: environment(realtime, requests), mode: 'full' });
  assert.equal(loaded.status, 'ok');
  assert.ok(requests[0].endsWith('/abcd1.txt'));
  assert.throws(() => parseNdbcRealtime2(realtime.replace('2026 10 26', '2026 13 26')), /no valid/);
});

test('Avalanche history skips malformed points and selects the latest observation by timestamp', () => {
  const parsed = parseAvalancheCanadaMeasurements(JSON.stringify([
    { dateTime: time, wind_speed: 18 },
    { dateTime: '2026-10-26T17:00:00Z', wind_speed: 9 },
    { dateTime: time, wind_speed: 100_000 },
    { dateTime: 'bad', wind_speed: 0 },
  ]));
  assert.equal(parsed.reading.windAvgMps, 5);
  assert.equal(parsed.history.points.length, 2);
});

test('CONAGUA needs an actual observation endpoint and never invents freshness', async () => {
  const config = conaguaProvider.toStationConfig(station('conagua'));
  assert.equal((await config.load()).reason, 'not_configured');
  assert.throws(() => parseConaguaEmaObservation(JSON.stringify({ vel_viento: 18 }), now), /timestamp/);
  assert.equal(parseConaguaEmaObservation(JSON.stringify({ vel_viento: 18, fecha: time })).windAvgMps, 5);
  assert.throws(() => parseConaguaEmaObservation(JSON.stringify([{ id: 'OTHER', vel_viento: 18, fecha: time }]), undefined, 'TEST'), /empty/);
});

test('APRS preserves packet observation time, including UTC month rollover', () => {
  const packet = 'CW0001>APRS,TCPXX*:@261800z4729.97N/12200.54W_315/012g018t058r000p000P000h65b10142';
  assert.equal(parseAprsWxPacket(packet, now, 'CW0001').observedAt, '2026-10-26T18:00:00.000Z');
  assert.equal(parseAprsWxPacket(packet.replace('261800z', '312350z'), Date.parse('2026-11-01T00:05:00Z')).observedAt, '2026-10-31T23:50:00.000Z');
  assert.throws(() => parseAprsWxPacket(packet.replace('@261800z', '!'), now), /timestamp/);
  assert.throws(() => parseAprsWxPacket(packet, now, 'OTHER'), /timestamp/);
});

test('Windy ignores missing final samples, sorts observations, and converts Kelvin', () => {
  const parsed = parseWindyPwsResponse(JSON.stringify({ ts: [1793037600, 1793034000, 1e30, 1793038200], wind: [5, 3, 10, null], temp: [283.15, 278.15] }));
  assert.equal(parsed.reading.windAvgMps, 5);
  assert.equal(parsed.reading.temperatureC, 10);
  assert.equal(parsed.history.points[0].windAvgMps, 3);
});

test('Synoptic requires dated wind and does not mark old sensor values current', () => {
  const payload = { STATION: [{ STID: 'TEST', OBSERVATIONS: {
    wind_speed_value_1: { value: 5, date_time: time },
    wind_gust_value_1: { value: 20, date_time: '2025-01-01T00:00:00Z' },
    sea_level_pressure_value_1: { value: 101325, date_time: time },
  } }] };
  const parsed = parseSynopticLatest(JSON.stringify(payload), 'TEST');
  assert.equal(parsed.windGustMps, null);
  assert.equal(parsed.conditions.seaLevelPressureHpa, 1013.25);
  assert.throws(() => parseSynopticLatest(JSON.stringify(payload), 'OTHER'), /missing/);
  delete payload.STATION[0].OBSERVATIONS.wind_speed_value_1.date_time;
  assert.throws(() => parseSynopticLatest(JSON.stringify(payload)), /missing/);
});

test('credential-backed providers reject blank configuration; WU/Ambient retain source timestamps and units', async () => {
  for (const [provider, vendor, credentials] of [
    [wundergroundProvider, 'wunderground', { wuApiKey: ' ' }],
    [synopticProvider, 'synoptic', { synopticToken: ' ' }],
    [ambientProvider, 'ambient', { ambientApiKey: ' ', ambientApplicationKey: 'x' }],
  ]) assert.equal((await provider.toStationConfig(station(vendor), credentials).load()).reason, 'not_configured');
  const wu = { observations: [{ stationID: 'TEST', obsTimeUtc: time, metric: { windSpeed: 18 } }] };
  assert.equal(parseWuPwsCurrent(JSON.stringify(wu), 'TEST').windAvgMps, 5);
  assert.throws(() => parseWuPwsCurrent(JSON.stringify(wu), 'OTHER'), /no observations/);
  assert.throws(() => parseAmbientDeviceObservation(JSON.stringify({ dateutc: 1e30, windspeedmph: 10 })), /dateutc/);
});

test('AWC default remote discovery uses requested coverage and reports partial failures', async () => {
  const requests = [];
  const parsed = await awcProvider.discover({ regions: ['AM'], includeRemoteDiscovery: true, environment: environment([{ icaoId: 'TEST', lat: 40, lon: 44, obsTime: 1793037600, wspd: 0 }], requests) });
  assert.equal(parsed.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0]).searchParams.get('bbox'), '38.84,43.44,41.3,46.63');
  const logs = [];
  await awcProvider.discover({ regions: ['AM'], includeRemoteDiscovery: true, environment: { ...environment([], [], logs), fetch: async () => new Response('', { status: 503 }) } });
  assert.ok(logs.some(event => event.message.includes('failed')));
  assert.equal(parseAwcMetarEntry({ icaoId: 'TEST', lat: 40, lon: 44, obsTime: 1e30, wspd: 5 }), null);
});

test('authenticated PWS caches do not reuse another credential scope', async () => {
  for (const [load, vendor, configurations, response] of [
    [loadWuPwsStation, 'wunderground', [{ apiKey: 'first' }, { apiKey: 'second' }], { observations: [{ stationID: 'TEST', obsTimeUtc: time, metric: { windSpeed: 18 } }] }],
    [loadSynopticStation, 'synoptic', [{ token: 'first' }, { token: 'second' }], { STATION: [{ STID: 'TEST', OBSERVATIONS: { wind_speed_value_1: { value: 5, date_time: time } } }] }],
    [loadAmbientStation, 'ambient', [{ apiKey: 'same', applicationKey: 'first' }, { apiKey: 'same', applicationKey: 'second' }], [{ dateutc: now - 300000, windspeedmph: 10 }]],
  ]) {
    const requests = [];
    const env = environment(response, requests);
    for (const credentials of configurations) {
      const loaded = await load({ station: station(vendor), ...credentials }, { environment: env });
      assert.equal(loaded.status, 'ok', vendor);
    }
    assert.equal(requests.length, 2, vendor);
  }
});

test('national catalogue discovery follows pagination instead of silently dropping stations', async () => {
  const canadian = await ecccProvider.discover({ regions: ['CA'], includeRemoteDiscovery: true,
    environment: environment(url => {
      const second = url.searchParams.has('offset');
      return { ...collection({ iata_id: second ? 'CWBB' : 'CWAA' }),
        links: second ? [] : [{ rel: 'next', href: '?f=json&offset=1' }] };
    }),
  });
  assert.deepEqual(canadian.map(row => row.nativeId), ['CWAA', 'CWBB']);
  const american = await nwsProvider.discover({ regions: ['US'], includeRemoteDiscovery: true,
    environment: environment(url => {
      if (url.searchParams.get('state') !== 'AK') return { features: [] };
      const second = url.searchParams.has('cursor');
      return { ...collection({ stationIdentifier: second ? 'TWOT' : 'ONET' }),
        pagination: second ? {} : { next: '?state=AK&cursor=next' } };
    }),
  });
  assert.deepEqual(american.map(row => row.nativeId), ['ONET', 'TWOT']);
});

test('AWC subdivides capped responses without dropping the initial partial results', async () => {
  const requests = [];
  const row = { icaoId: 'TEST', lat: 40, lon: 44, obsTime: 1793037600, wspd: 5 };
  const result = await awcProvider.discover({ regions: ['AM'], includeRemoteDiscovery: true,
    environment: environment(() => requests.length === 1 ? Array.from({ length: 400 }, () => row) : [], requests),
  });
  assert.equal(requests.length, 3);
  assert.equal(result.length, 1);
});
