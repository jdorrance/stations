import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INITIAL_SEED_STATIONS,
  holfuyProvider,
  loadHolfuyStation,
  loadWindSpionStation,
  loadWindsMobiStation,
  loadWeatherLinkStation,
  memoryCache,
  parseHolfuyObservation,
  parseHolfuyWidgetJson,
  parseRealtimeTxt,
  parseWeatherLinkBulletin,
  parseWindGuruCurrent,
  parseWindSpionList,
  parseWindsMobiHistoric,
  parseWindsMobiList,
  windnerdConfigFromCatalogue,
  windnerdProvider,
} from '../dist/index.js';

const anchor = 1793037600000;
const holfuy = INITIAL_SEED_STATIONS.find(station => station.uid === 'holfuy:1652');
function station(vendor, nativeId = 'test') {
  return { ...holfuy, vendor, nativeId, uid: `${vendor}:${nativeId}`, locator: {} };
}
function environment(fetch) {
  return { fetch, cache: memoryCache(), now: () => new Date(anchor), logger: () => {} };
}
const wm = {
  _id: 'test', name: 'Synthetic station', loc: { coordinates: [44.4, 40.1] },
  last: { _id: anchor / 1000, 'w-avg': 18, 'w-max': 25.2, 'w-dir': 190 },
};
const ws = { id: 'test', lat: 40.1, lon: 44.4, ts: anchor / 1000, wind: 18, gust: 25.2, dir: 190 };

test('widget and WeatherLink parsers reject undated data and retain old source time', () => {
  const widget = { speed: 18, gust: 25.2 };
  assert.throws(() => parseHolfuyWidgetJson(JSON.stringify(widget), anchor), /timestamp/);
  assert.throws(() => parseWeatherLinkBulletin(JSON.stringify({ wind: 10 }), anchor), /timestamp/);
  assert.throws(() => parseWeatherLinkBulletin(JSON.stringify({ oMaiaData: [{ logicalSensor: [] }] }), anchor), /timestamp/);
  const oldTimestamp = '2020-01-01T00:00:00Z';
  assert.equal(parseHolfuyWidgetJson(JSON.stringify({ ...widget, timestamp: oldTimestamp }), anchor).reading.observedAt,
    '2020-01-01T00:00:00.000Z');
  assert.equal(parseWeatherLinkBulletin(JSON.stringify({ wind: 10, timestamp: oldTimestamp }), anchor).observedAt,
    '2020-01-01T00:00:00.000Z');
  assert.throws(() => parseHolfuyWidgetJson(JSON.stringify({ ...widget, timestamp: '2026-02-30T00:00:00Z' })), /timestamp/);
  assert.throws(() => parseHolfuyWidgetJson(JSON.stringify({ ...widget, timestamp: anchor, su: 'unknown' })), /unit/);
  assert.throws(() => parseHolfuyWidgetJson(JSON.stringify({ ...widget, timestamp: anchor, gust: 10000 })), /wind speed/);
});

test('Holfuy parses UTC timestamps independently of host timezone', () => {
  const observation = parseHolfuyObservation(JSON.stringify({
    stationId: 1652, dateTime: '2026-10-26T18:00:00', wind: { speed: 2, direction: -999 },
  }), '1652');
  assert.equal(observation.reading.observedAt, '2026-10-26T18:00:00.000Z');
  assert.equal(observation.reading.windDirectionDeg, null);
});

test('public Holfuy fallback preserves cached source time and bounds the response', async () => {
  let nowMs = anchor;
  let widgetCalls = 0;
  const env = environment(async (input, init) => {
    const url = String(input);
    if (url.includes('api.holfuy.com')) return new Response('', { status: 403 });
    if (url.includes('/en/weather/')) return new Response('', { headers: { 'set-cookie': 'session=test; Path=/' } });
    widgetCalls += 1;
    assert.equal(init.headers.Cookie, 'session=test');
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ speed: 18, timestamp: '2020-01-01T00:00:00Z' }));
  });
  env.now = () => new Date(nowMs);
  const config = holfuyProvider.toStationConfig(holfuy);
  const context = { environment: env, mode: 'current', historyHours: 1 };
  const first = await config.load(context);
  nowMs += 30_000;
  const second = await config.load(context);
  assert.equal(first.status, 'ok');
  assert.equal(second.reading.observedAt, first.reading.observedAt);
  assert.equal(second.reading.observedAt, '2020-01-01T00:00:00.000Z');
  assert.equal(widgetCalls, 1);

  const oversizedEnv = environment(async input => {
    const url = String(input);
    if (url.includes('api.holfuy.com')) return new Response('', { status: 403 });
    if (url.includes('/en/weather/')) return new Response('');
    return new Response('x'.repeat(128 * 1024 + 1));
  });
  const oversized = await loadHolfuyStation({ station: holfuy }, { environment: oversizedEnv });
  assert.equal(oversized.status, 'unavailable');
});

