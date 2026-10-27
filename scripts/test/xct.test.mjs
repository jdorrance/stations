/**
 * Execute the shipped widget against its HTTP and browser boundaries.
 * The small DOM below covers content, focus and events, not layout or paint;
 * geometry and contrast still need a browser/device check.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { STATION_SCHEMA_VERSION, parseStationFeedJson, parseStationCatalogueJson } from '@stations/contracts';
import { root } from '../workspace.mjs';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const compiled = await build({
  entryPoints: [resolve(root, 'web/xct.ts')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2022'],
  write: false,
});
const widgetSource = compiled.outputFiles[0].text;
const widgetHtml = readFileSync(resolve(root, 'web/xct.html'), 'utf8');

function station(overrides = {}) {
  return {
    id: 'holfuy:1', name: 'Test ridge with a long station name', sourceLabel: 'Holfuy',
    pageUrl: null, latitude: 40.34, longitude: 44.73, timeZone: null, elevationM: 1100,
    capabilities: { gustLull: true, temperature: false, conditions: false, history: false },
    samplingWindowSeconds: 60, recommendedPollSeconds: 60, status: 'ok',
    reading: {
      observedAt: new Date(NOW - 60_000).toISOString(), windAvgMps: 3,
      windDirectionDeg: 0, windGustMps: 4, windLullMps: null,
      temperatureC: null, windChillC: null, conditions: null,
    },
    history: null, ...overrides,
  };
}

function feed(stations, servedAt = NOW) {
  const value = {
    schemaVersion: STATION_SCHEMA_VERSION, servedAt: new Date(servedAt).toISOString(),
    primaryStationId: stations[0]?.id ?? null, stations,
  };
  assert.ok(parseStationFeedJson(JSON.stringify(value)), 'fixture must satisfy the real feed contract');
  return value;
}

function catalogue(stations) {
  const value = {
    schemaVersion: 1, generatedAt: new Date(NOW).toISOString(), regions: ['AM'],
    stations: stations.map(item => ({
      uid: item.id, vendor: item.id.split(':')[0], nativeId: item.id.split(':')[1],
      name: item.name, latitude: item.latitude, longitude: item.longitude,
      elevationM: item.elevationM, country: 'AM', region: null, timeZone: item.timeZone,
      pageUrl: item.pageUrl, capabilities: item.capabilities,
      samplingWindowSeconds: item.samplingWindowSeconds,
      recommendedPollSeconds: item.recommendedPollSeconds,
      category: 'freeflight', locator: {},
    })),
  };
  assert.ok(parseStationCatalogueJson(JSON.stringify(value)), 'fixture must satisfy the real catalogue contract');
  return value;
}

const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) =>
  ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]);

class Element {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.hidden = false;
    this.listeners = new Map();
    this.style = { setProperty() {}, removeProperty() {} };
    this.className = '';
    this.title = '';
    this.clientHeight = 500;
    this.scrollHeight = 500;
    this.scrollTop = 0;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const add = force ?? !this.classList.contains(name);
        this.classList[add ? 'add' : 'remove'](name);
        return add;
      },
    };
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
    if (name === 'hidden') this.hidden = true;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'hidden') this.hidden = false; }
  appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; return child; }
  insertBefore(child, next) {
    if (!next) return this.appendChild(child);
    child.remove();
    const index = this.children.indexOf(next);
    assert.notEqual(index, -1, 'insertBefore target is a child');
    this.children.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }
  get firstElementChild() { return this.children.find(child => child.tagName !== '#TEXT') ?? null; }
  get nextElementSibling() {
    const siblings = this.parentNode?.children ?? [];
    return siblings.slice(siblings.indexOf(this) + 1).find(child => child.tagName !== '#TEXT') ?? null;
  }
  get isConnected() { return this === this.ownerDocument || (this.parentNode?.isConnected ?? false); }
  append(...children) { for (const child of children) this.appendChild(child); }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  replaceChildren(...children) { for (const child of [...this.children]) child.remove(); this.append(...children); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  get textContent() { return (this._text ?? '') + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { this._text = ''; this.replaceChildren(); parseHtml(String(value), this); }
  get innerHTML() { return this.children.map(child => child.outerHTML).join(''); }
  get outerHTML() { return `<${this.tagName.toLowerCase()} class="${this.className}">${this.textContent}</${this.tagName.toLowerCase()}>`; }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const attribute = selector.match(/^\[([^=\]]+)(?:="?([^"\]]+)"?)?\]$/);
    if (attribute) return attribute[2] === undefined ? this.attributes.has(attribute[1]) : this.getAttribute(attribute[1]) === attribute[2];
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }
  querySelectorAll(selector) {
    const results = [];
    const visit = node => {
      for (const child of node.children) {
        if (selector.split(',').some(part => child.matches(part.trim()))) results.push(child);
        visit(child);
      }
    };
    visit(this);
    return results;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { return this.matches(selector) ? this : this.parentNode?.closest(selector) ?? null; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
  dispatchEvent(event) {
    event.target ??= this;
    event.preventDefault ??= () => {};
    event.stopPropagation ??= () => { event.stopped = true; };
    event.currentTarget = this;
    for (const callback of this.listeners.get(event.type) ?? []) callback(event);
    this[`on${event.type}`]?.(event);
    if (!event.stopped) this.parentNode?.dispatchEvent(event);
    return true;
  }
  click() { this.dispatchEvent({ type: 'click' }); }
  focus() { this.ownerDocument.activeElement = this; }
  getBoundingClientRect() { return { top: 0, bottom: 84, width: 80, height: 84 }; }
}

function parseHtml(html, parent) {
  const stack = [parent];
  for (const token of html.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? []) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/)?.[1];
      if (!tag) continue;
      const element = new Element(tag, parent.ownerDocument);
      const attributes = token.slice(tag.length + 1, -1);
      for (const match of attributes.matchAll(/([^\s=/>]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g)) {
        element.setAttribute(match[1], decode(match[2] ?? match[3] ?? match[4] ?? ''));
      }
      stack.at(-1).appendChild(element);
      if (!/\/>$/.test(token) && !['meta', 'link', 'input', 'br', 'hr', 'img'].includes(tag)) stack.push(element);
    } else {
      const text = new Element('#text', parent.ownerDocument);
      text.textContent = decode(token);
      stack.at(-1).appendChild(text);
    }
  }
}

function visibleText(element) {
  if (element.hidden || element.tagName === 'SCRIPT' || element.tagName === 'STYLE') return '';
  return (element._text ?? '') + element.children.map(visibleText).join('');
}

async function browser({ search = '?lat=40.33&lng=44.73', native, wallTime = NOW, stations = [station()], catalogueStations = stations, response } = {}) {
  let elapsed = 0;
  let timerId = 0;
  let bridge = native;
  let nextResponse = response ?? (() => feed(stations));
  const timers = new Map();
  const requests = [];
  const document = new Element('document');
  document.ownerDocument = document;
  document.createElement = tag => new Element(tag, document);
  document.getElementById = id => document.querySelectorAll(`#${id}`)[0] ?? null;
  parseHtml(widgetHtml, document);
  document.documentElement = document.querySelector('html');
  document.body = document.querySelector('body');
  let geoSuccess;
  let geoError;
  const schedule = (callback, delay, repeat) => {
    const id = ++timerId;
    timers.set(id, { callback, due: elapsed + delay, delay, repeat });
    return id;
  };
  const context = {
    document, HTMLElement: Element, Element, URL, URLSearchParams, AbortController,
    TextDecoder, TextEncoder, Request, Response, Headers, console,
    location: { search, href: `https://stations.example/xct${search}`, origin: 'https://stations.example' },
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [wallTime + elapsed])); }
      static now() { return wallTime + elapsed; }
    },
    performance: { now: () => elapsed },
    navigator: { geolocation: { watchPosition(success, error) { geoSuccess = success; geoError = error; return 1; } } },
    setTimeout: (callback, delay = 0) => schedule(callback, delay, false),
    clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay = 0) => schedule(callback, delay, true),
    clearInterval: id => timers.delete(id),
    addEventListener() {},
    fetch: async input => {
      const url = new URL(String(input), 'https://stations.example');
      requests.push(url);
      if (url.pathname.endsWith('/catalogue')) return new Response(JSON.stringify(catalogue(catalogueStations)));
      if (!url.pathname.endsWith('/feed')) throw new Error(`Unexpected URL: ${url}`);
      const data = await nextResponse(url);
      return data instanceof Response ? data : new Response(JSON.stringify(data));
    },
  };
  context.window = context;
  if (native !== undefined) context.XCTrack = { getLocation: () => JSON.stringify(bridge) };
  runInNewContext(widgetSource, context, { timeout: 5000 });
  const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };
  await settle();
  return {
    document, requests,
    get(id) { return document.getElementById(id); },
    tiles() { return document.querySelectorAll('.stationDetail'); },
    text() { return visibleText(document.body); },
    setNative(value) { bridge = value; },
    setResponse(callback) { nextResponse = callback; },
    async locate(coords = { latitude: 40.33, longitude: 44.73, altitude: null }, timestamp = wallTime + elapsed) {
      assert.ok(geoSuccess, 'widget started browser geolocation');
      geoSuccess({ coords, timestamp }); await settle();
    },
    async loseLocation() {
      assert.ok(geoError, 'widget started browser geolocation');
      geoError({ code: 2, PERMISSION_DENIED: 1 }); await settle();
    },
    async advance(ms) {
      const target = elapsed + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        elapsed = timer.due;
        if (timer.repeat) timer.due += timer.delay;
        else timers.delete(id);
        timer.callback();
        await settle();
      }
      elapsed = target;
      await settle();
    },
  };
}

test('XCTrack successful empty feed and failed initial request have distinct visible states', async () => {
  const empty = await browser({ stations: [] });
  assert.equal(empty.tiles().length, 0);
  assert.match(empty.get('empty-state').textContent, /no .*wind|no .*stations/i);
  assert.doesNotMatch(empty.get('empty-state').textContent, /wait|loading/i);
  const failed = await browser({ response: () => new Response('offline', { status: 503 }) });
  assert.equal(failed.tiles().length, 0);
  assert.match(failed.text(), /offline|unavailable|unable|failed/i);
});

test('XCTrack clears tiles when a browser fix is lost and restores them on recovery', async () => {
  const page = await browser({ search: '' });
  await page.locate();
  assert.equal(page.tiles().length, 1);
  await page.loseLocation();
  assert.equal(page.tiles().length, 0);
  assert.match(page.text(), /position|location|GPS/i);
  await page.locate();
  assert.equal(page.tiles().length, 1);
});

test('XCTrack rejects invalid, out-of-range and recently-stale native fixes; altGps controls terrain', async t => {
  const valid = { isValid: true, lat: 40.33, lon: 44.73, time: NOW, altGps: 1200 };
  for (const patch of [{ isValid: false }, { isValid: 0 }, { lat: 91 }, { lon: 181 }, { time: NOW - 120_000 }]) {
    await t.test(JSON.stringify(patch), async () => {
      const page = await browser({ search: '', native: { ...valid, ...patch } });
      assert.equal(page.tiles().length, 0);
      assert.equal(page.requests.filter(url => url.pathname.endsWith('/feed')).length, 0);
      assert.match(page.text(), patch.time === NOW - 120_000 ? /GPS fix stale/i : /GPS fix unavailable/i);
    });
  }
  const page = await browser({ search: '', native: valid });
  assert.equal(page.tiles().length, 1);
  assert.equal(page.tiles()[0].classList.contains('peak'), false, 'station below altGps is a valley');
  page.setNative({ ...valid, isValid: false });
  await page.advance(1000);
  assert.equal(page.tiles().length, 0, 'native invalidation removes the previous fix tiles');
  assert.match(page.text(), /GPS fix unavailable/i);
});

test('XCTrack accepts bridge quirks and ages only when the raw payload identity changes', async t => {
  const accepted = [
    { isValid: 1, lat: '40.33', lon: '44.73', time: null, altGps: 1200 },
    { lat: 40.33, lon: 44.73, time: 43_200, altGps: 1200 },
    { isValid: 'true', lat: 40.33, lon: 44.73, time: NOW - 3 * 3600_000, altGps: 1200 },
    { isValid: true, lat: 40.33, lon: 44.73, time: NOW + 120_000, altGps: 1200 },
  ];
  for (const native of accepted) {
    await t.test(JSON.stringify(native), async () => {
      const page = await browser({ search: '', native });
      assert.equal(page.tiles().length, 1, 'quirky but in-range native fix is usable');
      for (let step = 1; step <= 31; step += 1) {
        page.setNative({ ...native, time: typeof native.time === 'number' ? native.time + step : step });
        await page.advance(1_000);
      }
      assert.equal(page.tiles().length, 1, 'changing raw time renews the fix clock');
    });
  }
});

test('XCTrack browser GPS accepts a non-unix timestamp and rejects a real stale unix time', async () => {
  const oddStamp = await browser({ search: '' });
  await oddStamp.locate({ latitude: 40.33, longitude: 44.73, altitude: null }, 0);
  assert.equal(oddStamp.tiles().length, 1, 'timestamp 0 still yields tiles when coordinates are valid');

  const stale = await browser({ search: '' });
  await stale.locate({ latitude: 40.33, longitude: 44.73, altitude: null }, NOW - 120_000);
  assert.equal(stale.tiles().length, 0);
  assert.match(stale.text(), /GPS fix stale/i);
});

test('XCTrack explicit fixed position overrides both invalid and different native fixes', async t => {
  for (const isValid of [false, true]) {
    await t.test(`native isValid=${isValid}`, async () => {
      const page = await browser({
        search: '?lat=40.33&lng=44.73&alt=1200',
        native: { isValid, lat: 10, lon: 20, time: NOW, altGps: 500 },
      });
      assert.equal(page.tiles().length, 1);
      assert.equal(page.tiles()[0].classList.contains('peak'), false, 'URL altitude owns fixed-position terrain');
      const discovery = page.requests.find(url => url.pathname.endsWith('/catalogue'));
      assert.ok(discovery, 'fixed position triggers nearby discovery');
      assert.match(discovery.searchParams.get('near'), /^40\.33,44\.73(?:,|$)/);
      await page.advance(31_000);
      assert.equal(page.tiles().length, 1, 'fixed position remains usable after the native fix expires');
    });
  }
});

test('XCTrack an unchanged native timestamp expires despite repeated bridge reads', async () => {
  const page = await browser({
    search: '', native: { isValid: true, lat: 40.33, lon: 44.73, time: NOW, altGps: 1200 },
  });
  assert.equal(page.tiles().length, 1);
  await page.advance(30_000);
  assert.equal(page.tiles().length, 1, 'fix remains valid at the thirty-second limit');
  await page.advance(1000);
  assert.equal(page.tiles().length, 0, 'unchanged bridge timestamps cannot renew a stale fix');
  assert.match(page.text(), /GPS.*stale|stale.*GPS/i);
});

test('XCTrack missing altitude in a new native fix clears the previous altitude', async () => {
  const native = { isValid: true, lat: 40.33, lon: 44.73, time: NOW, altGps: 1200 };
  const page = await browser({ search: '', native });
  assert.equal(page.tiles()[0].classList.contains('peak'), false);
  const { altGps, ...withoutAltitude } = native;
  page.setNative({ ...withoutAltitude, time: NOW + 1000 });
  await page.advance(1000);
  assert.equal(page.tiles()[0].classList.contains('peak'), true, 'unknown pilot altitude uses station elevation rather than the previous pilot fix');
});

test('XCTrack freshness uses server time despite device clock skew and ages retained data', async t => {
  for (const skew of [-2 * 60 * 60_000, 2 * 60 * 60_000]) {
    await t.test(`${skew} ms clock offset`, async () => {
      const sample = station();
      sample.reading.observedAt = new Date(NOW - 45 * 60_000).toISOString();
      const page = await browser({ wallTime: NOW + skew, stations: [sample] });
      assert.equal(page.tiles().length, 1);
      assert.equal(page.tiles()[0].classList.contains('stale'), true);
      assert.match(page.tiles()[0].title, /45 min/);
      page.setResponse(() => new Response('offline', { status: 503 }));
      await page.advance(60_000);
      assert.match(page.tiles()[0].title, /46 min/);
      assert.match(page.tiles()[0].title, /offline|unavailable|failed/i);
    });
  }
});

test('XCTrack keeps the original static tile-only UI with units and unknown direction in its title', async () => {
  const sample = station();
  sample.reading.windDirectionDeg = null;
  const page = await browser({ stations: [sample] });
  const tile = page.tiles()[0];
  for (const id of ['unit-label', 'station-count', 'feed-status', 'position-status', 'coverage-status', 'station-viewport', 'scroll-hint', 'station-details', 'detail-text', 'close-details']) {
    assert.equal(page.get(id), null, `${id} does not add visual UI to the widget`);
  }
  assert.equal(page.document.querySelector('header'), null);
  assert.equal(page.document.querySelector('[role="dialog"]'), null);
  assert.equal(tile.getAttribute('role'), 'listitem');
  assert.equal(tile.getAttribute('tabindex'), null);
  assert.match(tile.title, /km\/h/);
  assert.match(tile.title, /Test ridge with a long station name/);
  assert.doesNotMatch(tile.title, /calm/i);
  assert.match(tile.title, /unknown|unavailable/i);
  const originalContents = page.text();
  tile.click();
  tile.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.equal(page.text(), originalContents, 'static tiles do not open a detail panel');
  assert.equal(page.document.querySelector('[role="dialog"]'), null);
});

test('XCTrack retains unavailable provider observations with failure information only in their title', async () => {
  const sample = station();
  const page = await browser({ stations: [sample] });
  assert.equal(page.tiles().length, 1);
  page.setResponse(() => feed([
    { ...sample, status: 'unavailable', reason: 'not_configured', reading: null },
  ], NOW + 60_000));
  await page.advance(60_000);
  assert.equal(page.tiles().length, 1, 'last observation survives a partial provider failure');
  assert.match(page.tiles()[0].title, /unavailable|failed|retained|last reading/i);
  assert.doesNotMatch(page.text(), /⚠|unavailable|partial|failed|retained/i);
  assert.equal(page.tiles()[0].classList.contains('retained'), false, 'retained data does not add an outline');
});

test('XCTrack expires a retained observation while network requests keep failing', async () => {
  const page = await browser({ search: '?lat=40.33&lng=44.73&maxage=2' });
  assert.equal(page.tiles().length, 1);
  page.setResponse(() => new Response('offline', { status: 503 }));
  await page.advance(61_000);
  assert.equal(page.tiles().length, 0, 'maxage advances even without a successful refresh');
  assert.match(page.text(), /unavailable|offline|failed/i);
});

test('XCTrack retains a positive gust that is smaller than one display unit', async () => {
  const sample = station();
  sample.reading.windAvgMps = 0.1;
  sample.reading.windGustMps = 0.4;
  sample.reading.windDirectionDeg = null;
  const page = await browser({ search: '?lat=40.33&lng=44.73&units=ms', stations: [sample] });
  const gust = page.tiles()[0].querySelector('.dialGust');
  assert.ok(gust, 'positive gust remains present');
  assert.match(gust.textContent, /0\.4|<1|0/);
  assert.match(page.tiles()[0].title, /gust (?:0\.4|<1|0) m\/s/);
});

test('XCTrack preserves three-digit speeds in the dial and station title', async () => {
  const sample = station();
  sample.reading.windAvgMps = 30;
  sample.reading.windGustMps = 45;
  const page = await browser({ stations: [sample] });
  const tile = page.tiles()[0];
  assert.equal(tile.querySelector('.dialAvg').textContent, '108');
  assert.equal(tile.querySelector('.dialGust').textContent, '162');
  assert.match(tile.title, /average 108, gust 162 km\/h/);
});
