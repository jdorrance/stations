import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createStationPopup } from '../src/popup.ts';

class Element {
  children = [];
  attributes = {};
  listeners = new Map();
  mutations = 0;
  #textContent = '';
  #hidden = false;
  get textContent() { return this.#textContent; }
  set textContent(value) { this.mutations++; this.#textContent = value; }
  get hidden() { return this.#hidden; }
  set hidden(value) { this.mutations++; this.#hidden = value; }
  get href() { return this.attributes.href; }
  set href(value) { this.setAttribute('href', value); }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.mutations++; this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return name in this.attributes; }
  removeAttribute(name) { this.mutations++; delete this.attributes[name]; }
  focus(options) { this.focusOptions = options; }
  addEventListener(type, handler) { this.listeners.set(type, handler); }
  removeEventListener(type, handler) { if (this.listeners.get(type) === handler) this.listeners.delete(type); }
}

class Popup {
  static instances = [];
  listeners = new Map();
  constructor(options) { this.options = options; Popup.instances.push(this); }
  setContent(content) { this.content = content; return this; }
  setLatLng(position) { this.position = position; return this; }
  openOn(map) { this.map = map; map.layers.add(this); return this; }
  on(type, handler) { this.listeners.set(type, handler); return this; }
  off(type, handler) { if (this.listeners.get(type) === handler) this.listeners.delete(type); return this; }
  remove() { this.map?.layers.delete(this); this.listeners.get('remove')?.(); return this; }
}

const entry = {
  station: { uid: 's', name: '<img src=x>', vendor: 'Source', category: null, latitude: 10, longitude: 20, elevationM: 0, pageUrl: 'https://example.com/' },
  status: 'ok', refreshing: false,
  observation: { status: 'ok', sourceLabel: 'Source', pageUrl: null, elevationM: null, recommendedPollSeconds: 60, reading: { observedAt: '2026-10-26T12:00:00Z', windAvgMps: 2, windGustMps: 3, windDirectionDeg: 0, temperatureC: 0 } },
  unavailable: null, error: null, servedAt: '2026-10-26T12:00:30Z', receivedAtMs: 1000,
};
const metric = { convertValue: value => `${value} m/s` };

function setup(t) {
  const previous = { L: globalThis.L, document: globalThis.document };
  const listeners = new Map();
  globalThis.document = {
    createElement: () => new Element(),
    addEventListener: (type, handler, capture) => listeners.set(type, { handler, capture }),
    removeEventListener: (type, handler, capture) => { if (listeners.get(type)?.handler === handler && listeners.get(type).capture === capture) listeners.delete(type); },
  };
  globalThis.L = { popup: options => new Popup(options) };
  Popup.instances = [];
  t.after(() => { globalThis.L = previous.L; globalThis.document = previous.document; });
  return { map: { layers: new Set() }, listeners };
}

test('one popup moves and updates content in place, preserving its nodes and scroll', t => {
  const { map, listeners } = setup(t);
  const closed = [];
  const adapter = createStationPopup(map, restore => closed.push(restore));
  const popup = Popup.instances[0];
  assert.equal(popup.options.autoPan, false);
  assert.equal(popup.options.keepInView, false);
  assert.equal(popup.options.closeOnClick, false);
  adapter.update(entry, metric, 1000);
  assert.equal(map.layers.size, 1);
  assert.equal(listeners.get('keydown').capture, true);
  const root = popup.content;
  const [heading, source, wind, state, notice, rows, link] = root.children;
  assert.equal(heading.children[0].textContent, '<img src=x>');
  assert.equal(source.textContent, 'Station observation · Source');
  assert.equal(link.href, 'https://example.com/');
  adapter.focus();
  assert.deepEqual(heading.children[1].focusOptions, { preventScroll: true });
  const allElements = node => [node, ...node.children.flatMap(allElements)];
  const elements = allElements(root);
  for (const element of elements) element.mutations = 0;
  adapter.update(entry, metric, 1000);
  assert.equal(elements.reduce((total, element) => total + element.mutations, 0), 0);
  adapter.update(entry, metric, 61_000);
  assert.equal(state.mutations, 1);
  assert.equal(elements.reduce((total, element) => total + element.mutations, 0), 1);
  root.scrollTop = 42;
  adapter.update({ ...entry, refreshing: true, station: { ...entry.station, uid: 's2', latitude: 11, pageUrl: 'javascript:alert(1)' }, observation: { ...entry.observation, pageUrl: 'javascript:alert(1)' }, status: 'refresh-failed', error: { message: '<unsafe>' } }, metric, 61_000);
  assert.equal(Popup.instances.length, 1);
  assert.equal(popup.content, root);
  assert.equal(root.scrollTop, 42);
  assert.deepEqual(popup.position, [11, 20]);
  assert.equal(wind.textContent, '2 m/s · Gust 3 m/s');
  assert.match(state.textContent, /Refresh failed.*Refreshing/);
  assert.match(notice.textContent, /<unsafe>/);
  assert.match(notice.textContent, /retained observation/);
  assert.equal(link.hidden, true);
  assert.equal(rows.children[1].textContent, '2026-10-26T12:00:00Z');
  let stopped = false;
  root.listeners.get('wheel')({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true);
  let prevented = false;
  listeners.get('keydown').handler({ key: 'Escape', preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(prevented, true);
  assert.deepEqual(closed, [true]);
  assert.equal(map.layers.size, 0);
  assert.equal(listeners.size, 0);
  adapter.update(entry, metric, 1000);
  heading.children[1].listeners.get('click')();
  assert.deepEqual(closed, [true, true]);
  adapter.destroy();
  assert.equal(popup.listeners.size, 0);
  assert.equal(root.listeners.size, 0);
  assert.equal(heading.children[1].listeners.size, 0);
});

test('external removal deselects without restoring focus and destroy detaches listeners', t => {
  const { map, listeners } = setup(t);
  const closed = [];
  const adapter = createStationPopup(map, restore => closed.push(restore));
  const popup = Popup.instances[0];
  adapter.update(entry, metric, 1000);
  popup.remove();
  assert.deepEqual(closed, [false]);
  assert.equal(listeners.size, 0);
  adapter.update(entry, metric, 1000);
  adapter.destroy();
  assert.deepEqual(closed, [false, false]);
  assert.equal(map.layers.size, 0);
  assert.equal(listeners.size, 0);
});

test('popup styling overrides the host wrapper and tip only for station popups', async () => {
  const component = await readFile(new URL('../src/plugin.svelte', import.meta.url), 'utf8');
  assert.match(component, /:global\(\.stations-popup-content\)/);
  const shell = component.match(/(:global\(\.stations-popup \.leaflet-popup-content-wrapper\),\s*:global\(\.stations-popup \.leaflet-popup-tip\))\s*\{([^}]*)\}/);
  assert.ok(shell);
  assert.match(shell[2], /background:\s*rgba\(0,\s*0,\s*0,\s*\.88\)/);
  assert.match(shell[2], /border:\s*0/);
  assert.match(shell[2], /box-shadow:\s*none/);
  assert.match(component, /:global\(\.stations-popup \.leaflet-popup-content\)\s*\{\s*margin:\s*0/);
  assert.match(component, /:global\(\.stations-popup-content\)\s*\{[^}]*background:\s*transparent/);
  assert.match(component, /max-height:\s*min\(350px, 55vh\)/);
});

test('live Windy popup shell and tip render dark without affecting other popups', { skip: process.env.WINDY_POPUP_BROWSER !== '1' }, async () => {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const component = await readFile(new URL('../src/plugin.svelte', import.meta.url), 'utf8');
  const css = [...component.matchAll(/:global\(\.stations-popup[^{}]*\{[^{}]*\}/g)]
    .map(match => match[0].replace(/:global\(([^()]*)\)/g, '$1')).join('\n');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto('https://www.windy.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForFunction(() => typeof window.L?.popup === 'function');
    await page.addStyleTag({ content: css });
    const result = await page.evaluate(() => {
      function inspect(className) {
        const popup = window.L.popup({ className, closeButton: false });
        popup._initLayout();
        const container = popup.getElement();
        document.body.append(container);
        const wrapper = container.querySelector('.leaflet-popup-content-wrapper');
        const tip = container.querySelector('.leaflet-popup-tip');
        const content = container.querySelector('.leaflet-popup-content');
        const styles = element => ({ background: getComputedStyle(element).backgroundColor, shadow: getComputedStyle(element).boxShadow, border: getComputedStyle(element).borderTopWidth });
        return { classes: container.className, wrapper: styles(wrapper), tip: styles(tip), margin: getComputedStyle(content).margin };
      }
      return { station: inspect('stations-popup'), other: inspect('') };
    });
    assert.match(result.station.classes, /\bstations-popup\b/);
    for (const part of [result.station.wrapper, result.station.tip]) {
      assert.equal(part.background, 'rgba(0, 0, 0, 0.88)');
      assert.equal(part.shadow, 'none');
      assert.equal(part.border, '0px');
    }
    assert.equal(result.station.margin, '0px');
    assert.equal(result.other.wrapper.background, 'rgb(255, 255, 255)');
    assert.equal(result.other.tip.background, 'rgb(255, 255, 255)');
  } finally {
    await browser.close();
  }
});
