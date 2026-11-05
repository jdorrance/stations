import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAst } from 'rollup/parseAst';

let generation = 0;
async function configFor(value) {
  const previousUrl = process.env.STATIONS_API_BASE_URL;
  const previousServe = process.env.SERVE;
  if (value === undefined) delete process.env.STATIONS_API_BASE_URL;
  else process.env.STATIONS_API_BASE_URL = value;
  process.env.SERVE = 'false';
  try {
    return (await import(`../rollup.config.js?test=${generation++}`)).default;
  } finally {
    if (previousUrl === undefined) delete process.env.STATIONS_API_BASE_URL;
    else process.env.STATIONS_API_BASE_URL = previousUrl;
    if (previousServe === undefined) delete process.env.SERVE;
    else process.env.SERVE = previousServe;
  }
}

test('build requires a credential-free HTTPS API base', async () => {
  for (const value of [undefined, '', 'not a url', 'http://localhost:4331/api/stations', 'https://user:pass@example.test/api', 'https://example.test/api?token=demo', 'https://example.test/api#fragment']) {
    await assert.rejects(configFor(value), /STATIONS_API_BASE_URL/);
  }
  const config = await configFor('https://example.test/api/stations/');
  assert.equal(config.input, 'src/plugin.svelte');
  assert.equal(config.external('@windy/map'), true);
  assert.equal(config.external('@stations/providers'), false);
});

test('bundle guard ignores transformed-import comments but rejects actual unresolved imports and server dependencies', async () => {
  const config = await configFor('https://example.test/api/stations');
  const guard = config.plugins.find(plugin => plugin?.name === 'assert-browser-safe-bundle');
  const chunk = { type: 'chunk', fileName: 'plugin.js', code: '// import { map } from "@windy/map";\nconst map = W.map;', imports: [], dynamicImports: [], modules: {} };
  const check = patch => guard.generateBundle.call({ parse: parseAst }, {}, { 'plugin.js': { ...chunk, ...patch } });
  assert.doesNotThrow(() => check({}));
  assert.throws(() => check({ code: 'import { map } from "@windy/map";' }), /Unresolved Windy import/);
  assert.throws(() => check({ dynamicImports: ['@windy/map'] }), /Unresolved Windy import/);
  assert.throws(() => check({ imports: ['node:fs'] }), /Server dependency/);
  assert.throws(() => check({ imports: ['worker_threads'] }), /Server dependency/);
  assert.throws(() => check({ modules: { '/repo/packages/providers/dist/index.js': {} } }), /Provider implementation/);
  assert.throws(() => config.onwarn({ code: 'UNRESOLVED_IMPORT', message: 'missing module' }, () => {}), /missing module/);
});
