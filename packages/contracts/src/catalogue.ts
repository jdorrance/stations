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
  type Position,
} from '@stations/geography';
import { REGION_CODES, type RegionCode } from '@stations/geography/regions';

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
  readonly aliases?: readonly string[] | null;
  readonly launchContext?: StationLaunchContext | null;
  readonly locator: StationLocator;
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

export const catalogueStationSchema: z.ZodType<CatalogueStation> = z
  .object({
    uid: z.string().min(3),
    vendor: z.enum(STATION_VENDORS),
    nativeId: z.string().trim().min(1),
    name: z.string().min(1),
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

function mergeTwoStations(
  primary: CatalogueStation,
  secondary: CatalogueStation,
): CatalogueStation {
  const aliasSet = new Set<string>([
    ...(primary.aliases ?? []),
    ...(secondary.aliases ?? []),
  ]);
  if (secondary.uid !== primary.uid) aliasSet.add(secondary.uid);
  aliasSet.delete(primary.uid);
  const aliases = aliasSet.size > 0 ? [...aliasSet].sort() : primary.aliases ?? undefined;
  const declaredFavorableDirections =
    primary.declaredFavorableDirections ??
    secondary.declaredFavorableDirections ??
    undefined;
  const launchContext =
    primary.launchContext ?? secondary.launchContext ?? undefined;
  const category = primary.category ?? secondary.category ?? undefined;

  return {
    ...secondary,
    ...primary,
    elevationM: primary.elevationM ?? secondary.elevationM,
    country: primary.country ?? secondary.country,
    region: primary.region ?? secondary.region,
    timeZone: primary.timeZone ?? secondary.timeZone,
    pageUrl: primary.pageUrl ?? secondary.pageUrl,
    ...(category !== undefined ? { category } : {}),
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
  return [...byUid.values()].sort((a, b) => a.uid.localeCompare(b.uid));
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
      VENDOR_PRIORITY[b.vendor] - VENDOR_PRIORITY[a.vendor] ||
      a.uid.localeCompare(b.uid),
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
    .map(station => ({ ...station, category: station.category ?? defaultCategoryForVendor(station.vendor) }))
    .sort((a, b) => a.uid.localeCompare(b.uid));
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
