import assert from 'node:assert/strict';
import test from 'node:test';
import {
  catalogueKeys,
  createHydratedCatalogueLoader,
  getPublicCatalogueObject,
} from '../catalogue.ts';
import { PROVIDER_SECRET_NAMES, credentialsFromEnv } from '../credentials.ts';

const DOCUMENT = { schemaVersion: 1, generatedAt: '2026-10-27T00:00:00.000Z', regions: ['US'], stations: [] };

function fakeStore(initial) {
  const store = {
    objects: new Map(Object.entries(initial)),
    calls: [],
    async head(key) {
      store.calls.push(['head', key]);
      const object = store.objects.get(key);
      return object ? { httpEtag: object.etag, size: object.text.length } : null;
    },
    async get(key, options) {
      store.calls.push(['get', key, options?.onlyIf?.get('If-None-Match') ?? null]);
      const object = store.objects.get(key);
      if (!object) return null;
      const base = { httpEtag: object.etag, size: object.text.length };
      if (options?.onlyIf?.get('If-None-Match') === object.etag) return base;
      return { ...base, body: new Blob([object.text]).stream(), text: async () => object.text };
    },
  };
  return store;
}

test('catalogueKeys derives the three object keys from the configured prefix', () => {
  assert.deepEqual(catalogueKeys('catalogue/stations'), {
    hydrated: 'catalogue/stations.hydrated.json',
    json: 'catalogue/stations.public.json',
    geojson: 'catalogue/stations.public.geojson',
  });
});

test('hydrated loader downloads once, revalidates by etag and shares in-flight loads', async () => {
  let nowMs = 1_000;
  const store = fakeStore({ hydrated: { etag: '"v1"', text: JSON.stringify(DOCUMENT) } });
  const load = createHydratedCatalogueLoader({ store, key: 'hydrated', revalidateMs: 300_000, now: () => nowMs });

  const [first, second] = await Promise.all([load(), load()]);
  assert.equal(first, second);
  assert.equal(first.generatedAt, DOCUMENT.generatedAt);
  assert.deepEqual(store.calls, [['get', 'hydrated', null]]);

  nowMs += 100_000;
  assert.equal(await load(), first, 'within the interval the document is served from memory');
  assert.equal(store.calls.length, 1);

  nowMs += 300_000;
  assert.equal(await load(), first, 'an unchanged etag keeps the parsed document');
  assert.deepEqual(store.calls.at(-1), ['head', 'hydrated']);
  assert.equal(store.calls.length, 2);

  store.objects.set('hydrated', { etag: '"v2"', text: JSON.stringify({ ...DOCUMENT, generatedAt: '2026-10-28T00:00:00.000Z' }) });
  nowMs += 300_000;
  const refreshed = await load();
  assert.notEqual(refreshed, first);
  assert.equal(refreshed.generatedAt, '2026-10-28T00:00:00.000Z');
  assert.deepEqual(store.calls.slice(2), [['head', 'hydrated'], ['get', 'hydrated', null]]);
});

test('hydrated loader keeps the last document when a refresh fails and surfaces first-load errors', async () => {
  let nowMs = 0;
  const store = fakeStore({ hydrated: { etag: '"v1"', text: JSON.stringify(DOCUMENT) } });
  const load = createHydratedCatalogueLoader({ store, key: 'hydrated', revalidateMs: 1_000, now: () => nowMs });
  const doc = await load();

  store.objects.delete('hydrated');
  nowMs = 5_000;
  assert.equal(await load(), doc, 'a missing object after a successful load keeps serving');
  nowMs = 5_500;
  assert.equal(await load(), doc);
  assert.equal(store.calls.filter(([method]) => method === 'head').length, 1, 'failed refreshes wait a full interval');

  const empty = createHydratedCatalogueLoader({ store: fakeStore({}), key: 'hydrated' });
  await assert.rejects(empty(), /missing/);

  const invalid = createHydratedCatalogueLoader({
    store: fakeStore({ hydrated: { etag: '"x"', text: JSON.stringify({ schemaVersion: 2, stations: [] }) } }),
    key: 'hydrated',
  });
  await assert.rejects(invalid(), /not a station catalogue document/);
});

test('getPublicCatalogueObject forwards If-None-Match and reports matches as a null body', async () => {
  const store = fakeStore({ pub: { etag: '"p1"', text: '{}' } });

  const fresh = await getPublicCatalogueObject(store, 'pub', null);
  assert.equal(fresh.etag, '"p1"');
  assert.equal(fresh.size, 2);
  assert.ok(fresh.body instanceof ReadableStream);
  assert.equal(await new Response(fresh.body).text(), '{}');

  const matched = await getPublicCatalogueObject(store, 'pub', '"p1"');
  assert.equal(matched.body, null);
  assert.equal(matched.etag, '"p1"');
  assert.deepEqual(store.calls.at(-1), ['get', 'pub', '"p1"']);

  assert.equal(await getPublicCatalogueObject(store, 'absent', null), null);
});

test('credentialsFromEnv maps every secret name, trims values and ignores blanks', () => {
  assert.equal(PROVIDER_SECRET_NAMES.length, 9);
  assert.deepEqual(credentialsFromEnv({}), {});
  assert.deepEqual(
    credentialsFromEnv({
      HOLFUY_API_KEY: ' holfuy ',
      TEMPEST_TOKEN: 'tempest',
      WU_API_KEY: '',
      SYNOPTIC_TOKEN: 'syn-token',
      SYNOPTIC_API_KEY: 'syn-key',
      ECOWITT_APP_KEY: 'eco-app',
      ECOWITT_API_KEY: 'eco-api',
      AMBIENT_API_KEY: 'amb-api',
      AMBIENT_APP_KEY: 'amb-app',
      UNRELATED: 'ignored',
    }),
    {
      holfuyApiKey: 'holfuy',
      tempestToken: 'tempest',
      synopticToken: 'syn-token',
      synopticApiKey: 'syn-key',
      ecowittApplicationKey: 'eco-app',
      ecowittApiKey: 'eco-api',
      ambientApiKey: 'amb-api',
      ambientApplicationKey: 'amb-app',
    },
  );
});
