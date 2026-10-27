import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryCache } from '@stations/providers';
import {
  createExplorerRequestHandler,
  loadExplorerCatalogue,
  startExplorerServer,
} from '../serve-explorer.mjs';

test('explorer server serves HTML, bundled assets, sanitized /catalogue, and hydrated /feed', async t => {
  const catalogue = loadExplorerCatalogue();
  assert.ok(catalogue.stations.length >= 20);

  const hydratedStation = catalogue.stations.find(
    s => Object.keys(s.locator).length > 0 && (s.vendor === 'windnerd' || s.vendor === 'holfuy' || s.vendor === 'awc'),
  );
  assert.ok(hydratedStation);

  const handler = createExplorerRequestHandler({
    catalogue,
    environment: {
      now: () => new Date('2026-10-26T18:05:00Z'),
      cache: memoryCache(),
      logger: () => {},
      fetch: async input => {
        const url = String(input);
        if (url.includes('aviationweather.gov')) {
          return new Response(
            JSON.stringify([
              {
                icaoId: 'KSEA',
                name: 'Seattle-Tacoma International',
                lat: 47.449,
                lon: -122.309,
                elev: 132,
                obsTime: 1793037600,
                wdir: 210,
                wspd: 12,
                wgst: 18,
                temp: 14.5,
                dewp: 8.0,
                slp: 1016.2,
              },
            ]),
            { status: 200 },
          );
        }
        return new Response('offline', { status: 502 });
      },
    },
  });

  const htmlRes = await handler(new Request('http://127.0.0.1:4331/'));
  assert.equal(htmlRes.status, 200);
  const html = await htmlRes.text();
  assert.ok(html.includes('id="stations-map"'));
  assert.ok(html.includes('/dist/app.js'));

  const xctRes = await handler(new Request('http://127.0.0.1:4331/xct'));
  assert.equal(xctRes.status, 200);
  const xctHtml = await xctRes.text();
  assert.ok(xctHtml.includes('id="station-list"'));
  assert.ok(xctHtml.includes('/dist/xct.js'));

  const useRes = await handler(new Request('http://127.0.0.1:4331/xct-use'));
  assert.equal(useRes.status, 200);
  const useHtml = await useRes.text();
  assert.ok(useHtml.includes('id="copy"'));
  assert.ok(useHtml.includes('id="widget-url"'));
  for (const param of ['units', 'size', 'mode', 'lat, lng', 'alt', 'maxage', 'category', 'debug']) {
    assert.ok(useHtml.includes(`<th>${param}</th>`), param);
  }

  const catRes = await handler(
    new Request('http://127.0.0.1:4331/api/stations/catalogue?country=US&category=freeflight'),
  );
  assert.equal(catRes.status, 200);
  const catJson = await catRes.json();
  assert.ok(catJson.stations.length >= 4);
  assert.ok(catJson.stations.every(s => Object.keys(s.locator).length === 0));

  const feedRes = await handler(
    new Request('http://127.0.0.1:4331/api/stations/feed?ids=awc:KSEA'),
  );
  assert.equal(feedRes.status, 200);
  const feedJson = await feedRes.json();
  assert.equal(feedJson.stations.length, 1);
  assert.equal(feedJson.stations[0].status, 'ok');
  assert.equal(feedJson.stations[0].reading.temperatureC, 14.5);

  const server = await startExplorerServer({ port: 0, catalogue });
  t.after(() => server.close());
  const liveCatRes = await fetch(`${server.url}/api/stations/catalogue?country=AM`);
  assert.equal(liveCatRes.status, 200);
  const liveCat = await liveCatRes.json();
  assert.ok(liveCat.stations.length >= 2);
});
