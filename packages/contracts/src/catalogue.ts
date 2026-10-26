import { z } from 'zod';
import {
  capabilitiesSchema,
  directionArcSchema,
  type StationCapabilities,
} from '@azohra/meteo.station';
import type { DirectionArc } from '@azohra/meteo.core';
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
  'custom',
] as const;

export type StationVendor = (typeof STATION_VENDORS)[number];

export type StationLocatorValue = string | number | boolean;
export type StationLocator = Readonly<Record<string, StationLocatorValue>>;

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

const isoTimestampSchema = z.string().refine(value => Number.isFinite(Date.parse(value)), {
  message: 'expected an ISO-8601 timestamp',
});

const locatorValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

export const catalogueStationSchema: z.ZodType<CatalogueStation> = z
  .object({
    uid: z.string().min(3),
    vendor: z.enum(STATION_VENDORS),
    nativeId: z.string().min(1),
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
    locator: z.record(z.string(), locatorValueSchema),
  })
  .refine(station => station.uid === formatStationUid(station.vendor, station.nativeId), {
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
      byUid.set(candidate.uid, {
        ...existing,
        ...candidate,
        elevationM: candidate.elevationM ?? existing.elevationM,
        country: candidate.country ?? existing.country,
        region: candidate.region ?? existing.region,
        timeZone: candidate.timeZone ?? existing.timeZone,
        pageUrl: candidate.pageUrl ?? existing.pageUrl,
        declaredFavorableDirections:
          candidate.declaredFavorableDirections ?? existing.declaredFavorableDirections ?? null,
        locator: { ...existing.locator, ...candidate.locator },
      });
    }
  }
  return [...byUid.values()].sort((a, b) => a.uid.localeCompare(b.uid));
}
