import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

async function setup() {
  const component = await readFile(new URL('../src/plugin.svelte', import.meta.url), 'utf8');
  const script = component.match(/<script lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^\s*import .*;$/gm, '')
    .replace(/^\s*\$: refreshing = .*;$/gm, '');
  const compiled = ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const frames = new Map();
  let frameId = 0;
  let mount;
  let onChange;
  let onSelect;
  let colorForSpeed;
  const listeners = new Map();
  const calls = { updates: [], viewports: 0, popup: [], focused: 0, cleared: 0, recolored: 0, colorSamples: [] };
  const document = { hidden: false, activeElement: null, addEventListener() {}, removeEventListener() {} };
  const window = {
    requestAnimationFrame(callback) { const id = frameId++; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setInterval() { return 1; }, clearInterval() {},
  };
  const marker = {
    update(...args) { calls.updates.push(args); }, viewportSettled() { calls.viewports++; },
    refreshColors() { calls.recolored++; },
    focus() {}, clear() { calls.cleared++; },
  };
  const popup = { update(...args) { calls.popup.push(args); }, close() {}, focus() { calls.focused++; }, destroy() {} };
  const bounds = { getWest: () => 0, getSouth: () => 0, getEast: () => 1, getNorth: () => 1 };
  const initial = { entries: [], selectedCount: 0 };
  const data = { getSnapshot: () => initial, setViewport() {}, suspend() {}, resume() {}, refresh() {}, destroy() {} };
  const context = vm.createContext({
    document, window, performance: { now: () => 1000 }, metrics: { wind: { metric: 'kt' } },
    map: { getBounds: () => bounds },
    colors: { wind: { colorDark(speed, amount) { calls.colorSamples.push([speed, amount]); return 'rgb(1, 2, 3)'; } } },
    broadcast: { on(event, callback) { listeners.set(event, callback); }, off(event, callback) { if (listeners.get(event) === callback) listeners.delete(event); } },
    onMount(fn) { mount = fn; }, createStationsClient() { return {}; },
    createWindyData(options) { onChange = options.onChange; return data; },
    createIndexedDbSnapshotStore() { return { load: () => null, save: () => {} }; },
    DEFAULT_MAX_CONCURRENT_REQUESTS: 4,
    createStationMarkers(map, select, color) { onSelect = select; colorForSpeed = color; return marker; },
    createStationPopup() { return popup; }, listenToViewport() { return () => {}; },
    process: { env: { STATIONS_API_BASE_URL: 'https://stations.invalid' } },
  });
  vm.runInContext(compiled, context);
  const destroy = mount();
  function flush() {
    const current = [...frames.values()];
    frames.clear();
    for (const callback of current) callback();
  }
  return { calls, context, destroy, document, frames, flush, listeners, colorForSpeed, onChange: next => onChange(next), onSelect: uid => onSelect(uid) };
}

test('host wind colors are injected and gradient redraw listener is removed on destroy', async () => {
  const fixture = await setup();
  assert.equal(fixture.colorForSpeed(2.5), 'rgb(1, 2, 3)');
  assert.deepEqual(fixture.calls.colorSamples, [[2.5, 20]]);
  fixture.listeners.get('redrawLayers')();
  assert.equal(fixture.calls.recolored, 1);
  fixture.destroy();
  assert.equal(fixture.listeners.has('redrawLayers'), false);
  assert.equal(fixture.listeners.has('metricChanged'), false);
});

test('snapshot, viewport, metric and selection emissions coalesce with latest data', async () => {
  const fixture = await setup();
  const { calls, context, frames, flush } = fixture;
  const first = { entries: [{ station: { uid: 'a' } }] };
  const latest = { entries: [{ station: { uid: 'b' } }] };
  fixture.onChange(first);
  fixture.onChange(latest);
  vm.runInContext('metricChanged(); viewportChanged(); viewportChanged()', context);
  fixture.document.activeElement = { classList: { contains: () => true } };
  fixture.onSelect('b');
  assert.equal(frames.size, 1);
  assert.equal(calls.updates.length, 0);
  flush();
  assert.equal(calls.updates.length, 1);
  assert.equal(calls.updates[0][0], latest.entries);
  assert.equal(calls.updates[0][3], 'b');
  assert.equal(calls.viewports, 1);
  assert.equal(calls.popup[0][0], latest.entries[0]);
  assert.equal(calls.focused, 1);
  fixture.destroy();
});

test('hidden, disabled and destroyed lifecycle cancels pending frames', async () => {
  const fixture = await setup();
  const { calls, context, document, frames, flush } = fixture;
  assert.equal(frames.size, 1);
  document.hidden = true;
  vm.runInContext('visibilityChanged()', context);
  assert.equal(frames.size, 0);
  fixture.onChange({ entries: [] });
  assert.equal(frames.size, 0);
  document.hidden = false;
  vm.runInContext('visibilityChanged()', context);
  assert.equal(frames.size, 1);
  vm.runInContext('enabled = false; visibilityChanged()', context);
  assert.equal(frames.size, 0);
  assert.equal(calls.cleared, 1);
  vm.runInContext('enabled = true; visibilityChanged()', context);
  assert.equal(frames.size, 1);
  fixture.destroy();
  assert.equal(frames.size, 0);
  fixture.onChange({ entries: [] });
  assert.equal(frames.size, 0);
  flush();
  assert.equal(calls.updates.length, 0);
});
