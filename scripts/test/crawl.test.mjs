import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { crawlCatalogue } from '../crawl-na.mjs';

function station(id, country = 'US', overrides = {}) {
  return {
    uid: `windnerd:${id}`, vendor: 'windnerd', nativeId: id, name: id,
    latitude: 47.5, longitude: -122, elevationM: 100, country,
    region: null, timeZone: null, pageUrl: null,
    capabilities: { gustLull: false, temperature: false, conditions: false, history: false },
    samplingWindowSeconds: null, recommendedPollSeconds: 60, locator: { locationId: 101 },
    ...overrides,
  };
}

function setup(t, discover) {
  const directory = mkdtempSync(join(tmpdir(), 'stations-crawl-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return {
    output: join(directory, 'public'), cache: join(directory, 'private'),
    providers: { windnerd: { discover } }, vendors: ['windnerd'], regions: ['US'],
    launches: [], seeds: [], log: () => {},
    environment: { now: () => new Date('2026-10-26T12:00:00Z'), logger: () => {} },
  };
}
const json = path => JSON.parse(readFileSync(path, 'utf8'));

test('crawl applies curated short names and fill-only place fields from the overrides file', async t => {
  const options = setup(t, async () => [
    station('hatis', 'AM', {
      name: 'Hatis (IHATIS1)',
      elevationM: null,
      region: null,
      latitude: 40.3347,
      longitude: 44.73241,
    }),
    station('elevated', 'AM', {
      name: 'Already Elevated',
      elevationM: 1689,
      region: 'Shirak',
    }),
  ]);
  options.regions = ['AM'];
  options.overrides = join(options.output, '..', 'overrides.json');
  writeFileSync(options.overrides, `${JSON.stringify({
    schemaVersion: 1,
    stations: {
      'windnerd:hatis': { shortName: 'Hatis', elevationM: 2529, region: 'Kotayk' },
      'windnerd:elevated': { shortName: 'Maralik', elevationM: 1, region: 'Elsewhere' },
    },
  }, null, 2)}\n`);
  await crawlCatalogue(options);
  const output = json(join(options.output, 'stations.json'));
  const hatis = output.stations.find(item => item.uid === 'windnerd:hatis');
  const elevated = output.stations.find(item => item.uid === 'windnerd:elevated');
  assert.equal(hatis.shortName, 'Hatis');
  assert.equal(hatis.name, 'Hatis (IHATIS1)');
  assert.equal(hatis.elevationM, 2529);
  assert.equal(hatis.region, 'Kotayk');
  assert.equal(elevated.shortName, 'Maralik');
  assert.equal(elevated.elevationM, 1689);
  assert.equal(elevated.region, 'Shirak');

  options.overrides = join(options.output, '..', 'bad-overrides.json');
  writeFileSync(options.overrides, `${JSON.stringify({
    schemaVersion: 1,
    stations: { bad: { shortName: 'X' } },
  })}\n`);
  await assert.rejects(() => crawlCatalogue(options), /Invalid station overrides/);
});

test('crawl preserves unknown countries, keeps private locators outside public output, and hashes all artifacts', async t => {
  const secret = 'TEST_PRIVATE_LOCATOR';
  const options = setup(t, async () => [
    station('known', 'US', { locator: { locationId: 101, token: secret } }),
    station('unknown', null), station('canada', 'CA'),
  ]);
  const manifest = await crawlCatalogue(options);
  assert.equal(manifest.totalStations, 2);
  assert.equal(manifest.unknownCountryStations, 1);
  assert.equal(manifest.countsByRegion.US, 1);
  const output = json(join(options.output, 'stations.json'));
  assert.deepEqual(output.stations.map(station => station.country).sort(), ['US', null].sort());
  assert.ok(output.stations.every(station => Object.keys(station.locator).length === 0));
  const checkpointPath = join(options.cache, readdirSync(options.cache)[0]);
  assert.equal(json(checkpointPath).stations[0].locator.locationId, 101);
  assert.equal(statSync(checkpointPath).mode & 0o777, 0o600);
  for (const [path, artifact] of Object.entries(manifest.artifacts)) {
    const bytes = readFileSync(join(options.output, path));
    assert.equal(bytes.length, artifact.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256);
    assert.equal((path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString().includes(secret), false);
  }
});

test('resume validates scope, seed revisions, and checkpoint records instead of trusting public shards', async t => {
  let calls = 0;
  const options = setup(t, async () => { calls += 1; return [station('us'), station('ca', 'CA')]; });
  await crawlCatalogue(options);
  const resumed = await crawlCatalogue({ ...options, resume: true });
  assert.equal(calls, 1);
  assert.equal(resumed.vendorRuns.windnerd.status, 'resumed');
  const ca = await crawlCatalogue({ ...options, regions: ['CA'], resume: true });
  assert.equal(calls, 2);
  assert.equal(ca.countsByRegion.CA, 1);
  assert.equal(readdirSync(join(options.output, 'regions')).includes('us.json'), false);
  await crawlCatalogue({ ...options, seeds: [station('new-seed')], resume: true });
  assert.equal(calls, 3);
  const checkpoint = readdirSync(options.cache).map(path => join(options.cache, path))
    .find(path => json(path).scope.regions[0] === 'US' && json(path).scope.seedDigest === createHash('sha256').update('[]').digest('hex'));
  const corrupted = json(checkpoint);
  corrupted.stations[0].nativeId = ' ';
  writeFileSync(checkpoint, JSON.stringify(corrupted));
  await crawlCatalogue({ ...options, resume: true });
  assert.equal(calls, 4);
});

test('failed or partial discovery never becomes a successful resume checkpoint', async t => {
  let calls = 0;
  const options = setup(t, async () => {
    calls += 1;
    if (calls === 1) throw new Error('fixture failure');
    return [station('healthy'), { ...station('bad'), nativeId: ' ' }];
  });
  options.seeds = [station('fallback'), station('outside', 'CA')];
  const failed = await crawlCatalogue(options);
  assert.equal(failed.vendorRuns.windnerd.status, 'fallback');
  assert.equal(failed.totalStations, 1);
  assert.equal(readdirSync(options.cache).length, 0);
  const partial = await crawlCatalogue({ ...options, resume: true });
  assert.equal(partial.vendorRuns.windnerd.status, 'partial');
  assert.equal(partial.totalStations, 1);
  assert.equal(calls, 2);
  assert.equal(readdirSync(options.cache).length, 0);
});

test('invalid crawl options fail before invoking a provider or writing public checkpoints', async t => {
  const options = setup(t, () => { throw new Error('must not run'); });
  for (const overrides of [
    { regions: ['invalid'] }, { vendors: ['toString'] }, { vendors: [] },
    { corridorKm: -1 }, { maxLaunchKm: 10, corridorKm: 25 },
    { cache: join(options.output, 'private') },
  ]) await assert.rejects(crawlCatalogue({ ...options, ...overrides }));
});

test('symlinked cache roots and ancestors cannot place private checkpoints in public output', async t => {
  let calls = 0;
  const options = setup(t, async () => { calls += 1; return [station('private')]; });
  mkdirSync(options.output);
  symlinkSync(options.output, options.cache, 'dir');
  await assert.rejects(crawlCatalogue(options), /must be separate/);
  await assert.rejects(crawlCatalogue({ ...options, cache: join(options.cache, 'nested') }), /must be separate/);
  assert.equal(calls, 0);
  assert.deepEqual(readdirSync(options.output), ['nested']);
  assert.deepEqual(readdirSync(join(options.output, 'nested')), []);
});

test('direct provider metadata wins over unwrapped aggregators in either crawl order', async t => {
  const direct = station('42', 'US', {
    uid: 'holfuy:42', vendor: 'holfuy', name: 'Direct station', locator: { stationId: '42' },
  });
  const aggregate = station('copy', 'US', {
    uid: 'windsmobi:copy', vendor: 'windsmobi', name: 'Aggregator copy',
    latitude: 47.6, locator: { pvCode: 'holfuy', pvId: '42' },
  });
  const options = setup(t, async () => []);
  options.providers = {
    holfuy: { discover: async () => [direct] },
    windsmobi: { discover: async () => [aggregate] },
  };
  for (const vendors of [['holfuy', 'windsmobi'], ['windsmobi', 'holfuy']]) {
    await crawlCatalogue({ ...options, vendors });
    const { stations } = json(join(options.output, 'stations.json'));
    assert.equal(stations.length, 1);
    assert.equal(stations[0].name, 'Direct station');
    assert.equal(stations[0].latitude, direct.latitude);
    assert.ok(stations[0].aliases.includes('windsmobi:copy'));
  }
});
