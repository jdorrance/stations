import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));

/** Runs the workspace's pinned wrangler CLI with the current process env. */
export function wrangler(args, options = {}) {
  const require = createRequire(resolve(root, 'package.json'));
  const manifestPath = require.resolve('wrangler/package.json');
  const bin = resolve(dirname(manifestPath), require(manifestPath).bin.wrangler);
  return spawnSync(process.execPath, [bin, ...args], { cwd: root, env: process.env, stdio: 'inherit', ...options });
}

export function loadDotEnv(path = resolve(root, '.env')) {
  if (!existsSync(path)) return;
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const rawVal = trimmed.slice(eq + 1).trim();
      const val = rawVal.replace(/^(['"])([\s\S]*)\1$/, '$2');
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore unreadable .env
  }
}

loadDotEnv();
export const packages = readdirSync(resolve(root, 'packages'), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => {
    const directory = resolve(root, 'packages', entry.name);
    return { directory, manifest: JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) };
  });

export function buildOrder(requested = []) {
  const catalogue = new Map(packages.map(pkg => [pkg.manifest.name, pkg]));
  const selected = new Set();
  const include = name => {
    if (selected.has(name)) return;
    const pkg = catalogue.get(name);
    if (!pkg) throw new Error(`Unknown workspace package: ${name}`);
    selected.add(name);
    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) {
      if (catalogue.has(dependency)) include(dependency);
    }
  };
  for (const name of requested.length ? requested : catalogue.keys()) include(name);
  const remaining = new Map([...catalogue].filter(([name]) => selected.has(name)));
  const ordered = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(pkg =>
      Object.keys(pkg.manifest.dependencies ?? {}).every(dependency => !remaining.has(dependency)));
    if (!ready.length) throw new Error(`Package dependency cycle: ${[...remaining.keys()].join(', ')}`);
    for (const pkg of ready) { ordered.push(pkg); remaining.delete(pkg.manifest.name); }
  }
  return ordered;
}

export function filesIn(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? filesIn(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
}
