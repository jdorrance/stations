import assert from 'node:assert/strict';
import test from 'node:test';
import { createStationMarkers as createMarkers, listenToViewport } from '../src/markers.ts';

const createStationMarkers = (map, onSelect, colorForSpeed = speed => `rgb(${speed}, 0, 0)`) => createMarkers(map, onSelect, colorForSpeed);

class Element {
  attributes = {};
  listeners = new Map();
  children = [];
  mutations = 0;
  style = new Proxy({}, { set: (object, key, value) => { this.mutations++; object[key] = value; return true; } });
  get className() { return this._className ?? ''; }
  set className(value) { this.mutations++; this._className = value; }
  get textContent() { return this._textContent ?? ''; }
  set textContent(value) { this.mutations++; this._textContent = value; }
  get title() { return this._title ?? ''; }
  set title(value) { this.mutations++; this._title = value; }
  get hidden() { return this._hidden ?? false; }
  set hidden(value) { this.mutations++; this._hidden = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  setAttribute(name, value) { this.mutations++; this.attributes[name] = value; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
  appendChild(child) { this.mutations++; this.children.push(child); child.parent = this; }
  getBoundingClientRect() {
    this.measurements = (this.measurements ?? 0) + 1;
    if (this.className.includes('stations-marker-dot')) return { width: 10, height: 10 };
    return { width: 8 + (this.children[0].hidden ? 0 : 12) + this.children[1].textContent.length * 7 + this.children[2].textContent.length * 5, height: 22 };
  }
  dispatch(type, event = {}) {
    event.stopPropagation = () => { event.stopped = true; };
    this.listeners.get(type)?.(event);
    if (!event.stopped) this.parent?.dispatch(type, event);
  }
  focus(options) { this.focusOptions = options; this.listeners.get('focus')?.(); }
  blur() { this.listeners.get('blur')?.(); }
  count() { return this.mutations + this.children.reduce((sum, child) => sum + child.count(), 0); }
}

class FakeMap {
  layers = new Set();
  listeners = new Map();
  center = { lat: 0, lng: 0 };
  size = { x: 400, y: 300 };
  projections = 0;
  element = new Element();
  on(type, callback) { this.listeners.set(type, callback); }
  off(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
  fire(type) { this.listeners.get(type)?.(); }
  getSize() { return this.size; }
  getCenter() { return this.center; }
  getZoom() { return 5; }
  getBounds() { return { getWest: () => -180, getEast: () => 180, getNorth: () => 90, getSouth: () => -90 }; }
  latLngToContainerPoint([lat, lng]) { this.projections++; return { x: lng - this.center.lng, y: lat - this.center.lat }; }
}

class Marker {
  static instances = [];
  element = new Element();
  listeners = new Map();
  constructor(position, options) { this.position = position; this.options = options; Marker.instances.push(this); }
  addTo(map) { this.map = map; this.element.parent = map.element; map.layers.add(this); return this; }
  on(type, callback) { this.listeners.set(type, callback); return this; }
  off(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); return this; }
  remove() { this.map.layers.delete(this); return this; }
  setLatLng(position) { this.position = position; return this; }
  setZIndexOffset(offset) { this.zIndexOffset = offset; return this; }
  getElement() { return this.element; }
  fire(type) { this.element.dispatch(type); }
}

function setup(t) {
  const previousL = globalThis.L;
  const previousDocument = globalThis.document;
  globalThis.L = { Marker, divIcon: options => options };
  globalThis.document = { createElement: () => new Element() };
  Marker.instances = [];
  t.after(() => { globalThis.L = previousL; globalThis.document = previousDocument; });
  return new FakeMap();
}

const entry = (uid, x = 100, y = 100) => ({
  station: { uid, name: `<${uid}>`, vendor: 'windnerd', category: null, latitude: y, longitude: x, elevationM: null, pageUrl: null },
  status: 'ok', observation: {
    status: 'ok', sourceLabel: 'Source', pageUrl: null, elevationM: null, recommendedPollSeconds: 60,
    reading: { observedAt: '2026-10-26T12:00:00Z', windAvgMps: 2, windGustMps: null, windDirectionDeg: 90, temperatureC: null },
  },
  unavailable: null, error: null, servedAt: '2026-10-26T12:00:30Z', receivedAtMs: 1000,
});
const knots = { metric: 'kt', convertNumber: value => value * 2, convertValue: value => `${value * 2} kt` };
const metres = { metric: 'm/s', convertNumber: value => value, convertValue: value => `${value} m/s` };
const isDot = marker => marker.element.children[0].className.includes('stations-marker-dot');

test('preserves marker and child identity without mutating unchanged stations', t => {
  const map = setup(t);
  const overlay = createStationMarkers(map, () => {});
  const a = entry('a');
  const b = entry('b', 200);
  overlay.update([a, b], knots, 1000);
  const [first, second] = Marker.instances;
  const [label] = first.element.children;
  const children = [...label.children];
  const counts = [first.element.count(), second.element.count()];
  const projections = map.projections;
  overlay.update([b, a], knots, 1000);
  assert.equal(first.element.children[0], label);
  assert.deepEqual(label.children, children);
  assert.deepEqual([first.element.count(), second.element.count()], counts);
  assert.equal(map.projections, projections);
  const changed = entry('a');
  changed.observation.reading.windAvgMps = 4;
  overlay.update([changed, b], knots, 1000);
  assert.equal(children[1].textContent, '8');
  assert.equal(second.element.count(), counts[1]);
  assert.equal(map.projections, projections);
  overlay.update([changed, b], metres, 61_000);
  assert.equal(children[1].textContent, '4');
  assert.equal(map.projections, projections);
  assert.match(first.element.attributes['aria-label'], /1 min ago/);
  overlay.clear();
});

test('declutters by selection, focus, fresh reading and stable uid; dots remain selectable', t => {
  const map = setup(t);
  const selected = [];
  const overlay = createStationMarkers(map, uid => selected.push(uid));
  const a = entry('a');
  const b = entry('b', 105);
  const c = entry('c', 110);
  c.status = 'loading';
  c.observation = null;
  overlay.update([b, c, a], knots, 1000);
  const [bm, cm, am] = Marker.instances;
  assert.equal(isDot(am), false);
  assert.equal(isDot(bm), true);
  assert.equal(isDot(cm), true);
  assert.equal(am.zIndexOffset, 0);
  assert.equal(bm.zIndexOffset, 100);
  assert.equal(bm.element.style.width, '18px');
  assert.equal(bm.element.style.marginLeft, '-9px');
  bm.fire('click');
  bm.element.listeners.get('keydown')({ key: ' ', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(selected, ['b', 'b']);
  overlay.focus('b');
  assert.deepEqual(bm.element.focusOptions, { preventScroll: true });
  assert.equal(isDot(bm), false);
  assert.equal(isDot(am), true);
  assert.equal(bm.zIndexOffset, 200);
  assert.equal(am.zIndexOffset, 100);
  overlay.update([a, b, c], knots, 1000, 'a');
  assert.equal(isDot(am), false);
  assert.equal(isDot(bm), true);
  assert.equal(am.zIndexOffset, 300);
  assert.equal(bm.zIndexOffset, 200);
  assert.match(am.element.children[0].className, /stations-marker-selected/);
  bm.element.blur();
  overlay.clear();
});

test('uses screen coordinates, clips labels, and ignores duplicate settled viewports', t => {
  const map = setup(t);
  const overlay = createStationMarkers(map, () => {});
  const a = entry('a', 5, 100);
  const b = entry('b', 100, 100);
  overlay.update([a, b], knots, 1000);
  const [am, bm] = Marker.instances;
  assert.equal(isDot(am), true);
  assert.equal(isDot(bm), false);
  overlay.viewportSettled();
  const projected = map.projections;
  overlay.viewportSettled();
  assert.equal(map.projections, projected);
  map.center.lng = -20;
  overlay.viewportSettled();
  assert.equal(isDot(am), false);
  assert.equal(map.projections, projected + 2);
  const moved = entry('b', 25, 100);
  overlay.update([a, moved], knots, 1000);
  assert.deepEqual(bm.position, [100, 25]);
  assert.equal(isDot(bm), true);
  overlay.clear();
});

test('prioritizes live readings and retains a fresh reading after a failed refresh', t => {
  const map = setup(t);
  const overlay = createStationMarkers(map, () => {});
  const a = entry('a');
  a.servedAt = '2026-10-26T12:20:00Z';
  const b = entry('b', 105);
  overlay.update([a, b], knots, 1000);
  const [am, bm] = Marker.instances;
  assert.equal(isDot(am), true);
  assert.equal(isDot(bm), false);
  const projections = map.projections;
  const measurements = bm.element.children[0].measurements;
  b.status = 'refresh-failed';
  overlay.update([a, b], knots, 1000);
  assert.equal(bm.element.children[0].measurements, measurements + 1);
  assert.equal(map.projections, projections + 2);
  assert.equal(isDot(bm), false);
  assert.equal(bm.element.children[0].children[2].textContent, '!');
  assert.match(bm.element.children[0].className, /stations-marker-refresh-failed/);
  overlay.update([a, b], knots, 901_000);
  assert.equal(isDot(bm), true);
  overlay.clear();
});

test('retains reading on failure, handles zero and removes listeners on removal and clear', t => {
  const map = setup(t);
  const selected = [];
  const overlay = createStationMarkers(map, uid => selected.push(uid));
  const a = entry('a');
  a.observation.reading.windAvgMps = 0;
  a.observation.reading.windDirectionDeg = 0;
  a.status = 'refresh-failed';
  const b = entry('b', 200);
  b.status = 'unavailable';
  b.observation = null;
  overlay.update([a, b], knots, 1000);
  const [am, bm] = Marker.instances;
  assert.equal(isDot(am), false);
  assert.equal(isDot(bm), true);
  assert.equal(am.element.children[0].children[1].textContent, '0');
  assert.equal(am.element.children[0].children[0].style.transform, 'rotate(0deg)');
  assert.equal(am.element.children[0].children[2].textContent, '!');
  assert.match(am.element.attributes['aria-label'], /Refresh failed/);
  am.element.listeners.get('keydown')({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(selected, ['a']);
  overlay.update([b], knots, 1000);
  assert.equal(am.listeners.size, 0);
  assert.equal(am.element.listeners.size, 0);
  assert.equal(map.layers.size, 1);
  overlay.clear();
  overlay.clear();
  assert.equal(bm.listeners.size, 0);
  assert.equal(bm.element.listeners.size, 0);
  assert.equal(map.layers.size, 0);
});

test('registers and removes viewport listeners through close and reopen', t => {
  const map = setup(t);
  let changes = 0;
  const onChange = () => changes++;
  let stop = listenToViewport(map, onChange);
  map.fire('moveend');
  map.fire('zoomend');
  assert.equal(changes, 2);
  stop();
  assert.equal(map.listeners.size, 0);
  stop = listenToViewport(map, onChange);
  map.fire('moveend');
  assert.equal(changes, 3);
  stop();
  assert.equal(map.listeners.size, 0);
});

test('only marker activation click stops propagation to the native picker', t => {
  const map = setup(t);
  let picker = 0;
  const selected = [];
  map.element.addEventListener('click', () => picker++);
  const overlay = createStationMarkers(map, uid => selected.push(uid));
  overlay.update([entry('a')], knots, 1000);
  const marker = Marker.instances[0];
  assert.equal(marker.options.bubblingMouseEvents, false);
  marker.element.children[0].children[1].dispatch('click');
  assert.deepEqual(selected, ['a']);
  assert.equal(picker, 0);
  map.element.dispatch('click');
  assert.equal(picker, 1);
  let pan = 0;
  map.element.addEventListener('pointerdown', () => pan++);
  marker.element.dispatch('pointerdown');
  assert.equal(pan, 1);
  overlay.clear();
  assert.equal(marker.element.listeners.has('click'), false);
});

test('measures full numeric text only on content-size changes, including mutable metric units', t => {
  const map = setup(t);
  const overlay = createStationMarkers(map, () => {});
  const a = entry('a');
  const b = entry('b', 145);
  const metric = { metric: 'kt', convertNumber: value => value, convertValue: value => `${value} ${metric.metric}` };
  overlay.update([a, b], metric, 1000);
  const [am, bm] = Marker.instances;
  assert.equal(isDot(bm), false);
  const label = am.element.children[0];
  const measurements = (label.measurements ?? 0) + (bm.element.children[0].measurements ?? 0);
  const projections = map.projections;
  overlay.update([a, b], metric, 61_000);
  assert.equal(map.projections, projections);
  assert.equal((label.measurements ?? 0) + (bm.element.children[0].measurements ?? 0), measurements);
  metric.metric = 'km/h';
  metric.convertNumber = () => 123456;
  overlay.update([a, b], metric, 61_000);
  assert.equal(label.children[1].textContent, '123456');
  assert.match(am.element.attributes['aria-label'], /2 km\/h/);
  assert.equal(isDot(bm), true);
  assert.ok(map.projections > projections);
  overlay.clear();
});

test('delegates every displayed physical speed to the host and preserves unknown direction', t => {
  const map = setup(t);
  const samples = [];
  const overlay = createStationMarkers(map, () => {}, speed => { samples.push(speed); return `rgb(${speed}, 0, 0)`; });
  const values = [0, 1.99, 2, 4.99, 5, 9.99, 10, 14.99, 15];
  const entries = values.map((speed, i) => {
    const item = entry(String(i), 40 + i * 38);
    item.observation.reading.windAvgMps = speed;
    if (!i) item.observation.reading.windDirectionDeg = null;
    return item;
  });
  const beaufort = { metric: 'bft', convertNumber: value => Math.floor(Math.sqrt(value)), convertValue: value => `Bft ${Math.floor(Math.sqrt(value))}` };
  overlay.update(entries, beaufort, 1000);
  const displayed = Marker.instances.map((marker, i) => isDot(marker) ? null : values[i]).filter(value => value !== null);
  assert.ok(displayed.includes(0));
  assert.ok(displayed.includes(15));
  for (const speed of displayed) assert.ok(samples.includes(speed));
  for (const [i, marker] of Marker.instances.entries()) {
    assert.doesNotMatch(marker.element.children[0].className, /stations-marker-speed-/);
    if (!isDot(marker)) assert.equal(marker.element.children[0].style.backgroundColor, `rgb(${values[i]}, 0, 0)`);
  }
  assert.equal(Marker.instances[0].element.children[0].children[1].textContent, '0');
  assert.equal(Marker.instances[0].element.children[0].children[0].hidden, true);
  assert.equal(Marker.instances[0].element.children[0].children[0].textContent, '"');
  assert.match(Marker.instances[0].element.attributes['aria-label'], /Bft 0, Not reported/);
  overlay.update(entries, knots, 1000);
  assert.equal(Marker.instances[8].element.children[0].style.backgroundColor, 'rgb(15, 0, 0)');
  overlay.clear();
});

test('rounds converted badge values and refreshes only changed gradient colors', t => {
  const map = setup(t);
  let gradient = 'initial';
  const calls = [];
  const overlay = createStationMarkers(map, () => {}, speed => { calls.push([speed, gradient]); return `${gradient}-${speed}`; });
  const a = entry('a');
  a.observation.reading.windAvgMps = 2.49;
  const b = entry('b', 200);
  b.observation.reading.windAvgMps = 2.5;
  const unavailable = entry('c', 300);
  unavailable.status = 'unavailable';
  unavailable.observation = null;
  overlay.update([a, b, unavailable], metres, 1000);
  const [am, bm, cm] = Marker.instances;
  assert.equal(am.element.children[0].children[1].textContent, '2');
  assert.equal(bm.element.children[0].children[1].textContent, '3');
  assert.equal(am.element.children[0].style.backgroundColor, 'initial-2.49');
  assert.equal(cm.element.children[0].style.backgroundColor, undefined);
  const counts = Marker.instances.map(marker => marker.element.count());
  const projections = map.projections;
  overlay.refreshColors();
  assert.deepEqual(Marker.instances.map(marker => marker.element.count()), counts);
  gradient = 'custom';
  overlay.refreshColors();
  assert.equal(am.element.children[0].style.backgroundColor, 'custom-2.49');
  assert.equal(bm.element.children[0].style.backgroundColor, 'custom-2.5');
  assert.equal(cm.element.count(), counts[2]);
  assert.equal(map.projections, projections);
  assert.ok(calls.some(([speed, version]) => speed === 2.49 && version === 'custom'));
  b.status = 'refresh-failed';
  overlay.update([a, b, unavailable], metres, 1000);
  assert.equal(bm.element.children[0].style.backgroundColor, 'custom-2.5');
  assert.equal(bm.element.children[0].children[2].textContent, '!');
  overlay.clear();
});
