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

const KM_PER_DEG_LAT = 111.32;

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
  const validItems = items.filter(validPosition);
  const buckets = new Map<number, T[]>();

  const toLatCell = (lat: number): number =>
    clamp(Math.floor((lat + 90) / cellDegrees), 0, latCells - 1);
  const toLonCell = (lon: number): number =>
    clamp(Math.floor((normalizeLongitude(lon) + 180) / cellDegrees), 0, lonCells - 1);
  const cellKey = (latCell: number, lonCell: number): number => latCell * lonCells + lonCell;

  for (const item of validItems) {
    const key = cellKey(toLatCell(item.latitude), toLonCell(item.longitude));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  function collectBoundsCandidates(bounds: Bounds): Set<T> {
    const [west, south, east, north] = bounds;
    const minLatCell = toLatCell(south);
    const maxLatCell = toLatCell(north);
    const lonRanges: readonly (readonly [number, number])[] =
      west <= east
        ? [[toLonCell(west), toLonCell(east)]]
        : [
            [toLonCell(west), lonCells - 1],
            [0, toLonCell(east)],
          ];
    const seen = new Set<T>();
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
      const dLat = radiusKm / KM_PER_DEG_LAT;
      const south = clamp(center.latitude - dLat, -90, 90);
      const north = clamp(center.latitude + dLat, -90, 90);
      const cosLat = Math.cos((center.latitude * Math.PI) / 180);
      const dLon = cosLat <= 1e-4 ? 180 : radiusKm / (KM_PER_DEG_LAT * cosLat);
      const bounds: Bounds =
        dLon >= 180 || south <= -89.9 || north >= 89.9
          ? [-180, south, 180, north]
          : [normalizeLongitude(center.longitude - dLon), south, normalizeLongitude(center.longitude + dLon), north];

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
