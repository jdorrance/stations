import { z } from 'zod';
import {
  capabilitiesSchema,
  directionArcSchema,
  type StationCapabilities,
} from '@azohra/meteo.station';
import type { DirectionArc } from '@azohra/meteo.core';
import {
  bearingDeg,
  createSpatialIndex,
  distanceKm,
  validPosition,
  type Position,
} from '@stations/geography';
import { REGION_CODES, type RegionCode } from '@stations/geography/regions';
import type { Landform } from './terrain.ts';
import { LANDFORMS } from './terrain.ts';

/** Compact tile label for constrained UIs (XCTrack). At most 11 characters. */
export const SHORT_NAME_MAX_LENGTH = 11;

export const CATALOGUE_SCHEMA_VERSION = 1;

export const STATION_VENDORS = [
  'windnerd',
  'tempest',
  'ecowitt',
  'campbell',
  'openwindmap',
  'holfuy',
  'awc',
  'windsmobi',
  'windspion',
  'windguru',
  'windy',
  'weatherlink',
  'realtime_txt',
  'raws',
  'snotel',
  'avalanche',
  'iem',
  'nws',
  'eccc',
  'ndbc',
  'conagua',
  'cwop',
  'wunderground',
  'synoptic',
  'ambient',
  'climatenet',
  'hydromet_am',
  'custom',
] as const;

export type StationVendor = (typeof STATION_VENDORS)[number];

export const STATION_CATEGORIES = [
  'freeflight',
  'mountain',
  'synoptic',
  'marine',
  'pws',
] as const;

export type StationCategory = (typeof STATION_CATEGORIES)[number];

/**
 * Physical siting of the sensor. Orthogonal to {@link StationCategory}
 * (network / application role). Omit or null when unknown.
 */
export const STATION_PLACES = ['airport', 'mountain'] as const;

export type StationPlace = (typeof STATION_PLACES)[number];

export type StationLocatorValue = string | number | boolean;
export type StationLocator = Readonly<Record<string, StationLocatorValue>>;

export interface StationLaunchContext {
  readonly nearestLaunchSlug: string;
  readonly nearestLaunchName: string;
  readonly distanceKm: number;
  readonly bearingDeg: number;
}

export interface LaunchSite extends Position {
  readonly slug: string;
  readonly name: string;
}

export interface CatalogueStation {
  readonly uid: string;
  readonly vendor: StationVendor;
  readonly nativeId: string;
  readonly name: string;
  /**
   * Optional curated label for constrained UIs. When present, live feeds use it
   * as `Station.name`. At most {@link SHORT_NAME_MAX_LENGTH} characters.
   */
  readonly shortName?: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly elevationM: number | null;
  readonly country: RegionCode | null;
  readonly region: string | null;
  readonly timeZone: string | null;
  readonly pageUrl: string | null;
  readonly capabilities: StationCapabilities;
  readonly samplingWindowSeconds: number | null;
  readonly recommendedPollSeconds: number;
  readonly declaredFavorableDirections?: readonly DirectionArc[] | null;
  readonly category?: StationCategory | null;
  /** Aerodrome when inferred. `mountain` is an override only. */
  readonly place?: StationPlace | null;
  /** DEM landform at 1 km. See `LANDFORMS`. Null until terrain is applied. */
  readonly landform?: Landform | null;
  /** Center elevation minus the mean of the 1 km ring, in metres. */
  readonly tpiM?: number | null;
  readonly aliases?: readonly string[] | null;
  readonly launchContext?: StationLaunchContext | null;
  readonly locator: StationLocator;
}

