import { coversPoint, validPosition, type Bounds, type Coverage, type Position } from './index.ts';

export const REGION_CODES = ['US', 'CA', 'MX', 'AM'] as const;
export type RegionCode = (typeof REGION_CODES)[number];

export const NORTH_AMERICA_REGIONS: readonly RegionCode[] = ['US', 'CA', 'MX'];
export const INITIAL_SCOPE_REGIONS: readonly RegionCode[] = ['US', 'CA', 'MX', 'AM'];

export interface RegionDescriptor {
  readonly code: RegionCode;
  readonly name: string;
  readonly defaultTimeZone: string;
  readonly envelope: Bounds;
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

/** Piecewise latitude of the US-Mexico border for longitudes in [-117.2, -97.0]. */
function usMexicoBorderLatitude(longitude: number): number {
  const pts: readonly (readonly [number, number])[] = [
    [-117.12, 32.53],
    [-114.81, 32.49],
    [-111.07, 31.33],
    [-108.21, 31.33],
    [-106.53, 31.78],
    [-103.00, 28.99],
    [-101.40, 29.77],
    [-99.50, 27.50],
    [-97.14, 25.96],
  ];
  if (longitude <= pts[0]![0]) return pts[0]![1];
  if (longitude >= pts[pts.length - 1]![0]) return pts[pts.length - 1]![1];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const [lonA, latA] = pts[i]!;
    const [lonB, latB] = pts[i + 1]!;
    if (longitude >= lonA && longitude <= lonB) {
      const t = (longitude - lonA) / (lonB - lonA);
      return latA + t * (latB - latA);
    }
  }
  return 31.33;
}

/** Piecewise latitude of the US-Canada border for longitudes in [-141.0, -66.9]. */
function usCanadaBorderLatitude(longitude: number): number {
  if (longitude < -130.0) return 54.68; // Southern tip of Alaska Panhandle
  if (longitude < -123.25) return 48.45; // Strait of Juan de Fuca / Vancouver Island
  if (longitude < -95.15) return 49.0; // 49th parallel
  if (longitude < -82.4) return 46.5; // Upper Great Lakes
  if (longitude < -79.0) return 42.3; // Southern Ontario peninsula (Windsor/Erie/Ontario)
  if (longitude < -74.7) return 43.6; // Lake Ontario / St. Lawrence
  if (longitude < -71.0) return 45.0; // VT/NY - Quebec border
  return 47.3; // Maine - New Brunswick/Quebec
}

/**
 * Infers the RegionCode (`US`, `CA`, `MX`, `AM`) for a position.
 * If an explicit ISO country hint is valid and its coverage contains the point, it is preserved.
 */
export function inferRegionCode(point: Position, declaredCountry?: string | null): RegionCode | null {
  if (!validPosition(point)) return null;
  const normalized = declaredCountry?.trim().toUpperCase();
  if (normalized && isRegionCode(normalized) && coversPoint(REGIONS[normalized].coverage, point)) {
    return normalized;
  }
  if (coversPoint(REGIONS.AM.coverage, point)) return 'AM';
  const { latitude, longitude } = point;

  // Alaska, Hawaii, and US Caribbean
  if (coversPoint({ kind: 'bounds', bounds: US_HAWAII_BOUNDS }, point)) return 'US';
  if (coversPoint({ kind: 'bounds', bounds: US_CARIBBEAN_BOUNDS }, point)) return 'US';
  if (longitude <= -141.0 && coversPoint({ kind: 'bounds', bounds: US_ALASKA_BOUNDS }, point)) return 'US';
  if (longitude > -141.0 && longitude <= -129.97 && latitude >= 54.68 && latitude <= 60.0) {
    // Southeast Alaska panhandle vs BC/Yukon
    const panhandleEastLon = -130.0 - ((latitude - 54.68) / (60.0 - 54.68)) * 9.0;
    if (longitude <= panhandleEastLon) return 'US';
  }

  if (coversPoint(REGIONS.MX.coverage, point) && latitude < usMexicoBorderLatitude(longitude)) {
    return 'MX';
  }
  if (coversPoint(REGIONS.CA.coverage, point) && latitude >= usCanadaBorderLatitude(longitude)) {
    return 'CA';
  }
  if (coversPoint(REGIONS.US.coverage, point)) {
    return 'US';
  }
  if (coversPoint(REGIONS.CA.coverage, point)) return 'CA';
  if (coversPoint(REGIONS.MX.coverage, point)) return 'MX';
  return null;
}

export function inRegion(code: RegionCode, point: Position, declaredCountry?: string | null): boolean {
  return inferRegionCode(point, declaredCountry) === code;
}
