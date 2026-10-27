/**
 * Mirrors the private crawl checkpoints between `.cache/stations-crawl/` and R2.
 *
 * The scheduled crawl restores them first so `pnpm deploy:catalogue` can
 * hydrate adapter locators and `--resume` can continue an interrupted run,
 * then uploads the refreshed set. Checkpoints carry private locators, so they
 * live in the same private bucket as the hydrated catalogue and never in
 * Actions cache or git.
 *
 * Inputs: the bucket from `wrangler.json`; Cloudflare auth via
 * `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` or a `wrangler login`.
 * Usage: node scripts/sync-crawl-checkpoints.mjs --restore | --upload
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readWorkerConfig, root, wrangler } from './workspace.mjs';

/** One tarball in the private bucket, next to the catalogue objects. */
export const CHECKPOINTS_KEY = 'checkpoints/stations-crawl.tar.gz';

const CACHE_DIR = resolve(root, '.cache');
const CHECKPOINTS_DIR = resolve(CACHE_DIR, 'stations-crawl');

/** Wrangler's message for an absent key; a first restore is not a failure. */
export function isMissingObject(output) {
  return /specified key does not exist/i.test(output ?? '');
}

/** Checkpoint files are `<vendor>-<scope>.json`; `._*` are macOS metadata sidecars. */
function isCheckpointName(name) {
  return name.endsWith('.json') && !name.startsWith('._');
}

// macOS bsdtar stores extended attributes as `._name` entries unless
// COPYFILE_DISABLE is set; GNU tar on Linux would extract those as plain
// files that are not JSON. Suppress them when creating and drop them when
// extracting so every `.json` in the directory is a real checkpoint.
function tar(args) {
  const result = spawnSync('tar', ['--exclude', '._*', ...args], {
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.status !== 0) throw new Error(`tar ${args[0]} failed`);
}

function withTemporaryFile(use) {
  const directory = mkdtempSync(join(tmpdir(), 'stations-checkpoints-'));
  try {
    return use(join(directory, 'stations-crawl.tar.gz'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function checkpointFiles() {
  if (!existsSync(CHECKPOINTS_DIR)) return [];
  return readdirSync(CHECKPOINTS_DIR).filter(isCheckpointName);
}

export function uploadCheckpoints({ log = console.log } = {}) {
  const files = checkpointFiles();
  if (files.length === 0) {
    log('No checkpoints in .cache/stations-crawl; nothing uploaded');
    return { uploaded: 0 };
  }
  const { bucket } = readWorkerConfig();
  withTemporaryFile(file => {
    tar(['-czf', file, '-C', CACHE_DIR, 'stations-crawl']);
    log(`Uploading ${files.length} checkpoints to ${bucket}/${CHECKPOINTS_KEY}`);
    const result = wrangler([
      'r2', 'object', 'put', `${bucket}/${CHECKPOINTS_KEY}`,
      '--file', file, '--content-type', 'application/gzip', '--remote',
    ]);
    if (result.status !== 0) throw new Error('wrangler r2 object put failed for crawl checkpoints');
  });
  return { uploaded: files.length };
}

export function restoreCheckpoints({ log = console.log } = {}) {
  const { bucket } = readWorkerConfig();
  return withTemporaryFile(file => {
    const result = wrangler(
      ['r2', 'object', 'get', `${bucket}/${CHECKPOINTS_KEY}`, '--file', file, '--remote'],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
    if (result.status !== 0) {
      if (isMissingObject(`${result.stdout}\n${result.stderr}`)) {
        log(`No checkpoints at ${bucket}/${CHECKPOINTS_KEY}; the crawl starts from scratch`);
        return { restored: 0 };
      }
      process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
      throw new Error('wrangler r2 object get failed for crawl checkpoints');
    }
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    tar(['-xzf', file, '-C', CACHE_DIR]);
    const files = checkpointFiles();
    log(`Restored ${files.length} checkpoints to .cache/stations-crawl`);
    return { restored: files.length };
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      restore: { type: 'boolean', default: false },
      upload: { type: 'boolean', default: false },
    },
  });
  if (values.restore === values.upload) throw new Error('Choose one of --restore or --upload');
  if (values.restore) restoreCheckpoints();
  else uploadCheckpoints();
}
