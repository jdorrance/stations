import { validPosition, type Bounds, type Coverage, type Position } from './index.ts';

export const REGION_CODES = ['US', 'CA', 'MX', 'AM'] as const;
export type RegionCode = (typeof REGION_CODES)[number];

export const NORTH_AMERICA_REGIONS: readonly RegionCode[] = ['US', 'CA', 'MX'];
export const INITIAL_SCOPE_REGIONS: readonly RegionCode[] = ['US', 'CA', 'MX', 'AM'];

export interface RegionDescriptor {
  readonly code: RegionCode;
  readonly name: string;
  /** Representative display default; not the time zone of every station in the region. */
  readonly defaultTimeZone: string;
  readonly envelope: Bounds;
  /** Coarse discovery coverage; not a country boundary or proof of attribution. */
  readonly coverage: Coverage;
}

const US_CONUS_BOUNDS: Bounds = [-125.0, 24.39, -66.93, 49.38];
const US_ALASKA_BOUNDS: Bounds = [-179.15, 51.21, -129.97, 71.39];
const US_HAWAII_BOUNDS: Bounds = [-160.25, 18.91, -154.80, 22.24];
const US_CARIBBEAN_BOUNDS: Bounds = [-67.95, 17.62, -64.56, 18.52];

export const REGIONS: Readonly<Record<RegionCode, RegionDescriptor>> = {
  US: {
    code: 'US',
    name: 'United States',
    defaultTimeZone: 'America/New_York',
    envelope: [-179.15, 17.62, -64.56, 71.39],
    coverage: {
      kind: 'union',
      areas: [
        { kind: 'bounds', bounds: US_CONUS_BOUNDS },
        { kind: 'bounds', bounds: US_ALASKA_BOUNDS },
        { kind: 'bounds', bounds: US_HAWAII_BOUNDS },
        { kind: 'bounds', bounds: US_CARIBBEAN_BOUNDS },
      ],
    },
  },
  CA: {
    code: 'CA',
    name: 'Canada',
    defaultTimeZone: 'America/Toronto',
    envelope: [-141.0, 41.67, -52.62, 83.11],
    coverage: {
      kind: 'bounds',
      bounds: [-141.0, 41.67, -52.62, 83.11],
    },
  },
  MX: {
    code: 'MX',
    name: 'Mexico',
    defaultTimeZone: 'America/Mexico_City',
    envelope: [-118.45, 14.53, -86.70, 32.72],
    coverage: {
      kind: 'bounds',
      bounds: [-118.45, 14.53, -86.70, 32.72],
    },
  },
  AM: {
    code: 'AM',
    name: 'Armenia',
    defaultTimeZone: 'Asia/Yerevan',
    envelope: [43.44, 38.84, 46.63, 41.30],
    coverage: {
      kind: 'bounds',
      bounds: [43.44, 38.84, 46.63, 41.30],
    },
  },
};

export function isRegionCode(value: unknown): value is RegionCode {
  return typeof value === 'string' && (REGION_CODES as readonly string[]).includes(value);
}

export function regionDescriptor(code: RegionCode): RegionDescriptor {
  return REGIONS[code];
}

export function coverageForRegions(codes: readonly RegionCode[]): Coverage {
  if (codes.length === 1) return REGIONS[codes[0]!].coverage;
  return {
    kind: 'union',
    areas: codes.map(code => REGIONS[code].coverage),
  };
}

/**
 * Resolves a supported country from trusted upstream or curated metadata.
 * Coordinates alone cannot establish country membership: the regional coverage
 * rectangles are deliberately coarse and overlap neighboring countries.
 * Returns null without a supported explicit country hint or for invalid positions.
 */
export function inferRegionCode(point: Position, declaredCountry?: string | null): RegionCode | null {
  if (!validPosition(point)) return null;
  const normalized = declaredCountry?.trim().toUpperCase();
  return isRegionCode(normalized) ? normalized : null;
}

export function inRegion(code: RegionCode, point: Position, declaredCountry?: string | null): boolean {
  return inferRegionCode(point, declaredCountry) === code;
}
