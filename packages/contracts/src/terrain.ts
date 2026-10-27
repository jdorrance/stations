import type { CatalogueStation } from './catalogue.ts';

/**
 * Landform from two DEM rings. The 1 km ring is the local shape. The 5 km
 * ring is where that shape sits on the surrounding terrain. A lower flank
 * under a nearby summit is a slope, not a valley.
 * Not GRASS `r.geomorphon`. `flat` is the DEM noise floor, not a height cutoff.
 */
export const LANDFORMS = ['summit', 'ridge', 'slope', 'valley', 'flat'] as const;

export type Landform = (typeof LANDFORMS)[number];

/** Local shape. */
export const TERRAIN_RADIUS_M = 1000;
/** Surrounding terrain. A mountainside is judged against this, not sea level. */
export const TERRAIN_CONTEXT_RADIUS_M = 5000;

const FLAT_RANGE_M = 30;
const FLAT_CONTEXT_SPAN_M = 80;
/** Share of the 5 km relief. Below this, a local low is a valley floor. */
const VALLEY_CONTEXT_RANK = 0.4;
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

function spanM(samples: readonly number[]): number {
  return Math.max(...samples) - Math.min(...samples);
}

/** 0 at the bottom of the sample, 1 at the top. A tight sample is mid-rank. */
function reliefRank(centerM: number, samples: readonly number[]): number {
  const low = Math.min(centerM, ...samples);
  const high = Math.max(centerM, ...samples);
  const span = high - low;
  if (span < FLAT_CONTEXT_SPAN_M) return 0.5;
  return (centerM - low) / span;
}

/**
 * `neighborsM` is the 1 km ring, eight elevations clockwise from north.
 * `contextM` is the 5 km ring in the same order. TPI is the 1 km value:
 * center minus the mean of that ring.
 * Without `contextM`, the 1 km ring is also the surrounding terrain.
 */
export function classifyLandform(
  centerM: number,
  neighborsM: readonly number[],
  contextM?: readonly number[],
): TerrainSample | null {
  if (neighborsM.length !== 8) return null;
  if (contextM !== undefined && contextM.length !== 8) return null;
  const context = contextM ?? neighborsM;
  if (
    !Number.isFinite(centerM) ||
    neighborsM.some(elevation => !Number.isFinite(elevation)) ||
    context.some(elevation => !Number.isFinite(elevation))
  ) {
    return null;
  }
  const mean = neighborsM.reduce((sum, elevation) => sum + elevation, 0) / 8;
  const tpiM = Math.round(centerM - mean);
  const range = spanM([centerM, ...neighborsM]);
  const rank = reliefRank(centerM, context);
  if (range < FLAT_RANGE_M) {
    if (spanM(context) < FLAT_CONTEXT_SPAN_M) return { tpiM, landform: 'flat' };
    return { tpiM, landform: rank < VALLEY_CONTEXT_RANK ? 'valley' : 'slope' };
  }

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

  if (higher >= 6) {
    return { tpiM, landform: rank < VALLEY_CONTEXT_RANK ? 'valley' : 'slope' };
  }
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
