import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { root, packages } from './workspace.mjs';

const pnpm = process.env.STATIONS_PNPM_CLI ?? process.env.npm_execpath;
if (!pnpm || !/pnpm/.test(pnpm)) throw new Error('Run with pnpm test:consumer (or set STATIONS_PNPM_CLI).');
const temporary = mkdtempSync(join(tmpdir(), 'stations-consumer-'));
const run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`Consumer command failed (${result.status}): ${command} ${args.join(' ')}`);
};

try {
  const tarballs = join(temporary, 'tarballs');
  mkdirSync(tarballs);
  for (const pkg of packages) run(pnpm, ['pack', '--pack-destination', tarballs], pkg.directory);
  const dependencies = Object.fromEntries(packages.map(pkg => {
    const archive = `${pkg.manifest.name.replace('@', '').replace('/', '-')}-${pkg.manifest.version}.tgz`;
    if (!readdirSync(tarballs).includes(archive)) throw new Error(`Missing package archive ${archive}`);
    return [pkg.manifest.name, `file:${join(tarballs, archive)}`];
  }));
  const consumer = join(temporary, 'app');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({
    name: 'independent-stations-consumer',
    private: true,
    type: 'module',
    dependencies,
    pnpm: { overrides: dependencies },
  }, null, 2));
  run(pnpm, ['install', '--prefer-offline', '--ignore-scripts', '--config.manage-package-manager-versions=false'], consumer);
  for (const file of ['run.mts', 'contracts.mts']) {
    cpSync(join(root, 'scripts/fixtures/consumer', file), join(consumer, file));
  }
  const typeImports = packages.flatMap(pkg => Object.entries(pkg.manifest.exports)
    .filter(([, target]) => typeof target === 'object' && target.types)
    .map(([entry]) => pkg.manifest.name + (entry === '.' ? '' : entry.slice(1))));
  writeFileSync(join(consumer, 'entries.mts'), typeImports.map((entry, i) => `import type * as Entry${i} from '${entry}';`).join('\n'));
  writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: false,
      outDir: 'compiled',
      types: ['node'],
      typeRoots: [join(root, 'node_modules/@types')],
    },
    files: ['entries.mts', 'contracts.mts', 'run.mts'],
  }, null, 2));
  run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')], consumer);
  console.log(`Public API checks passed (${typeImports.length} entry points).`);
  run(process.execPath, [join(consumer, 'compiled/run.mjs')], consumer);

  const require = createRequire(join(root, 'package.json'));
  const esbuildPath = require.resolve('esbuild');
  const { build } = await import(esbuildPath);
  const browserEntry = join(consumer, 'browser.mjs');
  const browserEntries = {
    geography: '@stations/geography',
    regions: '@stations/geography/regions',
    spatialIndex: '@stations/geography/spatial-index',
    contracts: '@stations/contracts',
    catalogue: '@stations/contracts/catalogue',
    geojson: '@stations/contracts/geojson',
    client: '@stations/client',
  };
  writeFileSync(browserEntry, Object.entries(browserEntries)
    .map(([name, entry]) => `export * as ${name} from '${entry}';`)
    .join('\n'));
  const bundle = await build({
    entryPoints: [browserEntry],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    outdir: join(consumer, 'bundle'),
    write: false,
    metafile: true,
  });
  const forbidden = Object.keys(bundle.metafile.inputs).filter(path =>
    /(?:@stations\/providers|meteo\.station\/dist\/server)/.test(path));
  if (forbidden.length) throw new Error(`Server modules in browser bundle: ${forbidden.join(', ')}`);
  console.log(`Browser bundle checked (${bundle.outputFiles.reduce((total, file) => total + file.contents.length, 0)} bytes before minification).`);
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
