/**
 * Mirrors the provider secrets from the current environment (GitHub Actions
 * secrets in the deploy workflow) onto the Cloudflare Worker.
 *
 * Inputs: the names in `deploy/worker/credentials.ts`, read from `process.env`,
 * plus Wrangler authentication (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)
 * and the Worker name from `wrangler.json`.
 * Effect: one atomic `wrangler secret bulk` that sets every non-empty name and
 * removes names that are empty here but still present on the Worker, so the
 * environment that runs this script is the only place secrets are edited.
 *
 * Usage: node scripts/sync-worker-secrets.mjs [--dry-run]
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PROVIDER_SECRET_NAMES } from '../deploy/worker/credentials.ts';
import { wrangler } from './workspace.mjs';

/** Decides the merge patch for `wrangler secret bulk`; `null` removes a secret. */
export function planWorkerSecrets(names, env, existing) {
  const patch = {};
  const set = [];
  const removed = [];
  const absent = [];
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      patch[name] = value;
      set.push(name);
    } else if (existing.includes(name)) {
      patch[name] = null;
      removed.push(name);
    } else {
      absent.push(name);
    }
  }
  return { patch, set, removed, absent };
}

function runWrangler(args, input) {
  return wrangler(args, { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
}

function listWorkerSecrets() {
  const result = runWrangler(['secret', 'list', '--format', 'json']);
  if (result.status !== 0) {
    throw new Error('wrangler secret list failed; deploy the Worker before syncing its secrets');
  }
  return JSON.parse(result.stdout).map(secret => secret.name);
}

export function syncWorkerSecrets({ dryRun = false, env = process.env, log = console.log } = {}) {
  const existing = dryRun ? [] : listWorkerSecrets();
  const plan = planWorkerSecrets(PROVIDER_SECRET_NAMES, env, existing);
  const describe = names => (names.length ? names.join(', ') : 'none');
  log(`Set:     ${describe(plan.set)}`);
  log(`Remove:  ${describe(plan.removed)}`);
  log(`Not set: ${describe(plan.absent)} (those networks stay not_configured)`);
  if (dryRun) {
    log('Dry run: no changes applied.');
    return plan;
  }
  if (Object.keys(plan.patch).length === 0) {
    log('Nothing to sync.');
    return plan;
  }
  const result = runWrangler(['secret', 'bulk'], JSON.stringify(plan.patch));
  if (result.stdout) log(result.stdout.trimEnd());
  if (result.status !== 0) throw new Error('wrangler secret bulk failed');
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
  syncWorkerSecrets({ dryRun: values['dry-run'] });
}
