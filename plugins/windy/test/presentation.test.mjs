import assert from 'node:assert/strict';
import test from 'node:test';
import { presentStation, safeSourceUrl, windDirectionRotation } from '../src/presentation.ts';

const metric = { convertValue: value => `${value * 2} kt` };
const entry = {
  station: { uid: 's1', vendor: 'windnerd', category: null, name: 'Station', elevationM: 0, pageUrl: 'https://example.com/station' },
  status: 'ok',
  observation: {
    status: 'ok', sourceLabel: 'Network', pageUrl: null, elevationM: null, recommendedPollSeconds: 60,
    reading: { observedAt: '2026-10-26T12:00:00Z', windAvgMps: 0, windGustMps: null, windDirectionDeg: 0, temperatureC: 0 },
  },
  unavailable: null, error: null, servedAt: '2026-10-26T12:00:30Z', receivedAtMs: 1000,
};

test('source links accept only absolute HTTP and HTTPS URLs', () => {
  assert.equal(safeSourceUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeSourceUrl('http://example.com'), 'http://example.com/');
  for (const url of [null, undefined, '', 'javascript:alert(1)', 'data:text/html,x', '//example.com', '/relative', 'not a url']) {
    assert.equal(safeSourceUrl(url), null);
  }
  const unsafe = { ...entry, observation: { ...entry.observation, pageUrl: 'javascript:alert(1)' } };
  assert.equal(presentStation(unsafe, metric, 1000).sourceUrl, null);
});

test('zero is preserved independently of missing wind values', () => {
  const view = presentStation(entry, metric, 1000);
  assert.equal(view.average, '0 kt');
  assert.equal(view.gust, 'Not reported');
  assert.equal(view.direction, '0° from');
  assert.equal(view.rotation, 0);
  assert.equal(view.temperature, '0 °C');
  assert.equal(view.elevation, '0 m');
  assert.equal(view.source, 'Network');
  assert.equal(view.sourceUrl, 'https://example.com/station');
  const missing = { ...entry, observation: { ...entry.observation, reading: { ...entry.observation.reading, windAvgMps: null, windDirectionDeg: null, windGustMps: 2 } } };
  const noAverage = presentStation(missing, metric, 1000);
  assert.equal(noAverage.average, 'Not reported');
  assert.equal(noAverage.direction, 'Not reported');
  assert.equal(noAverage.rotation, null);
  assert.equal(noAverage.gust, '4 kt');
});

test('arrow rotation points toward the meteorological source direction', () => {
  for (const direction of [0, 90, 180, 270]) {
    assert.equal(windDirectionRotation(direction), direction);
    const reading = { ...entry.observation.reading, windDirectionDeg: direction };
    assert.equal(presentStation({ ...entry, observation: { ...entry.observation, reading } }, metric, 1000).rotation, direction);
  }
  assert.equal(windDirectionRotation(360), 0);
  assert.equal(windDirectionRotation(-90), 270);
  assert.equal(windDirectionRotation(null), null);
  assert.equal(windDirectionRotation(NaN), null);
});

test('age and pilot freshness advance from server time using monotonic elapsed time', () => {
  assert.equal(presentStation(entry, metric, 1000).age, 'Less than 1 min ago');
  assert.equal(presentStation(entry, metric, 1000).freshness, 'live');
  assert.equal(presentStation(entry, metric, 301_000).age, '5 min ago');
  assert.equal(presentStation(entry, metric, 301_000).freshness, 'aging');
  assert.equal(presentStation(entry, metric, 1_001_000).freshness, 'stale');
  const future = { ...entry, observation: { ...entry.observation, reading: { ...entry.observation.reading, observedAt: '2026-10-26T12:10:00Z' } } };
  assert.equal(presentStation(future, metric, 61_000).age, '1 min ago');
  const noObservation = { ...entry, status: 'catalogue', observation: null, servedAt: null, receivedAtMs: null };
  const view = presentStation(noObservation, metric, 61_000);
  assert.equal(view.status, 'Not yet loaded');
  assert.equal(view.age, 'Unknown age');
  assert.equal(view.freshness, null);
  assert.equal(view.average, 'Not reported');
});

test('retained readings keep freshness separate from availability or refresh failure', () => {
  for (const [status, label] of [['loading', 'Loading'], ['unavailable', 'Unavailable'], ['refresh-failed', 'Refresh failed']]) {
    const view = presentStation({ ...entry, status }, metric, 1_001_000);
    assert.equal(view.status, label);
    assert.equal(view.freshness, 'stale');
    assert.equal(view.average, '0 kt');
  }
});

test('unavailable source links follow the source shown when there is no retained observation', () => {
  const unavailable = { ...entry, status: 'unavailable', observation: null, unavailable: { status: 'unavailable', sourceLabel: 'Unavailable network', pageUrl: 'https://example.org/station' } };
  const view = presentStation(unavailable, metric, 1000);
  assert.equal(view.source, 'Unavailable network');
  assert.equal(view.sourceUrl, 'https://example.org/station');
  assert.equal(presentStation({ ...unavailable, observation: entry.observation }, metric, 1000).sourceUrl, entry.station.pageUrl);
  assert.equal(presentStation({ ...unavailable, unavailable: { ...unavailable.unavailable, pageUrl: 'javascript:alert(1)' } }, metric, 1000).sourceUrl, null);
});

test('wind values are converted through the selected metric on each presentation', () => {
  const station = { ...entry, observation: { ...entry.observation, reading: { ...entry.observation.reading, windAvgMps: 3, windGustMps: 4 } } };
  assert.equal(presentStation(station, metric, 1000).average, '6 kt');
  const other = { convertValue: value => `${value} m/s` };
  assert.equal(presentStation(station, other, 1000).average, '3 m/s');
  assert.equal(presentStation(station, other, 1000).gust, '4 m/s');
});
