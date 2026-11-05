import assert from 'node:assert/strict';
import test from 'node:test';
import { CAMPBELL_FIELD_CONTRACTS } from '@azohra/meteo.station/server';
import { createProviderFetch, createStationsApiHandler, memoryCache } from '../dist/index.js';

const now = '2026-11-05T12:00:00.000Z';
const station = (vendor, locator) => ({
  uid: `${vendor}:sample`, vendor, nativeId: 'sample', name: 'Sample',
  latitude: 40, longitude: 44, elevationM: 1200, country: 'AM', region: null,
  timeZone: 'Etc/UTC', pageUrl: null, locator,
  capabilities: { gustLull: true, temperature: false, conditions: false, history: true },
  samplingWindowSeconds: 60, recommendedPollSeconds: 60,
});

for (const vendor of ['windnerd', 'campbell']) {
  test(`${vendor} current-only feed preserves native adapter mode and shares its snapshot with current`, async () => {
    const urls = [];
    const entry = station(vendor, vendor === 'windnerd'
      ? { stationKey: 'sample', locationId: 123 }
      : { baseUrl: 'https://campbell.test/', source: 'Loggernet:sample' });
    const handler = createStationsApiHandler({
      catalogue: { schemaVersion: 1, generatedAt: now, regions: ['AM'], stations: [entry] },
      basePath: '/api/stations',
      environment: {
        cache: memoryCache(), now: () => new Date(now), logger: () => {},
        fetch: createProviderFetch({ minIntervalMs: 0, maxAttempts: 1, fetch: async input => {
          const url = new URL(input instanceof Request ? input.url : input);
          urls.push(url);
          if (vendor === 'windnerd') {
            assert.match(url.pathname, /^\/api\/live-url\//);
            return new Response(`data: ${JSON.stringify({
              type: 'INIT', samples: [], location: null,
              digest: { recent: { date_utc: now, wind_avg_1D: 10, wind_dir: 180, wind_max: 15, wind_min: 5 } },
            })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
          }
          assert.equal(url.searchParams.get('mode'), 'most-recent');
          assert.equal(url.searchParams.get('uri'), 'Loggernet:sample.I3Sec');
          return new Response(JSON.stringify({
            more: false,
            head: {
              environment: { station_name: 'sample', table_name: 'I3Sec', interval: 3000 },
              fields: CAMPBELL_FIELD_CONTRACTS.current,
            },
            data: [{ time: '2026-11-05T12:00:00', vals: [36, 18, 54, 180] }],
          }));
        } }),
      },
    });
    const response = await handler(new Request(`https://stations.test/api/stations/feed?ids=${entry.uid}&history=0`));
    assert.equal(response.status, 200);
    const feed = await response.json();
    assert.equal(feed.stations[0].status, 'ok');
    assert.equal(feed.stations[0].reading.windAvgMps, 10);
    assert.equal(feed.stations[0].history, null);
    assert.equal(urls.length, 1, 'current-only mode must not fetch a records/history window');

    const current = await handler(new Request(`https://stations.test/api/stations/current?station=${entry.uid}`));
    assert.equal(current.headers.get('X-Station-Cache'), 'hit');
    assert.equal((await current.json()).station.reading.windAvgMps, 10);
    assert.equal(urls.length, 1, 'feed and current share the normalized station snapshot');
  });
}
