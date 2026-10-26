import {
  containsPoint,
  distanceKm,
  normalizeLongitude,
  validBounds,
  validPosition,
  type Bounds,
  type Position,
} from './index.ts';

export interface NearbyMatch<T extends Position> {
  readonly item: T;
  readonly distanceKm: number;
}

export interface SpatialIndex<T extends Position> {
  readonly size: number;
  all(): readonly T[];
  queryBounds(bounds: Bounds): T[];
  queryRadius(center: Position, radiusKm: number, limit?: number): NearbyMatch<T>[];
}

// Keep the sphere consistent with distanceKm's exact final distance check.
const EARTH_RADIUS_KM = 6371;
const RADIANS_TO_DEGREES = 180 / Math.PI;
const BOUNDS_PADDING_DEGREES = 1e-9;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function createSpatialIndex<T extends Position>(
  items: readonly T[],
  cellDegrees = 1,
): SpatialIndex<T> {
  if (!Number.isFinite(cellDegrees) || cellDegrees <= 0) {
    throw new Error('cellDegrees must be a positive finite number');
  }
  const latCells = Math.ceil(180 / cellDegrees);
  const lonCells = Math.ceil(360 / cellDegrees);
  if (!Number.isSafeInteger(latCells * lonCells)) {
    throw new RangeError('cellDegrees is too small to represent grid cells safely');
  }
  const validItems = items.filter(validPosition);
  const buckets = new Map<number, T[]>();

  const toLatCell = (lat: number): number =>
    clamp(Math.floor((lat + 90) / cellDegrees), 0, latCells - 1);
  const toLonCell = (lon: number): number =>
    clamp(Math.floor((lon + 180) / cellDegrees), 0, lonCells - 1);
  const cellKey = (latCell: number, lonCell: number): number => latCell * lonCells + lonCell;

  for (const item of validItems) {
    // Both representations of the date line share a bucket, but a bounds
    // endpoint at +180 must still reach the easternmost longitude cells.
    const key = cellKey(toLatCell(item.latitude), toLonCell(item.longitude === 180 ? -180 : item.longitude));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  function collectBoundsCandidates(bounds: Bounds): Set<T> {
    const [west, south, east, north] = bounds;
    const minLatCell = toLatCell(south);
    const maxLatCell = toLatCell(north);
    const lonRanges: (readonly [number, number])[] =
      west <= east
        ? [[toLonCell(west), toLonCell(east)]]
        : [
            [toLonCell(west), lonCells - 1],
            [0, toLonCell(east)],
          ];
    if (east === 180) lonRanges.push([0, 0]);
    const seen = new Set<T>();
    const cellCount = (maxLatCell - minLatCell + 1)
      * lonRanges.reduce((total, [min, max]) => total + max - min + 1, 0);
    // Sparse or very fine grids should inspect occupied cells, not billions of empty cells.
    if (cellCount > buckets.size) {
      for (const [key, bucket] of buckets) {
        const latCell = Math.floor(key / lonCells);
        const lonCell = key % lonCells;
        if (latCell < minLatCell || latCell > maxLatCell
          || !lonRanges.some(([min, max]) => lonCell >= min && lonCell <= max)) continue;
        for (const item of bucket) seen.add(item);
      }
      return seen;
    }
    for (let latCell = minLatCell; latCell <= maxLatCell; latCell += 1) {
      for (const [minLonCell, maxLonCell] of lonRanges) {
        for (let lonCell = minLonCell; lonCell <= maxLonCell; lonCell += 1) {
          const bucket = buckets.get(cellKey(latCell, lonCell));
          if (!bucket) continue;
          for (const item of bucket) seen.add(item);
        }
      }
    }
    return seen;
  }

  return {
    size: validItems.length,
    all: () => validItems,
    queryBounds(bounds: Bounds): T[] {
      if (!validBounds(bounds)) return [];
      const candidates = collectBoundsCandidates(bounds);
      const matches: T[] = [];
      for (const item of candidates) {
        if (containsPoint(bounds, item)) matches.push(item);
      }
      return matches;
    },
    queryRadius(center: Position, radiusKm: number, limit?: number): NearbyMatch<T>[] {
      if (!validPosition(center) || !Number.isFinite(radiusKm) || radiusKm < 0) return [];
      if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) return [];
      const angularRadius = Math.min(radiusKm / EARTH_RADIUS_KM, Math.PI);
      const dLat = angularRadius * RADIANS_TO_DEGREES;
      // Padding makes candidate selection conservative at floating-point cell
      // boundaries. The distance check below still decides exact membership.
      const south = clamp(center.latitude - dLat - BOUNDS_PADDING_DEGREES, -90, 90);
      const north = clamp(center.latitude + dLat + BOUNDS_PADDING_DEGREES, -90, 90);
      let bounds: Bounds;
      if (south === -90 || north === 90) {
        bounds = [-180, south, 180, north];
      } else {
        const cosLat = Math.cos(center.latitude / RADIANS_TO_DEGREES);
        const dLon = Math.asin(Math.min(1, Math.sin(angularRadius) / cosLat)) * RADIANS_TO_DEGREES
          + BOUNDS_PADDING_DEGREES;
        bounds = [normalizeLongitude(center.longitude - dLon), south, normalizeLongitude(center.longitude + dLon), north];
      }

      const candidates = collectBoundsCandidates(bounds);
      const matches: NearbyMatch<T>[] = [];
      for (const item of candidates) {
        const d = distanceKm(center, item);
        if (d <= radiusKm) matches.push({ item, distanceKm: d });
      }
      matches.sort((a, b) => a.distanceKm - b.distanceKm);
      return limit === undefined ? matches : matches.slice(0, Math.floor(limit));
    },
  };
}
