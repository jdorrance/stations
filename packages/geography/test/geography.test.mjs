import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INITIAL_SCOPE_REGIONS,
  NORTH_AMERICA_REGIONS,
  bearingDeg,
  boundsIntersect,
  containsPoint,
  containsPolygon,
  coverageForRegions,
  coversPoint,
  createSpatialIndex,
  distanceKm,
  inRegion,
  inferRegionCode,
  normalizeLongitude,
  parseBoundsParam,
  regionDescriptor,
  tileBounds,
  validBounds,
  validPosition,
} from '../dist/index.js';

test('validPosition and validBounds validate geographic coordinates', () => {
  assert.equal(validPosition({ latitude: 47.4995, longitude: -122.009 }), true);
  assert.equal(validPosition({ latitude: 95, longitude: 0 }), false);
  assert.equal(validBounds([-125, 24, -66, 49]), true);
  assert.equal(validBounds([-125, 50, -66, 49]), false);
  assert.deepEqual(parseBoundsParam('-123.5, 47.0, -121.0, 49.0'), [-123.5, 47, -121, 49]);
  assert.equal(parseBoundsParam('invalid'), null);
  assert.equal(normalizeLongitude(185), -175);
  assert.equal(boundsIntersect([-125, 45, -120, 49], [-122, 47, -118, 50]), true);
  assert.equal(boundsIntersect([43, 38, 46, 41], [-125, 45, -120, 49]), false);
});

test('regional coverages and explicit country metadata identify US, CA, MX, and AM launches', () => {
  assert.deepEqual(NORTH_AMERICA_REGIONS, ['US', 'CA', 'MX']);
  assert.deepEqual(INITIAL_SCOPE_REGIONS, ['US', 'CA', 'MX', 'AM']);
  assert.equal(regionDescriptor('AM').defaultTimeZone, 'Asia/Yerevan');

  const tigerMountain = { latitude: 47.4995, longitude: -122.009 };
  const pemberton = { latitude: 50.318, longitude: -122.805 };
  const valleDeBravo = { latitude: 19.195, longitude: -100.132 };
  const hatis = { latitude: 40.3063, longitude: 44.7253 };
  const alps = { latitude: 45.9237, longitude: 6.8694 };

  assert.equal(inferRegionCode(tigerMountain, 'US'), 'US');
  assert.equal(inferRegionCode(pemberton, 'CA'), 'CA');
  assert.equal(inferRegionCode(valleDeBravo, 'MX'), 'MX');
  assert.equal(inferRegionCode(hatis, 'AM'), 'AM');
  assert.equal(inferRegionCode(alps), null);

  assert.equal(inRegion('US', tigerMountain, 'US'), true);
  assert.equal(inRegion('CA', pemberton, 'CA'), true);
  assert.equal(inRegion('MX', valleDeBravo, 'MX'), true);
  assert.equal(inRegion('AM', hatis, 'AM'), true);

  const initialCoverage = coverageForRegions(INITIAL_SCOPE_REGIONS);
  assert.equal(coversPoint(initialCoverage, tigerMountain), true);
  assert.equal(coversPoint(initialCoverage, hatis), true);
  assert.equal(coversPoint(initialCoverage, alps), false);
});

test('SpatialIndex queries bounding boxes and great-circle radii accurately', () => {
  const stations = [
    { id: 'wa-tiger', latitude: 47.4995, longitude: -122.009 },
    { id: 'wa-blanchard', latitude: 48.6097, longitude: -122.426 },
    { id: 'bc-woodside', latitude: 49.261, longitude: -121.872 },
    { id: 'mx-valle', latitude: 19.195, longitude: -100.132 },
    { id: 'am-hatis', latitude: 40.3063, longitude: 44.7253 },
    { id: 'am-aparan', latitude: 40.5913, longitude: 44.4741 },
  ];

  const index = createSpatialIndex(stations, 1);
  assert.equal(index.size, 6);

  const pnw = index.queryBounds([-123.0, 47.0, -121.0, 49.5]).map(s => s.id).sort();
  assert.deepEqual(pnw, ['bc-woodside', 'wa-blanchard', 'wa-tiger']);

  const nearYerevan = index.queryRadius({ latitude: 40.1872, longitude: 44.5152 }, 60);
  assert.deepEqual(nearYerevan.map(m => m.item.id), ['am-hatis', 'am-aparan']);
  assert.ok(nearYerevan[0].distanceKm < nearYerevan[1].distanceKm);

  const limited = index.queryRadius({ latitude: 40.1872, longitude: 44.5152 }, 60, 1);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].item.id, 'am-hatis');
});

test('containsPolygon, distanceKm, bearingDeg, and tileBounds work across standard geometries', () => {
  const box = [[[44.0, 40.0], [45.0, 40.0], [45.0, 41.0], [44.0, 41.0], [44.0, 40.0]]];
  assert.equal(containsPolygon(box, { latitude: 40.5, longitude: 44.5 }), true);
  assert.equal(containsPolygon(box, { latitude: 41.5, longitude: 44.5 }), false);
  assert.equal(containsPoint([44.0, 40.0, 45.0, 41.0], { latitude: 40.5, longitude: 44.5 }), true);
  assert.ok(distanceKm({ latitude: 40.0, longitude: 44.0 }, { latitude: 41.0, longitude: 44.0 }) > 110);
  assert.ok(Math.abs(bearingDeg({ latitude: 40.0, longitude: 44.0 }, { latitude: 41.0, longitude: 44.0 }) - 0) < 0.01);
  assert.ok(Math.abs(bearingDeg({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }) - 90) < 0.01);
  const tiles = tileBounds([-124, 46, -120, 48], 1, 2);
  assert.equal(tiles.length, 4);
  assert.deepEqual(tiles[0], [-124, 46, -122, 47]);
  assert.deepEqual(tiles[3], [-122, 47, -120, 48]);
});
