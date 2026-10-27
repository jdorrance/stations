/**
 * Builds the catalogue objects the Cloudflare Worker reads from R2 and
 * optionally uploads them.
 *
 * Inputs: the public catalogue in `data/catalogue/`, private locator
 * checkpoints in `.cache/stations-crawl/` (via `loadExplorerCatalogue`) and the
 * Worker name, bucket and key prefix from `wrangler.json`.
 * Outputs: `.cache/stations-deploy/stations.{hydrated.json,public.json,public.geojson}`
 * and, with `--upload` (remote R2) or `--local` (wrangler dev storage), the
 * same objects under the keys in `deploy/worker/catalogue.ts`.
 *
 * Usage: node scripts/export-deploy-catalogue.mjs [--upload | --local] [--out <dir>] [--min-stations <n>]
 */
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { catalogueToGeoJson, toPublicStationCatalogue } from '@stations/contracts';
import { catalogueKeys } from '../deploy/worker/catalogue.ts';
import { loadExplorerCatalogue } from './serve-explorer.mjs';
import { readWorkerConfig, root, wrangler } from './workspace.mjs';

/** Above this the isolate's memory headroom shrinks; shard by region instead of raising it. */
export const MAX_HYDRATED_BYTES = 40 * 1024 * 1024;

/** Real crawls hydrate ~97% of stations; seeds alone hydrate well under 1%. */
export const MIN_HYDRATED_SHARE = 0.5;

const CONTENT_TYPES = {
  hydrated: 'application/json; charset=utf-8',
  json: 'application/json; charset=utf-8',
  geojson: 'application/geo+json; charset=utf-8',
};

const FILE_NAMES = {
  hydrated: 'stations.hydrated.json',
  json: 'stations.public.json',
  geojson: 'stations.public.geojson',
};

/**
 * Serializes one hydrated catalogue into the three deploy artifacts. The public
 * documents are produced by the same contract functions the crawler and the API
 * handler use, so the Worker streams bytes identical to a handler response.
 * `minStations` lets a caller refuse to publish a crawl that shrank. Live
 * adapters need locators, so a catalogue where fewer than `minHydratedShare`
 * of the stations carry one is refused as well: that is what a missing or
 * unreadable `.cache/stations-crawl/` looks like.
 */
export function buildDeployArtifacts(catalogue, {
  maxHydratedBytes = MAX_HYDRATED_BYTES, minStations = 1, minHydratedShare = MIN_HYDRATED_SHARE,
} = {}) {
  const count = Array.isArray(catalogue.stations) ? catalogue.stations.length : 0;
  if (count === 0) {
    throw new Error('Catalogue has no stations; run pnpm catalogue:crawl or catalogue:build first');
  }
  if (count < minStations) {
    throw new Error(`Catalogue has ${count} stations, below the required ${minStations}; a degraded crawl is not published`);
  }
  const hydratedCount = catalogue.stations.filter(station => Object.keys(station.locator ?? {}).length > 0).length;
  if (hydratedCount < count * minHydratedShare) {
    throw new Error(
      `Only ${hydratedCount} of ${count} stations carry a locator; live adapters need the ` +
      '.cache/stations-crawl/ checkpoints (node scripts/sync-crawl-checkpoints.mjs --restore)',
    );
  }
  const document = {
    schemaVersion: catalogue.schemaVersion,
    generatedAt: catalogue.generatedAt,
    regions: catalogue.regions,
    stations: catalogue.stations,
  };
  const publicDocument = toPublicStationCatalogue(document);
  if (publicDocument.stations.some(station => Object.keys(station.locator).length > 0)) {
    throw new Error('Public catalogue still contains locators');
  }
  const geojson = catalogueToGeoJson(publicDocument.stations, catalogue.generatedAt);
  if (publicDocument.generatedAt !== catalogue.generatedAt || geojson.generatedAt !== catalogue.generatedAt) {
    throw new Error('generatedAt differs between hydrated, public and GeoJSON documents');
  }
  const hydratedText = JSON.stringify(document);
  const hydratedBytes = Buffer.byteLength(hydratedText);
  if (hydratedBytes > maxHydratedBytes) {
    throw new Error(
      `Hydrated catalogue is ${(hydratedBytes / 1_048_576).toFixed(1)} MiB, above the ` +
      `${(maxHydratedBytes / 1_048_576).toFixed(0)} MiB limit; shard the catalogue by region before deploying`,
    );
  }
  return {
    generatedAt: catalogue.generatedAt,
    stations: catalogue.stations.length,
    hydratedStations: hydratedCount,
    artifacts: [
      { kind: 'hydrated', text: hydratedText, contentType: CONTENT_TYPES.hydrated },
      { kind: 'json', text: JSON.stringify(publicDocument), contentType: CONTENT_TYPES.json },
      { kind: 'geojson', text: JSON.stringify(geojson), contentType: CONTENT_TYPES.geojson },
    ],
  };
}

function writePrivate(path, text) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function putObject({ bucket, key, file, contentType, mode }) {
  const result = wrangler([
    'r2', 'object', 'put', `${bucket}/${key}`,
    '--file', file, '--content-type', contentType, mode === 'remote' ? '--remote' : '--local',
  ]);
  if (result.status !== 0) throw new Error(`wrangler r2 object put failed for ${bucket}/${key}`);
}

export function exportDeployCatalogue({
  outDir = resolve(root, '.cache/stations-deploy'), mode = null, minStations = 1, log = console.log,
} = {}) {
  const target = readWorkerConfig();
  const keys = catalogueKeys(target.prefix);
  const built = buildDeployArtifacts(loadExplorerCatalogue({ full: true }), { minStations });
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  log(`Catalogue ${built.generatedAt}: ${built.stations} stations, ${built.hydratedStations} with private locators`);
  const written = [];
  for (const artifact of built.artifacts) {
    const file = resolve(outDir, FILE_NAMES[artifact.kind]);
    writePrivate(file, artifact.text);
    log(`  ${FILE_NAMES[artifact.kind]}  ${(Buffer.byteLength(artifact.text) / 1_048_576).toFixed(1)} MiB`);
    written.push({ ...artifact, file, key: keys[artifact.kind] });
  }
  if (mode) {
    for (const artifact of written) {
      log(`Uploading ${target.bucket}/${artifact.key} (${mode})`);
      putObject({ bucket: target.bucket, key: artifact.key, file: artifact.file, contentType: artifact.contentType, mode });
    }
  }
  return { ...built, artifacts: written, target };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      upload: { type: 'boolean', default: false },
      local: { type: 'boolean', default: false },
      out: { type: 'string' },
      'min-stations': { type: 'string', default: '1' },
    },
  });
  if (values.upload && values.local) throw new Error('Choose one of --upload (remote R2) or --local (wrangler dev storage)');
  const minStations = Number(values['min-stations']);
  if (!Number.isInteger(minStations) || minStations < 1) throw new Error('--min-stations must be a positive integer');
  exportDeployCatalogue({
    outDir: values.out ? resolve(values.out) : undefined,
    mode: values.upload ? 'remote' : values.local ? 'local' : null,
    minStations,
  });
}