test('authenticated Holfuy cache is never reused across credentials or by public loaders', async () => {
  let apiCalls = 0;
  const env = environment(async input => {
    const url = new URL(input);
    if (url.hostname !== 'api.holfuy.com') return new Response('', { status: 403 });
    apiCalls += 1;
    if (url.searchParams.get('pw') !== 'test-only') return new Response('', { status: 403 });
    return new Response(JSON.stringify({ stationId: 1652, dateTime: '2026-10-26 18:00:00', wind: { speed: 2 } }));
  });
  const privateResult = await loadHolfuyStation({ station: holfuy, password: 'test-only' }, { environment: env });
  const publicResult = await loadHolfuyStation({ station: holfuy }, { environment: env });
  const wrongPassword = await loadHolfuyStation({ station: holfuy, password: 'wrong-test-password' }, { environment: env });
  assert.equal(privateResult.status, 'ok');
  assert.equal(publicResult.status, 'unavailable');
  assert.equal(wrongPassword.status, 'unavailable');
  assert.equal(apiCalls, 3);
});

test('WeatherLink metadata cannot send a server cookie to another origin', async () => {
  let requests = 0;
  const env = environment(async (_input, init) => {
    requests += 1;
    assert.equal(init.redirect, 'error');
    return new Response(JSON.stringify({ wind: 10, timestamp: anchor }));
  });
  const redirected = { ...station('weatherlink'), locator: { endpointUrl: 'https://untrusted.example/bulletin' } };
  const result = await loadWeatherLinkStation({ station: redirected, cookie: 'session=test' }, { environment: env });
  assert.equal(result.status, 'unavailable');
  assert.equal(requests, 0);

  const insecure = { ...station('weatherlink'), locator: { endpointUrl: 'http://www.weatherlink.com/bulletin/data/test' } };
  assert.equal((await loadWeatherLinkStation({ station: insecure, cookie: 'session=test' }, { environment: env })).status, 'unavailable');
  assert.equal(requests, 0);
  assert.equal((await loadWeatherLinkStation({ station: station('weatherlink'), cookie: 'session=test' }, { environment: env })).status, 'ok');
  assert.equal(requests, 1);
  const changedEndpoint = { ...station('weatherlink'), locator: { endpointUrl: 'https://www.weatherlink.com/bulletin/data/changed' } };
  assert.equal((await loadWeatherLinkStation({ station: changedEndpoint, cookie: 'session=test' }, { environment: env })).status, 'ok');
  assert.equal(requests, 2);
});

test('realtime.txt uses station-local source time, actual gusts and sensor status', () => {
  const fields = '26/10/26 18:00:00 68 52 50 10 99 265 0 0 29.92 W 3 mph F in mm 120'.split(' ');
  const reading = parseRealtimeTxt(fields.join(' '), 'America/Los_Angeles');
  assert.equal(reading.observedAt, '2026-10-27T01:00:00.000Z');
  assert.equal(reading.temperatureC, 20);
  assert.equal(reading.windGustMps, null);
  fields.length = 51;
  for (let i = 18; i < fields.length; i++) fields[i] = '0';
  fields[40] = '20';
  fields[46] = '180';
  assert.equal(parseRealtimeTxt(fields.join(' '), 'UTC').windGustMps, 20 * 0.44704);
  assert.equal(parseRealtimeTxt(fields.join(' '), 'UTC').windDirectionDeg, 180);
  fields[50] = '1';
  assert.throws(() => parseRealtimeTxt(fields.join(' '), 'UTC'), /sensor contact/);
  fields[50] = '0'; fields[40] = '10000';
  assert.throws(() => parseRealtimeTxt(fields.join(' '), 'UTC'), /wind speed/);
  fields[40] = '20'; fields[0] = '31/02/26';
  assert.throws(() => parseRealtimeTxt(fields.join(' '), 'UTC'), /time/);
  assert.throws(() => parseRealtimeTxt(fields.join(' '), ''), /time zone/);
});

