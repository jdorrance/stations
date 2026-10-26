import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { catalogueToGeoJson } from '@stations/contracts';
import { INITIAL_SCOPE_REGIONS, isRegionCode } from '@stations/geography';
import { discoverStations } from '@stations/providers';

const { values: args } = parseArgs({
  options: {
    output: { type: 'string', default: 'data/catalogue' },
    regions: { type: 'string', default: INITIAL_SCOPE_REGIONS.join(',') },
    remote: { type: 'boolean', default: false },
  },
});

const requestedRegions = args.regions
  .split(',')
  .map(code => code.trim().toUpperCase())
  .filter(isRegionCode);

if (requestedRegions.length === 0) {
  throw new Error(`No valid region codes in --regions="${args.regions}"`);
}

const outDir = resolve(args.output);
const regionsDir = resolve(outDir, 'regions');
mkdirSync(regionsDir, { recursive: true });

const catalogue = await discoverStations({
  regions: requestedRegions,
  includeRemoteDiscovery: args.remote,
});

writeFileSync(
  resolve(outDir, 'stations.json'),
  `${JSON.stringify(catalogue, null, 2)}\n`,
);
writeFileSync(
  resolve(outDir, 'stations.geojson'),
  `${JSON.stringify(catalogueToGeoJson(catalogue.stations, catalogue.generatedAt), null, 2)}\n`,
);

for (const region of requestedRegions) {
  const regionalStations = catalogue.stations.filter(s => s.country === region);
  const regionalDoc = {
    schemaVersion: catalogue.schemaVersion,
    generatedAt: catalogue.generatedAt,
    regions: [region],
    stations: regionalStations,
  };
  writeFileSync(
    resolve(regionsDir, `${region.toLowerCase()}.json`),
    `${JSON.stringify(regionalDoc, null, 2)}\n`,
  );
}

console.log(
  `Wrote ${catalogue.stations.length} stations across [${requestedRegions.join(', ')}] to ${outDir}`,
);
