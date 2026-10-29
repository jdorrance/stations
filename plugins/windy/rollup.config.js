import { builtinModules } from 'node:module';
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import serve from 'rollup-plugin-serve';
import rollupSvelte from 'rollup-plugin-svelte';
import rollupSwc from 'rollup-plugin-swc3';
import sveltePreprocess from 'svelte-preprocess';
import { transformCodeToESMPlugin, keyPEM, certificatePEM } from '@windycom/plugin-devtools';

function stationsApiBaseUrl() {
  const raw = process.env.STATIONS_API_BASE_URL;
  if (!raw) throw new Error('STATIONS_API_BASE_URL is required for the Windy plugin build');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('STATIONS_API_BASE_URL must be a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('STATIONS_API_BASE_URL must use HTTPS');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('STATIONS_API_BASE_URL must not contain credentials, a query, or a fragment');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const apiBaseUrl = stationsApiBaseUrl();

const nodeBuiltins = new Set(builtinModules);

function assertBrowserSafeBundle() {
  return {
    name: 'assert-browser-safe-bundle',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        const ast = this.parse(output.code);
        if (ast.body.some(node => node.type === 'ImportDeclaration' && node.source.value.startsWith('@windy/')) || output.dynamicImports.some(id => id.startsWith('@windy/'))) {
          throw new Error(`Unresolved Windy import in ${output.fileName}`);
        }
        for (const id of Object.keys(output.modules)) {
          if (id.includes('/packages/providers/') || id.includes('/@stations/providers/')) {
            throw new Error(`Provider implementation in ${output.fileName}`);
          }
        }
        for (const id of [...output.imports, ...output.dynamicImports]) {
          if (id.startsWith('node:') || nodeBuiltins.has(id.split('/')[0])) {
            throw new Error(`Server dependency ${id} in ${output.fileName}`);
          }
        }
      }
    },
  };
}

export default {
  input: 'src/plugin.svelte',
  output: [
    {
      file: 'dist/plugin.js',
      format: 'module',
      sourcemap: true,
    },
    {
      file: 'dist/plugin.min.js',
      format: 'module',
      plugins: [terser()],
    },
  ],
  onwarn(warning, warn) {
    if (['UNRESOLVED_IMPORT', 'MISSING_EXPORT', 'MISSING_GLOBAL_NAME'].includes(warning.code)) {
      throw new Error(warning.message);
    }
    warn(warning);
  },
  external: id => id.startsWith('@windy/'),
  watch: {
    include: ['src/**'],
    exclude: 'node_modules/**',
    clearScreen: false,
  },
  plugins: [
    rollupSvelte({
      emitCss: false,
      preprocess: sveltePreprocess({ sourceMap: true }),
    }),
    rollupSwc({
      include: ['**/*.ts', '**/*.svelte'],
      sourceMaps: true,
    }),
    replace({
      preventAssignment: true,
      values: {
        'process.env.STATIONS_API_BASE_URL': JSON.stringify(apiBaseUrl),
      },
    }),
    resolve({
      browser: true,
      mainFields: ['module', 'jsnext:main', 'main'],
      preferBuiltins: false,
      dedupe: ['svelte'],
    }),
    commonjs(),
    transformCodeToESMPlugin(),
    assertBrowserSafeBundle(),
    process.env.SERVE !== 'false' &&
      serve({
        contentBase: 'dist',
        host: 'localhost',
        port: 9999,
        headers: {
          'Access-Control-Allow-Origin': '*',
        },
        https: {
          key: keyPEM,
          cert: certificatePEM,
        },
      }),
  ],
};
