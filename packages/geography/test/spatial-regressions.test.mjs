import assert from 'node:assert/strict';
import test from 'node:test';
import {
  containsPoint,
  boundsIntersect,
  parseBoundsParam,
  tileBounds,
  bearingDeg,
  createSpatialIndex,
  distanceKm,
  inferRegionCode,
  inRegion,
} from '../dist/index.js';

const ids = items => items.map(item => item.id).sort();

test('bounds include +180, both date-line representations, and the whole globe', () => {
  const stations = [
    { id: 'origin', latitude: 0, longitude: 0 },
    { id: 'east', latitude: 0, longitude: 175 },
    { id: 'west', latitude: 0, longitude: -175 },
    { id: 'positive-date-line', latitude: 0, longitude: 180 },
    { id: 'negative-date-line', latitude: 0, longitude: -180 },
    { id: 'north-pole', latitude: 90, longitude: 45 },
    { id: 'south-pole', latitude: -90, longitude: -45 },
  ];
  const boundsList = [
    [-180, -90, 180, 90],
    [170, -5, 180, 5],
    [-180, -5, -170, 5],
    [170, -5, -170, 5],
    [180, -5, 180, 5],
    [-180, -5, -180, 5],
    [180, -5, -180, 5],
    [-180, 90, 180, 90],
  ];
  for (const cellDegrees of [0.5, 1, 7, 360]) {
    const index = createSpatialIndex(stations, cellDegrees);
    for (const bounds of boundsList) {
      assert.deepEqual(ids(index.queryBounds(bounds)), ids(stations.filter(point => containsPoint(bounds, point))),
        `bounds ${bounds}; cell size ${cellDegrees}`);
    }
  }
});

test('radius bounds retain stations at latitude and longitude extrema', () => {
  const north = { id: 'north', latitude: 1, longitude: 0 };
  assert.ok(distanceKm({ latitude: 0, longitude: 0 }, north) < 111.2);
  assert.deepEqual(ids(createSpatialIndex([north]).queryRadius({ latitude: 0, longitude: 0 }, 111.2).map(match => match.item)), ['north']);

  const east = { id: 'east', latitude: 60.307837510441736, longitude: 9.021214235402342 };
  assert.ok(distanceKm({ latitude: 60, longitude: 0 }, east) < 500.001);
  assert.deepEqual(ids(createSpatialIndex([east]).queryRadius({ latitude: 60, longitude: 0 }, 500.001).map(match => match.item)), ['east']);
});

test('indexed radius results match brute-force distances at poles, the date line, and random centers', () => {
  let seed = 0x5eed;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const stations = [
    { id: 'origin', latitude: 0, longitude: 0 },
    { id: 'north-pole', latitude: 90, longitude: 45 },
    { id: 'south-pole', latitude: -90, longitude: -45 },
    { id: 'date-line-east', latitude: 5, longitude: 180 },
    { id: 'date-line-west', latitude: 5, longitude: -180 },
    ...Array.from({ length: 600 }, (_, id) => ({ id: `random-${id}`, latitude: random() * 180 - 90, longitude: random() * 360 - 180 })),
  ];
  const queries = [
    [{ latitude: 90, longitude: 0 }, 800],
    [{ latitude: -90, longitude: 0 }, 800],
    [{ latitude: 85, longitude: 90 }, 1200],
    [{ latitude: 5, longitude: 179 }, 300],
    [{ latitude: 5, longitude: -180 }, 0],
    [{ latitude: 0, longitude: 0 }, 0],
    [{ latitude: 0, longitude: 0 }, Math.PI * 6371],
    [{ latitude: -80, longitude: 180 }, 100_000],
    ...Array.from({ length: 25 }, () => [{ latitude: random() * 180 - 90, longitude: random() * 360 - 180 }, random() * 21_000]),
  ];
  for (const cellDegrees of [1, 7, 360]) {
    const index = createSpatialIndex(stations, cellDegrees);
    for (const [center, radius] of queries) {
      const expected = stations.filter(station => distanceKm(center, station) <= radius);
      const actual = index.queryRadius(center, radius);
      assert.deepEqual(ids(actual.map(match => match.item)), ids(expected),
        `center ${JSON.stringify(center)}; radius ${radius}; cell size ${cellDegrees}`);
      assert.ok(actual.every((match, i) => i === 0 || actual[i - 1].distanceKm <= match.distanceKm));
      assert.deepEqual(index.queryRadius(center, radius, 3), actual.slice(0, 3));
    }
  }
});