/** Curated per-station fields applied after crawl merge. */
export interface StationOverride {
  readonly shortName?: string;
  readonly place?: StationPlace;
  readonly elevationM?: number;
  readonly region?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface StationOverridesDocument {
  readonly schemaVersion: 1;
  readonly stations: Readonly<Record<string, StationOverride>>;
}

export interface ApplyStationOverridesOptions {
  /** Called for each override key that matches no catalogue station (uid or alias). */
  readonly onUnmatched?: (uid: string) => void;
  /** Called when several alias keys match the same station with disagreeing values. */
  readonly onConflict?: (uid: string, matchedKeys: readonly string[]) => void;
}

export interface StationCatalogueDocument {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly regions: readonly RegionCode[];
  readonly stations: readonly CatalogueStation[];
}

export function isStationVendor(value: unknown): value is StationVendor {
  return typeof value === 'string' && (STATION_VENDORS as readonly string[]).includes(value);
}

export function isStationCategory(value: unknown): value is StationCategory {
  return typeof value === 'string' && (STATION_CATEGORIES as readonly string[]).includes(value);
}

export function isStationPlace(value: unknown): value is StationPlace {
  return typeof value === 'string' && (STATION_PLACES as readonly string[]).includes(value);
}

const AIRPORT_NAME_RE = /\b(?:airport|airfield|airstrip)\b/i;

/**
 * Infer an aerodrome when the network or the name says so. Does not assign
 * `mountain`. Terrain class is a DEM landform, not an elevation cutoff.
 */
export function defaultPlaceForStation(
  station: Pick<CatalogueStation, 'vendor' | 'name' | 'locator'>,
): StationPlace | null {
  const network =
    typeof station.locator.network === 'string' ? station.locator.network : '';
  const iemAsos =
    station.vendor === 'iem' &&
    network.length > 0 &&
    !network.endsWith('_DCP') &&
    !network.endsWith('_RWIS') &&
    network !== 'USCRN';
  if (
    station.vendor === 'awc' ||
    iemAsos ||
    AIRPORT_NAME_RE.test(station.name)
  ) {
    return 'airport';
  }
  return null;
}

export function defaultCategoryForVendor(vendor: StationVendor): StationCategory {
  switch (vendor) {
    case 'windnerd':
    case 'openwindmap':
    case 'holfuy':
    case 'windsmobi':
    case 'windspion':
    case 'windguru':
    case 'campbell':
    case 'realtime_txt':
      return 'freeflight';
    case 'raws':
    case 'snotel':
    case 'avalanche':
      return 'mountain';
    case 'ndbc':
      return 'marine';
    case 'awc':
    case 'iem':
    case 'nws':
    case 'eccc':
    case 'conagua':
    case 'hydromet_am':
    case 'synoptic':
      return 'synoptic';
    case 'tempest':
    case 'ecowitt':
    case 'weatherlink':
    case 'windy':
    case 'cwop':
    case 'wunderground':
    case 'ambient':
    case 'climatenet':
    case 'custom':
      return 'pws';
  }
}

export function formatStationUid(vendor: StationVendor, nativeId: string | number): string {
  const cleaned = String(nativeId).trim();
  if (!cleaned) throw new Error(`nativeId for vendor "${vendor}" must not be empty`);
  return `${vendor}:${cleaned}`;
}

export function parseStationUid(uid: string): { vendor: StationVendor; nativeId: string } | null {
  const colon = uid.indexOf(':');
  if (colon <= 0 || colon === uid.length - 1) return null;
  const vendor = uid.slice(0, colon);
  const nativeId = uid.slice(colon + 1).trim();
  if (!isStationVendor(vendor) || !nativeId) return null;
  return { vendor, nativeId };
}

const isoTimestampSchema = z.iso.datetime({ offset: true });

const locatorValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const stationLaunchContextSchema: z.ZodType<StationLaunchContext> = z.object({
  nearestLaunchSlug: z.string().min(1),
  nearestLaunchName: z.string().min(1),
  distanceKm: z.number().finite().min(0),
  bearingDeg: z.number().finite().min(0).lt(360),
});

const shortNameSchema = z.string().trim().min(1).max(SHORT_NAME_MAX_LENGTH);

export const catalogueStationSchema: z.ZodType<CatalogueStation> = z
  .object({
    uid: z.string().min(3),
    vendor: z.enum(STATION_VENDORS),
    nativeId: z.string().trim().min(1),
    name: z.string().min(1),
    shortName: shortNameSchema.nullish(),
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    elevationM: z.number().finite().nullable(),
    country: z.enum(REGION_CODES).nullable(),
    region: z.string().min(1).nullable(),
    timeZone: z.string().min(1).nullable(),
    pageUrl: z.string().min(1).nullable(),
    capabilities: capabilitiesSchema,
    samplingWindowSeconds: z.number().finite().positive().nullable(),
    recommendedPollSeconds: z.number().finite().positive(),
    declaredFavorableDirections: z.array(directionArcSchema).nullish(),
    category: z.enum(STATION_CATEGORIES).nullish(),
    place: z.enum(STATION_PLACES).nullish(),
    landform: z.enum(LANDFORMS).nullish(),
    tpiM: z.number().finite().nullable().optional(),
    aliases: z.array(z.string().refine(uid => {
      const parsed = parseStationUid(uid);
      return parsed !== null && uid === `${parsed.vendor}:${parsed.nativeId}`;
    }, { message: 'expected a canonical station UID' })).nullish(),
    launchContext: stationLaunchContextSchema.nullish(),
    locator: z.record(z.string(), locatorValueSchema),
  })
  .refine(station => station.uid === `${station.vendor}:${station.nativeId}`, {
    message: 'uid must match `${vendor}:${nativeId}`',
    path: ['uid'],
  });

export const stationCatalogueSchema: z.ZodType<StationCatalogueDocument> = z.object({
  schemaVersion: z.literal(CATALOGUE_SCHEMA_VERSION),
  generatedAt: isoTimestampSchema,
  regions: z.array(z.enum(REGION_CODES)),
  stations: z.array(catalogueStationSchema),
});

const stationOverrideSchema: z.ZodType<StationOverride> = z
  .object({
    shortName: shortNameSchema.optional(),
    place: z.enum(STATION_PLACES).optional(),
    elevationM: z.number().finite().optional(),
    region: z.string().min(1).optional(),
    latitude: z.number().finite().min(-90).max(90).optional(),
    longitude: z.number().finite().min(-180).max(180).optional(),
  })
  .refine(
    override => (override.latitude === undefined) === (override.longitude === undefined),
    { message: 'latitude and longitude must be supplied together' },
  )
  .refine(
    override =>
      override.latitude === undefined ||
      validPosition({ latitude: override.latitude, longitude: override.longitude! }),
    { message: 'latitude and longitude must form a valid position' },
  );

const stationUidKeySchema = z.string().refine(uid => {
  const parsed = parseStationUid(uid);
  return parsed !== null && uid === `${parsed.vendor}:${parsed.nativeId}`;
}, { message: 'expected a canonical station UID' });

export const stationOverridesSchema: z.ZodType<StationOverridesDocument> = z.object({
  schemaVersion: z.literal(1),
  stations: z.record(stationUidKeySchema, stationOverrideSchema),
});

export function parseStationOverrides(value: unknown): StationOverridesDocument {
  return stationOverridesSchema.parse(value) as StationOverridesDocument;
}

function applyOneOverride(
  station: CatalogueStation,
  override: StationOverride,
): CatalogueStation {
  let next: CatalogueStation = station;
  if (override.shortName !== undefined) {
    next = { ...next, shortName: override.shortName };
  }
  if (override.place !== undefined) {
    next = { ...next, place: override.place };
  }
  if (override.elevationM !== undefined && next.elevationM === null) {
    next = { ...next, elevationM: override.elevationM };
  }
  if (override.region !== undefined && next.region === null) {
    next = { ...next, region: override.region };
  }
  // Catalogue stations always carry a position today; fill only if one is invalid.
  if (
    override.latitude !== undefined &&
    override.longitude !== undefined &&
    !validPosition({ latitude: next.latitude, longitude: next.longitude })
  ) {
    next = { ...next, latitude: override.latitude, longitude: override.longitude };
  }
  return next;
}

/**
 * Stamps curated short names, place, and fill-only elevation/region/position
 * onto merged catalogue stations. Direct UID wins over aliases. Unmatched keys
 * and disagreeing alias hits are reported through the optional callbacks.
 */
export function applyStationOverrides(
  stations: readonly CatalogueStation[],
  overrides: StationOverridesDocument,
  options: ApplyStationOverridesOptions = {},
): CatalogueStation[] {
  const usedKeys = new Set<string>();
  const result = stations.map(station => {
    const direct = overrides.stations[station.uid];
    if (direct !== undefined) {
      usedKeys.add(station.uid);
      return applyOneOverride(station, direct);
    }

    const matchedKeys: string[] = [];
    for (const alias of station.aliases ?? []) {
      if (Object.hasOwn(overrides.stations, alias)) matchedKeys.push(alias);
    }
    if (matchedKeys.length === 0) return station;

    const first = overrides.stations[matchedKeys[0]!]!;
    const firstJson = JSON.stringify(first);
    const conflict = matchedKeys.some(
      key => JSON.stringify(overrides.stations[key]) !== firstJson,
    );
    if (conflict) {
      options.onConflict?.(station.uid, matchedKeys);
      return station;
    }
    for (const key of matchedKeys) usedKeys.add(key);
    return applyOneOverride(station, first);
  });

  for (const key of Object.keys(overrides.stations)) {
    if (!usedKeys.has(key)) options.onUnmatched?.(key);
  }
  return result;
}

export function parseCatalogueStation(value: unknown): CatalogueStation | null {
  const parsed = catalogueStationSchema.safeParse(value);
  return parsed.success ? (parsed.data as CatalogueStation) : null;
}

export function parseStationCatalogue(value: unknown): StationCatalogueDocument | null {
  const parsed = stationCatalogueSchema.safeParse(value);
  return parsed.success ? (parsed.data as StationCatalogueDocument) : null;
}

export function parseStationCatalogueJson(json: string): StationCatalogueDocument | null {
  try {
    return parseStationCatalogue(JSON.parse(json));
  } catch {
    return null;
  }
}

function compareAscii(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function mergeTwoStations(
  primary: CatalogueStation,
  secondary: CatalogueStation,
): CatalogueStation {
  const sameSite = distanceKm(primary, secondary) <= 50;
  const aliasSet = new Set<string>([
    ...(primary.aliases ?? []),
    ...(secondary.aliases ?? []),
  ]);
  if (secondary.uid !== primary.uid) aliasSet.add(secondary.uid);
  aliasSet.delete(primary.uid);
  const aliases = aliasSet.size > 0 ? [...aliasSet].sort(compareAscii) : primary.aliases ?? undefined;
  const declaredFavorableDirections =
    primary.declaredFavorableDirections ??
    (sameSite ? secondary.declaredFavorableDirections : null) ??
    undefined;
  const launchContext =
    primary.launchContext ?? (sameSite ? secondary.launchContext : null) ?? undefined;
  const category = primary.category ?? secondary.category ?? undefined;
  const place = primary.place ?? secondary.place ?? undefined;
  const shortName = primary.shortName ?? secondary.shortName ?? undefined;

  return {
    ...secondary,
    ...primary,
    elevationM: primary.elevationM ?? (sameSite ? secondary.elevationM : null),
    country: primary.country ?? (sameSite ? secondary.country : null),
    region: primary.region ?? (sameSite ? secondary.region : null),
    timeZone: primary.timeZone ?? (sameSite ? secondary.timeZone : null),
    pageUrl: primary.pageUrl ?? secondary.pageUrl,
    ...(category !== undefined ? { category } : {}),
    ...(place !== undefined ? { place } : {}),
    ...(shortName !== undefined ? { shortName } : {}),
    ...(declaredFavorableDirections !== undefined ? { declaredFavorableDirections } : {}),
    ...(launchContext !== undefined ? { launchContext } : {}),
    ...(aliases !== undefined ? { aliases } : {}),
    locator: primary.uid === secondary.uid
      ? { ...secondary.locator, ...primary.locator }
      : { ...primary.locator },
  };
}

/**
 * Deduplicates and merges catalogue entries by `uid` (deterministic sort by `uid`),
 * preferring non-null metadata fields from later entries when enriching seeds.
 */
export function mergeCatalogueStations(
  batches: readonly (readonly CatalogueStation[])[],
): CatalogueStation[] {
  const byUid = new Map<string, CatalogueStation>();
  for (const batch of batches) {
    for (const candidate of batch) {
      const existing = byUid.get(candidate.uid);
      if (!existing) {
        byUid.set(candidate.uid, candidate);
        continue;
      }
      byUid.set(candidate.uid, mergeTwoStations(candidate, existing));
    }
  }
  return [...byUid.values()].sort((a, b) => compareAscii(a.uid, b.uid));
}

const VENDOR_PRIORITY: Readonly<Record<StationVendor, number>> = {
  windnerd: 100,
  holfuy: 98,
  openwindmap: 96,
  campbell: 95,
  realtime_txt: 94,
  tempest: 92,
  ecowitt: 90,
  weatherlink: 88,
  windguru: 86,
  raws: 84,
  snotel: 82,
  avalanche: 80,
  ndbc: 78,
  eccc: 76,
  conagua: 74,
  hydromet_am: 73,
  awc: 72,
  iem: 70,
  nws: 68,
  climatenet: 66,
  cwop: 64,
  windy: 62,
  wunderground: 60,
  synoptic: 58,
  ambient: 56,
  windsmobi: 40,
  windspion: 35,
  custom: 20,
};

function stationPriority(station: CatalogueStation): number {
  if (station.vendor === 'avalanche' && /^mesowest-/i.test(station.nativeId)) {
    return VENDOR_PRIORITY.synoptic - 1;
  }
  return VENDOR_PRIORITY[station.vendor];
}

function canonicalStationCode(station: CatalogueStation): string | null {
  const icao =
    typeof station.locator.icaoId === 'string'
      ? station.locator.icaoId.trim().toUpperCase()
      : null;
  if (icao && /^[A-Z0-9]{4}$/.test(icao)) return `icao:${icao}`;

  if (
    (station.vendor === 'awc' || station.vendor === 'nws' || station.vendor === 'eccc') &&
    /^[A-Z][A-Z0-9]{3}$/.test(station.nativeId.toUpperCase())
  ) {
    return `icao:${station.nativeId.toUpperCase()}`;
  }
  if (station.vendor === 'iem') {
    // IEM IDs are also used by non-airport networks and are not all ICAO identifiers.
    if (typeof station.locator.network === 'string'
      && !/(?:^|_)ASOS$/i.test(station.locator.network)) return null;
    const id = (typeof station.locator.stationId === 'string'
      ? station.locator.stationId
      : station.nativeId).trim().toUpperCase();
    if (/^[A-Z0-9]{3}$/.test(id) && station.country === 'US') {
      return `icao:K${id}`;
    }
    if (/^[A-Z][A-Z0-9]{3}$/.test(id)) {
      return `icao:${id}`;
    }
  }
  const nwsId =
    typeof station.locator.nwsId === 'string'
      ? station.locator.nwsId.trim().toUpperCase()
      : null;
  if (nwsId && /^[A-Z0-9]{5}$/.test(nwsId)) return `nwsli:${nwsId}`;

  const mesoWestId =
    typeof station.locator.mesoWestId === 'string'
      ? station.locator.mesoWestId.trim().toUpperCase()
      : station.vendor === 'synoptic' && station.locator.mnetId === '2'
        ? station.nativeId.trim().toUpperCase()
        : null;
  if (mesoWestId && /^[A-Z0-9]{4,8}$/.test(mesoWestId)) return `mesowest:${mesoWestId}`;

  return null;
}

function normalizeStationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * Cross-network deduplicator that merges identical stations across overlapping feeds
 * (e.g. `awc:KSEA` + `nws:KSEA` + `iem:WA_ASOS:SEA`, or `holfuy:1652` + `windsmobi:holfuy-1652`),
 * retaining the highest-priority direct provider as primary and recording secondary UIDs in `aliases`.
 */
export function deduplicateCatalogueStations(
  stations: readonly CatalogueStation[],
): CatalogueStation[] {
  const uniqueByUid = mergeCatalogueStations([stations]);
  const sorted = [...uniqueByUid].sort(
    (a, b) =>
      stationPriority(b) - stationPriority(a) ||
      compareAscii(a.uid, b.uid),
  );

  // Build identity components before merging so aliases can bridge stations
  // discovered in any order, including two feeds sharing a third-party alias.
  const parents = sorted.map((_station, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]!]!;
      index = parents[index]!;
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const a = root(left);
    const b = root(right);
    parents[Math.max(a, b)] = Math.min(a, b);
  };
  const byIdentity = new Map<string, number>();
  const byCanonicalCode = new Map<string, number[]>();
  const byName = new Map<string, number[]>();

  for (let index = 0; index < sorted.length; index += 1) {
    const candidate = sorted[index]!;
    for (const identity of [candidate.uid, ...(candidate.aliases ?? [])]) {
      const existing = byIdentity.get(identity);
      if (existing !== undefined) union(index, existing);
      else byIdentity.set(identity, index);
    }
    const code = canonicalStationCode(candidate);
    if (code !== null) {
      const matches = byCanonicalCode.get(code) ?? [];
      for (const previous of matches) {
        if (distanceKm(sorted[previous]!, candidate) <= 5) union(index, previous);
      }
      matches.push(index);
      byCanonicalCode.set(code, matches);
    }
    // Compare only equal names, rather than scanning the entire catalogue.
    const name = normalizeStationName(candidate.name);
    if (name.length >= 4) {
      const matches = byName.get(name) ?? [];
      for (const previous of matches) {
        const existing = sorted[previous]!;
        if (existing.vendor !== candidate.vendor && distanceKm(existing, candidate) <= 0.06) {
          union(index, previous);
        }
      }
      matches.push(index);
      byName.set(name, matches);
    }
  }

  const merged = new Map<number, CatalogueStation>();
  for (let index = 0; index < sorted.length; index += 1) {
    const identity = root(index);
    const candidate = sorted[index]!;
    const primary = merged.get(identity);
    merged.set(identity, primary ? mergeTwoStations(primary, candidate) : candidate);
  }
  return [...merged.values()]
    .map(station => {
      const category = station.category ?? defaultCategoryForVendor(station.vendor);
      const place = station.place ?? defaultPlaceForStation(station) ?? undefined;
      return {
        ...station,
        category,
        ...(place !== undefined ? { place } : {}),
      };
    })
    .sort((a, b) => compareAscii(a.uid, b.uid));
}

/**
 * Attaches `launchContext` (`nearestLaunchSlug`, `nearestLaunchName`, `distanceKm`, `bearingDeg`)
 * to every station within `maxDistanceKm` of a known free-flight launch.
 * Replaces prior contexts; bearing is from the launch to the station.
 */
export function enrichStationsWithLaunches(
  stations: readonly CatalogueStation[],
  launches: readonly LaunchSite[],
  maxDistanceKm = 50,
): CatalogueStation[] {
  if (!Number.isFinite(maxDistanceKm) || maxDistanceKm < 0) {
    throw new RangeError('maxDistanceKm must be a finite, non-negative number');
  }
  const launchIndex = createSpatialIndex(launches, 1);

  return stations.map(station => {
    const nearest = launchIndex.queryRadius(station, maxDistanceKm, 1)[0];
    if (!nearest) return { ...station, launchContext: null };
    const dist = Math.round(nearest.distanceKm * 100) / 100;
    const brg = Math.round(bearingDeg(nearest.item, station)) % 360;
    return {
      ...station,
      launchContext: {
        nearestLaunchSlug: nearest.item.slug,
        nearestLaunchName: nearest.item.name,
        distanceKm: dist,
        bearingDeg: brg,
      },
    };
  });
}
