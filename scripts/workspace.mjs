import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
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