test('Winds.mobi and WindSpion preserve valid rows around corrupt readings', () => {
  const wmList = parseWindsMobiList(JSON.stringify([
    wm, { ...wm, _id: 'bad', last: { ...wm.last, 'w-avg': 10000 } },
  ]));
  assert.equal(wmList[0].reading.windAvgMps, 5);
  assert.equal(wmList[1].reading, null);
  const historic = parseWindsMobiHistoric(JSON.stringify([wm.last, { ...wm.last, 'w-avg': 10000 }, { ...wm.last, _id: 1e100 }]));
  assert.equal(historic.points.length, 1);
  const spion = parseWindSpionList(JSON.stringify([ws, { ...ws, id: 'bad', wind: 10000 }]));
  assert.equal(spion[0].reading.windAvgMps, 5);
  assert.equal(spion[1].reading, null);
  const numericTime = parseWindSpionList(JSON.stringify([{ ...ws, ts: String(anchor / 1000) }]))[0];
  assert.equal(numericTime.reading.observedAt, new Date(anchor).toISOString());
});

test('nearby or mismatched stations cannot satisfy a requested reading', async () => {
  const spion = await loadWindSpionStation({ station: station('windspion') }, {
    environment: environment(async () => new Response(JSON.stringify([{ ...ws, id: 'another' }]))),
  });
  const mobi = await loadWindsMobiStation({ station: station('windsmobi') }, {
    mode: 'current',
    environment: environment(async () => new Response(JSON.stringify({ ...wm, _id: 'another' }))),
  });
  assert.equal(spion.status, 'unavailable');
  assert.equal(mobi.status, 'unavailable');
  assert.throws(() => parseWindGuruCurrent(JSON.stringify({ id_station: 2, unixtime: anchor / 1000, wind_avg: 10 }), '1'), /wrong station/);
  assert.throws(() => parseWindGuruCurrent(JSON.stringify({ unixtime: 1e100, wind_avg: 10 })), /unixtime/);
});

test('Winds.mobi history honors the requested duration', async () => {
  let duration;
  const result = await loadWindsMobiStation({ station: station('windsmobi') }, {
    historyHours: 2,
    environment: environment(async input => {
      const url = new URL(input);
      if (url.pathname.includes('/historic/')) {
        duration = url.searchParams.get('duration');
        return new Response(JSON.stringify([wm.last]));
      }
      return new Response(JSON.stringify(wm));
    }),
  });
  assert.equal(result.status, 'ok');
  assert.equal(duration, '7200');
});

test('WindNerd discovery reads standard split SSE INIT frames and closes streams', async () => {
  let cancelled = false;
  const frame = 'data: ' + JSON.stringify({ type: 'INIT', location: {
    id: 123, name: 'Synthetic launch', guessed_position: { lat: 40.1, lon: 44.4 }, altitude: 1800, timezone: 'Asia/Yerevan',
  } }) + '\r\n\r\n';
  const encoder = new TextEncoder();
  const stations = await windnerdProvider.discover({ regions: ['AM'], includeRemoteDiscovery: true,
    environment: environment(async input => {
      if (String(input).includes('/en/stations')) return new Response('<a href="/en/synthetic-launch">Station</a>');
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode(frame.slice(0, 30))); controller.enqueue(encoder.encode(frame.slice(30))); },
        cancel() { cancelled = true; },
      }));
    }),
  });
  assert.equal(stations.length, 1);
  assert.equal(stations[0].locator.locationId, 123);
  assert.equal(cancelled, true);
  const unconfigured = windnerdConfigFromCatalogue(station('windnerd'));
  assert.equal(unconfigured.vendor, 'custom');
  assert.equal((await unconfigured.load()).reason, 'not_configured');
});
