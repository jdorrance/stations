import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { root } from './workspace.mjs';

const require = createRequire(resolve(root, 'package.json'));
const esbuildPath = require.resolve('esbuild');
const { build } = await import(esbuildPath);

const outdir = resolve(root, 'web/dist');
rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const maplibreWorker = require.resolve('maplibre-gl/dist/maplibre-gl-worker.mjs');
cpSync(maplibreWorker, resolve(outdir, 'maplibre-gl-worker.js'));

await build({
  entryPoints: [
    resolve(root, 'web/app.ts'),
    resolve(root, 'web/styles.css'),
    resolve(root, 'web/xct.ts'),
    resolve(root, 'web/xct.css'),
  ],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  outdir,
  minify: true,
  sourcemap: false,
});

console.log('Built web explorer and XCTrack widget in web/dist');
