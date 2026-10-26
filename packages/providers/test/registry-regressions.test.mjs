import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverStations, INITIAL_SEED_STATIONS, mergeDiscoveredStations } from '../dist/index.js';

const direct = {
  ...INITIAL_SEED_STATIONS.find(station => station.vendor === 'holfuy'),
  name: 'Direct station metadata', recommendedPollSeconds: 60,
};
const aggregator = {
  ...direct, uid: 'windsmobi:copy', vendor: 'windsmobi', nativeId: 'copy',
  name: 'Aggregator metadata', latitude: direct.latitude + 0.01,
  recommendedPollSeconds: 600,
  aliases: [direct.uid, 'custom:historical'],
  locator: { pvCode: 'holfuy', pvId: direct.nativeId, windsMobiId: 'copy' },
};

test('discovery keeps direct-provider metadata regardless of vendor order or dedup mode', async () => {
  for (const vendors of [['holfuy', 'windsmobi'], ['windsmobi', 'holfuy']]) {
    for (const deduplicateCrossVendor of [false, true]) {
      const catalogue = await discoverStations({
        vendors, deduplicateCrossVendor, seeds: [direct, aggregator], includeRemoteDiscovery: false,
        environment: { now: () => new Date('2026-10-26T12:00:00Z'), logger: () => {}, fetch: async () => { throw new Error('unexpected network call'); } },
      });
      assert.equal(catalogue.stations.length, 1);
      const merged = catalogue.stations[0];
      assert.equal(merged.uid, direct.uid);
      assert.equal(merged.name, direct.name);
      assert.equal(merged.latitude, direct.latitude);
      assert.equal(merged.recommendedPollSeconds, 60);
      assert.deepEqual(merged.capabilities, direct.capabilities);
      assert.deepEqual(merged.locator, direct.locator);
      assert.deepEqual(merged.aliases, ['custom:historical', 'windsmobi:copy']);
    }
  }
});

test('shared discovery merger preserves aggregator-only canonical identities and aliases', () => {
  const [canonical] = mergeDiscoveredStations([aggregator], true);
  assert.equal(canonical.vendor, 'holfuy');
  assert.equal(canonical.uid, direct.uid);
  assert.equal(canonical.name, aggregator.name);
  assert.deepEqual([...canonical.aliases].sort(), ['custom:historical', 'windsmobi:copy']);
  assert.deepEqual(canonical.locator, { stationId: direct.nativeId });
  assert.deepEqual(mergeDiscoveredStations([direct, aggregator], true), mergeDiscoveredStations([aggregator, direct], true));
});
