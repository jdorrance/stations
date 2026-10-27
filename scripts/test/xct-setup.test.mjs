/** Execute the setup page's shipped controls; layout remains a browser check. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { root } from '../workspace.mjs';

const html = readFileSync(resolve(root, 'web/xct-use.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, 'setup page must have an executable script');

function setupPage() {
  const elements = new Map();
  function element(id, value = '') {
    const listeners = new Map();
    return {
      id, value, checked: false, disabled: false, hidden: false, href: '',
      textContent: '', validity: { badInput: false }, attributes: new Map(),
      setCustomValidity(message) { this.validationMessage = message; },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) {
        this.attributes.delete(name);
        if (name === 'href') this.href = '';
      },
      addEventListener(type, listener) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener]);
      },
      dispatch(type) {
        const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
        for (const listener of listeners.get(type) ?? []) listener(event);
        return event;
      },
    };
  }
  for (const [, id] of html.matchAll(/id="([^"]+)"/g)) elements.set(id, element(id));
  const categories = [...html.matchAll(/name="category" value="([^"]+)"/g)]
    .map(([, value]) => element('', value));
  const copied = [];
  runInNewContext(script, {
    document: {
      getElementById: id => elements.get(id),
      querySelectorAll: selector => {
        assert.equal(selector, 'input[name="category"]');
        return categories;
      },
    },
    location: { origin: 'https://stations.example' }, URLSearchParams,
    navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
  });
  return {
    get: id => elements.get(id), copied,
    input(values) {
      for (const [id, value] of Object.entries(values)) {
        const el = elements.get(id);
        el.value = value;
        el.dispatch('input');
      }
    },
  };
}

function assertBlocked(page, error) {
  assert.equal(page.get('widget-url').value, '');
  assert.equal(page.get('copy').disabled, true);
  assert.equal(page.get('open').href, '');
  assert.equal(page.get('open').attributes.get('aria-disabled'), 'true');
  assert.equal(page.get('validation-note').hidden, false);
  assert.equal(page.get('open').dispatch('click').defaultPrevented, true);
  assert.match(page.get(`${error.field}-error`).textContent, error.message);
  assert.equal(page.get(`${error.field}-error`).hidden, false);
}

test('XCTrack setup rejects invalid settings and removes copy/open targets', () => {
  const invalid = [
    [{ maxage: '0.4' }, 'maxage', /whole number/],
    [{ maxage: '0' }, 'maxage', /at least 1/],
    [{ size: '100.1' }, 'size', /0 to 100/],
    [{ lat: '200', lng: '44.73' }, 'lat', /−90 and 90/],
    [{ lat: '40.33', lng: '-181' }, 'lng', /−180 and 180/],
    [{ lat: '40.33' }, 'lng', /with latitude/],
    [{ lng: '44.73' }, 'lat', /with longitude/],
    [{ lat: 'bad', lng: '44.73' }, 'lat', /−90 and 90/],
    [{ alt: 'bad' }, 'alt', /number in metres/],
  ];
  for (const [values, field, message] of invalid) {
    const page = setupPage();
    page.input(values);
    assertBlocked(page, { field, message });
    page.get('copy').dispatch('click');
    assert.equal(page.copied.length, 0, 'even a dispatched click must not copy invalid data');
  }
});

test('XCTrack setup accepts boundaries and recovers from the reported invalid configuration', async () => {
  const page = setupPage();
  assert.equal(page.get('widget-url').value, 'https://stations.example/xct');
  page.input({ maxage: '0.4', lat: '200', lng: '44.73' });
  assertBlocked(page, { field: 'maxage', message: /whole number/ });
  page.input({ maxage: '15', lat: '40.3347', size: '50', units: 'kts' });
  const expected = 'https://stations.example/xct?units=kts&size=50&maxage=15&lat=40.3347&lng=44.73';
  assert.equal(page.get('widget-url').value, expected);
  assert.equal(page.get('open').href, expected);
  assert.equal(page.get('copy').disabled, false);
  assert.equal(page.get('validation-note').hidden, true);
  assert.equal(page.get('maxage-error').hidden, true);
  assert.equal(page.get('lat-error').hidden, true);
  page.get('copy').dispatch('click');
  await Promise.resolve();
  assert.deepEqual(page.copied, [expected]);
  page.input({ size: '100', maxage: '1', lat: '-90', lng: '180', alt: '0' });
  assert.equal(page.get('copy').disabled, false);
  assert.match(page.get('widget-url').value, /size=100&maxage=1&lat=-90&lng=180&alt=0$/);
  page.input({ size: '', maxage: '', lat: '', lng: '', alt: '', units: '' });
  assert.equal(page.get('widget-url').value, 'https://stations.example/xct');
  assert.equal(page.get('copy').disabled, false);
});

test('XCTrack setup treats an unfinished number input as invalid rather than the blank default', () => {
  const page = setupPage();
  page.get('maxage').validity.badInput = true;
  page.get('maxage').dispatch('input');
  assertBlocked(page, { field: 'maxage', message: /whole number/ });
  page.get('maxage').validity.badInput = false;
  page.get('maxage').dispatch('input');
  assert.equal(page.get('copy').disabled, false);
  assert.equal(page.get('widget-url').value, 'https://stations.example/xct');
});
