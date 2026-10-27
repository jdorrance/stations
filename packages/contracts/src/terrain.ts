import type { CatalogueStation } from './catalogue.ts';

/**
 * One-ring landform from an 8-direction DEM sample. A reduced geomorphon:
 * summit, ridge, slope, valley, or flat. Not GRASS `r.geomorphon`.
 * `flat` is the ~90 m DEM noise floor (30 m of range), not a mountain cutoff.
 */
export const LANDFORMS = ['summit', 'ridge', 'slope', 'valley', 'flat'] as const;

export type Landform = (typeof LANDFORMS)[number];

/** Neighborhood used for TPI and the landform ring. */
export const TERRAIN_RADIUS_M = 1000;

const FLAT_RANGE_M = 30;
const METERS_PER_DEGREE = 111_320;

export interface TerrainSample {
  readonly tpiM: number;
  readonly landform: Landform;
}

export function isLandform(value: unknown): value is Landform {
  return typeof value === 'string' && (LANDFORMS as readonly string[]).includes(value);
}

/** Center, then eight compass points clockwise from north. */
export function terrainRing(
  latitude: number,
  longitude: number,
  radiusM = TERRAIN_RADIUS_M,
): readonly { latitude: number; longitude: number }[] {
  const dLat = radiusM / METERS_PER_DEGREE;
  const dLon = radiusM / (METERS_PER_DEGREE * Math.cos((latitude * Math.PI) / 180));
  const ring = [{ latitude, longitude }];
  for (let step = 0; step < 8; step += 1) {
    const radians = (step * Math.PI) / 4;
    ring.push({
      latitude: latitude + dLat * Math.cos(radians),
      longitude: longitude + dLon * Math.sin(radians),
    });
  }
  return ring;
}

/**
 * `neighborsM` is eight elevations clockwise from north.
 * TPI is center minus the mean of that ring.
 */
export function classifyLandform(
  centerM: number,
  neighborsM: readonly number[],
): TerrainSample | null {
  if (neighborsM.length !== 8) return null;
  if (!Number.isFinite(centerM) || neighborsM.some(elevation => !Number.isFinite(elevation))) {
    return null;
  }
  const mean = neighborsM.reduce((sum, elevation) => sum + elevation, 0) / 8;
  const tpiM = Math.round(centerM - mean);
  const elevations = [centerM, ...neighborsM];
  const range = Math.max(...elevations) - Math.min(...elevations);
  if (range < FLAT_RANGE_M) return { tpiM, landform: 'flat' };

  const lower = neighborsM.filter(elevation => elevation < centerM).length;
  const higher = neighborsM.filter(elevation => elevation > centerM).length;
  if (higher === 0 && lower >= 6) return { tpiM, landform: 'summit' };

  for (let axis = 0; axis < 4; axis += 1) {
    const along = [neighborsM[axis]!, neighborsM[axis + 4]!];
    const flanks = [neighborsM[(axis + 2) % 8]!, neighborsM[(axis + 6) % 8]!];
    const flanksFall = flanks.every(elevation => elevation < centerM);
    const crestHolds = along.every(elevation => elevation > flanks[0]! && elevation > flanks[1]!);
    if (flanksFall && crestHolds) return { tpiM, landform: 'ridge' };
  }

  if (higher >= 6) return { tpiM, landform: 'valley' };
  return { tpiM, landform: 'slope' };
}

export function applyLandforms(
  stations: readonly CatalogueStation[],
  byUid: Readonly<Record<string, TerrainSample>>,
): CatalogueStation[] {
  return stations.map(station => {
    const sample = byUid[station.uid];
    if (!sample) return { ...station, landform: null, tpiM: null };
    return { ...station, landform: sample.landform, tpiM: sample.tpiM };
  });
}
