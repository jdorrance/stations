import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildOrder, filesIn, root, packages } from './workspace.mjs';

const tsc = resolve(root, 'node_modules/typescript/bin/tsc');
for (const { directory, manifest } of buildOrder(process.argv.slice(2))) {
  const dist = resolve(directory, 'dist');
  rmSync(dist, { recursive: true, force: true });
  const result = spawnSync(process.execPath, [tsc, '-p', resolve(directory, 'tsconfig.json')], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (manifest.name === '@stations/contracts' && existsSync(resolve(directory, 'scripts/build-schemas.mjs'))) {
    const schemas = spawnSync(process.execPath, [resolve(directory, 'scripts/build-schemas.mjs')], { stdio: 'inherit' });
    if (schemas.status !== 0) process.exit(schemas.status ?? 1);
  }
  for (const file of filesIn(resolve(directory, 'src'))) {
    if (/\.(?:[cm]?[jt]s|tsx)$/.test(file)) continue;
    const destination = resolve(dist, relative(resolve(directory, 'src'), file));
    cpSync(file, destination, { recursive: true });
  }
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = Object.fromEntries(filesIn(dist).sort().map(file => [relative(dist, file).replaceAll('\\', '/'), hash(readFileSync(file))]));
  const require = createRequire(resolve(directory, 'package.json'));
  const dependencies = {};
  for (const [name, declared] of Object.entries(manifest.dependencies ?? {})) {
    const local = packages.find(pkg => pkg.manifest.name === name);
    let version = local?.manifest.version;
    if (!version) {
      let at = dirname(require.resolve(name));
      while (at !== dirname(at)) {
        const candidate = resolve(at, 'package.json');
        if (existsSync(candidate)) {
          const dependency = JSON.parse(readFileSync(candidate, 'utf8'));
          if (dependency.name === name) { version = dependency.version; break; }
        }
        at = dirname(at);
      }
    }
    if (!version) throw new Error(`Cannot identify installed dependency ${name}`);
    dependencies[name] = { declared, version };
  }
  writeFileSync(resolve(dist, 'build-inventory.json'), `${JSON.stringify({ schemaVersion: 1, package: manifest.name, version: manifest.version, files, dependencies }, null, 2)}\n`);
  console.log(`Built ${manifest.name} (${Object.keys(files).length} files)`);
}