test('country resolution preserves metadata and does not guess from overlapping coverage', () => {
  const examples = [
    [{ latitude: 58.3549, longitude: -134.5763 }, 'US'], // Juneau Airport
    [{ latitude: 46.7867, longitude: -92.1005 }, 'US'], // Duluth
    [{ latitude: 42.3149, longitude: -83.0364 }, 'CA'], // Windsor
    [{ latitude: 40.3063, longitude: 44.7253 }, 'AM'],
    [{ latitude: 19.195, longitude: -100.132 }, 'MX'],
    [{ latitude: 52.84, longitude: 173.19 }, 'US'], // Aleutians outside the coarse envelope
  ];
  for (const [point, country] of examples) {
    assert.equal(inferRegionCode(point), null);
    assert.equal(inferRegionCode(point, ` ${country.toLowerCase()} `), country);
    assert.equal(inRegion(country, point), false);
    assert.equal(inRegion(country, point, country), true);
    assert.equal(inferRegionCode(point, 'GB'), null);
  }
  assert.equal(inferRegionCode({ latitude: 95, longitude: 0 }, 'US'), null);
});


test('date-line intervals intersect even with opposite endpoint representations', () => {
  assert.equal(boundsIntersect([170, -5, 180, 5], [-180, -5, -170, 5]), true);
  assert.equal(boundsIntersect([180, -5, 180, 5], [-180, -5, -180, 5]), true);
  assert.equal(boundsIntersect([170, -5, 179, 5], [-180, -5, -170, 5]), false);
  assert.equal(boundsIntersect([170, -5, 180, 5], [-180, 6, -170, 8]), false);
});

test('bbox parser rejects missing coordinates rather than treating them as zero', () => {
  for (const input of [',0,1,2', '0, ,1,2', '0,0,,2', '0,0,1,']) {
    assert.equal(parseBoundsParam(input), null);
  }
});

test('tiles preserve exact bounds and narrow coverage without coordinate rounding', () => {
  const bounds = [10.00000004, 20.00000004, 10.00000024, 20.00000024];
  const tiles = tileBounds(bounds, 0.0000001, 0.0000001);
  assert.ok(tiles.length > 0);
  assert.ok(tiles.every(tile => tile[0] < tile[2] && tile[1] < tile[3]));
  assert.equal(Math.min(...tiles.map(tile => tile[0])), bounds[0]);
  assert.equal(Math.min(...tiles.map(tile => tile[1])), bounds[1]);
  assert.equal(Math.max(...tiles.map(tile => tile[2])), bounds[2]);
  assert.equal(Math.max(...tiles.map(tile => tile[3])), bounds[3]);
  assert.deepEqual(tileBounds([179, -1, -179, 1], 2, 1), [[179, -1, 180, 1], [-180, -1, -179, 1]]);
  assert.throws(() => tileBounds([-180, -90, 180, 90], 1e-100, 1e-100), RangeError);
  assert.ok(Math.abs(bearingDeg({ latitude: 0, longitude: 179 }, { latitude: 0, longitude: -179 }) - 90) < 1e-9);
});

test('sparse fine grids query occupied cells without enumerating empty space', () => {
  const point = { latitude: 40, longitude: 44 };
  const index = createSpatialIndex([point], 0.0001);
  assert.deepEqual(index.queryBounds([-180, -90, 180, 90]), [point]);
  assert.deepEqual(index.queryRadius({ latitude: 0, longitude: 0 }, 30_000).map(match => match.item), [point]);
  assert.throws(() => createSpatialIndex([point], 1e-100), RangeError);
});
