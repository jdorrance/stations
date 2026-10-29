import assert from 'node:assert/strict';
import test from 'node:test';
import { createStationMarkers, listenToViewport } from '../src/markers.ts';

class Element {
  attributes = {};
  listeners = new Map();
  children = [];
  style = {};
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
  appendChild(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
}

class FakeMap {
  layers = new Set();
  listeners = new Map();
  on(type, callback) { this.listeners.set(type, callback); }
  off(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
  fire(type) { this.listeners.get(type)?.(); }
}

class Marker {
  static instances = [];
  element = new Element();
  listeners = new Map();
  constructor(position, options) { this.position = position; this.options = options; Marker.instances.push(this); }
  addTo(map) { this.map = map; map.layers.add(this); return this; }
  on(type, callback) { this.listeners.set(type, callback); return this; }
  off(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); return this; }
  remove() { this.map.layers.delete(this); return this; }
  setLatLng(position) { this.position = position; return this; }
  getElement() { return this.element; }
  fire(type) { this.listeners.get(type)?.(); }
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

const entry = (uid, status = 'ok') => ({
  station: { uid, name: `<${uid}>`, vendor: 'windnerd', category: null, latitude: 10, longitude: 20, elevationM: null, pageUrl: null },
  status,
  observation: {
    status: 'ok', sourceLabel: 'Source', pageUrl: null, elevationM: null, recommendedPollSeconds: 60,
    reading: { observedAt: '2026-10-26T12:00:00Z', windAvgMps: 2, windGustMps: null, windDirectionDeg: 90, temperatureC: null },
  },
  unavailable: null, error: null, servedAt: '2026-10-26T12:00:30Z', receivedAtMs: 1000,
});
const knots = { convertValue: value => `${value * 2} kt` };
const metres = { convertValue: value => `${value} m/s` };

test('reconciles markers, updates units and detaches events on removal and reopen', t => {
  const map = setup(t);
  const selected = [];
  let overlay = createStationMarkers(map, uid => selected.push(uid));
  overlay.update([entry('a'), entry('b')], knots, 1000);
  assert.equal(map.layers.size, 2);
  const [a, b] = Marker.instances;
  assert.deepEqual(a.position, [10, 20]);
  assert.equal(a.options.keyboard, false);
  assert.equal(a.element.attributes.role, 'button');
  assert.equal(a.element.tabIndex, 0);
  assert.equal(a.element.attributes['aria-label'], '<a>: 4 kt, 90° from, Available, live');
  assert.equal(a.element.children[0].children[0].style.transform, 'rotate(90deg)');
  assert.equal(a.element.children[0].children[1].textContent, '4 kt');
  a.fire('click');
  let prevented = false;
  a.element.listeners.get('keydown')({ key: ' ', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.deepEqual(selected, ['a', 'a']);
  a.element.listeners.get('keydown')({ key: 'Enter', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(selected, ['a', 'a', 'a']);
  a.element.listeners.get('keydown')({ key: 'Escape', preventDefault() { assert.fail('unrelated key was handled'); }, stopPropagation() {} });
  assert.deepEqual(selected, ['a', 'a', 'a']);
  const moved = entry('a', 'refresh-failed');
  moved.station.latitude = 11;
  moved.station.longitude = 21;
  overlay.update([moved, entry('c')], metres, 1000);
  assert.equal(map.layers.size, 2);
  assert.equal(Marker.instances.length, 3);
  assert.ok(map.layers.has(a));
  assert.deepEqual(a.position, [11, 21]);
  assert.ok(!map.layers.has(b));
  assert.equal(b.listeners.size, 0);
  assert.equal(b.element.listeners.size, 0);
  assert.equal(a.element.children[0].children[1].textContent, '2 m/s');
  assert.match(a.element.children[0].className, /stations-marker-refresh-failed/);
  assert.equal(a.element.children[0].children[2].textContent, 'Refresh failed');
  overlay.clear();
  overlay.clear();
  assert.equal(map.layers.size, 0);
  assert.equal(a.listeners.size, 0);
  assert.equal(a.element.listeners.size, 0);
  overlay = createStationMarkers(map, uid => selected.push(uid));
  overlay.update([entry('a')], knots, 1000);
  assert.equal(map.layers.size, 1);
  Marker.instances.at(-1).fire('click');
  assert.deepEqual(selected, ['a', 'a', 'a', 'a']);
  overlay.clear();
  assert.equal(map.layers.size, 0);
});

test('registers and removes viewport listeners through close and reopen', t => {
  const map = setup(t);
  let changes = 0;
  const onChange = () => changes++;
  let stop = listenToViewport(map, onChange);
  assert.deepEqual([...map.listeners.keys()], ['moveend', 'zoomend']);
  map.fire('moveend');
  map.fire('zoomend');
  assert.equal(changes, 2);
  stop();
  assert.equal(map.listeners.size, 0);
  map.fire('moveend');
  assert.equal(changes, 2);
  stop = listenToViewport(map, onChange);
  map.fire('moveend');
  assert.equal(changes, 3);
  stop();
  assert.equal(map.listeners.size, 0);
});
