import { parseArgs } from 'node:util';
import { INITIAL_SCOPE_REGIONS, isRegionCode } from '@stations/geography';
import { DEFAULT_DISCOVERY_VENDORS } from '@stations/providers';
import { crawlCatalogue } from './crawl-na.mjs';

const { values: args } = parseArgs({
  options: {
    output: { type: 'string', default: 'data/catalogue' },
    cache: { type: 'string', default: '.cache/stations-crawl' },
    regions: { type: 'string', default: INITIAL_SCOPE_REGIONS.join(',') },
    remote: { type: 'boolean', default: false },
  },
});
const regions = [...new Set(args.regions.split(',').map(code => code.trim().toUpperCase()))];
if (!regions.length || regions.some(code => !isRegionCode(code))) {
  throw new Error(`Invalid region codes in --regions="${args.regions}"`);
}

await crawlCatalogue({
  output: args.output,
  cache: args.cache,
  regions,
  vendors: DEFAULT_DISCOVERY_VENDORS,
  offline: !args.remote,
});
