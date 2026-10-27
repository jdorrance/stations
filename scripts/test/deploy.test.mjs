import assert from 'node:assert/strict';
import test from 'node:test';
import { INITIAL_SEED_STATIONS } from '@stations/providers';
import { buildDeployArtifacts } from '../export-deploy-catalogue.mjs';
import { CHECKPOINTS_KEY, isMissingObject } from '../sync-crawl-checkpoints.mjs';
import { planWorkerSecrets } from '../sync-worker-secrets.mjs';
import { readWorkerConfig } from '../workspace.mjs';

const catalogue = {
  schemaVersion: 1,
  generatedAt: '2026-10-27T08:14:21.397Z',
  regions: ['US', 'CA'],
  stations: INITIAL_SEED_STATIONS,
};

test('deploy artifacts keep locators private and share one generatedAt', () => {
  const built = buildDeployArtifacts(catalogue);
  assert.equal(built.stations, INITIAL_SEED_STATIONS.length);
  assert.ok(built.hydratedStations > 0);
  assert.deepEqual(built.artifacts.map(artifact => artifact.kind), ['hydrated', 'json', 'geojson']);

  const [hydrated, json, geojson] = built.artifacts.map(artifact => JSON.parse(artifact.text));
  assert.equal(hydrated.generatedAt, catalogue.generatedAt);
  assert.equal(json.generatedAt, catalogue.generatedAt);
  assert.equal(geojson.generatedAt, catalogue.generatedAt);
  assert.deepEqual(Object.keys(hydrated), ['schemaVersion', 'generatedAt', 'regions', 'stations']);
  assert.ok(hydrated.stations.some(station => Object.keys(station.locator).length > 0));
  assert.ok(json.stations.every(station => Object.keys(station.locator).length === 0));
  assert.equal(geojson.type, 'FeatureCollection');
  assert.equal(geojson.features.length, INITIAL_SEED_STATIONS.length);
  assert.ok(!built.artifacts[1].text.includes('"locator":{"') && !built.artifacts[2].text.includes('"locator"'));
  assert.equal(built.artifacts[2].contentType, 'application/geo+json; charset=utf-8');
});

test('deploy artifacts refuse empty, shrunken, unhydrated or oversized catalogues', () => {
  assert.throws(() => buildDeployArtifacts({ ...catalogue, stations: [] }), /no stations/);
  assert.throws(
    () => buildDeployArtifacts(catalogue, { minStations: INITIAL_SEED_STATIONS.length + 1 }),
    /below the required \d+; a degraded crawl is not published/,
  );
  assert.ok(buildDeployArtifacts(catalogue, { minStations: INITIAL_SEED_STATIONS.length }));
  assert.throws(
    () => buildDeployArtifacts({ ...catalogue, stations: catalogue.stations.map(station => ({ ...station, locator: {} })) }),
    /No station carries a locator/,
  );
  assert.throws(() => buildDeployArtifacts(catalogue, { maxHydratedBytes: 1024 }), /above the 0 MiB limit; shard/);
});

test('readWorkerConfig resolves the Worker name, bucket and key prefix from wrangler.json', () => {
  const config = readWorkerConfig();
  assert.equal(config.name, 'stations');
  assert.equal(config.bucket, 'stations-catalogue-private');
  assert.equal(config.prefix, 'catalogue/stations');
});

test('crawl checkpoints live under a private key and a first restore tolerates an absent object', () => {
  assert.match(CHECKPOINTS_KEY, /^checkpoints\/.+\.tar\.gz$/);
  assert.ok(isMissingObject('✘ [ERROR] The specified key does not exist.'));
  assert.ok(!isMissingObject('✘ [ERROR] Authentication error [code: 10000]'));
  assert.ok(!isMissingObject(undefined));
});

test('planWorkerSecrets sets present names, removes stale ones and skips the rest', () => {
  const names = ['A_KEY', 'B_KEY', 'C_KEY', 'D_KEY'];
  const plan = planWorkerSecrets(names, { A_KEY: ' a-value ', B_KEY: '', D_KEY: undefined }, ['B_KEY', 'A_KEY']);
  assert.deepEqual(plan.patch, { A_KEY: 'a-value', B_KEY: null });
  assert.deepEqual(plan.set, ['A_KEY']);
  assert.deepEqual(plan.removed, ['B_KEY']);
  assert.deepEqual(plan.absent, ['C_KEY', 'D_KEY']);

  const untouched = planWorkerSecrets(names, {}, []);
  assert.deepEqual(untouched.patch, {});
  assert.deepEqual(untouched.absent, names);
});
