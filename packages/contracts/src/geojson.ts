import {
  compassDirection,
  freshness,
  type FreshnessStatus,
  type FreshnessThresholds,
  type Station,
  type StationCapabilities,
  type StationFeed,
  type StationMeta,
  type UnavailableReason,
} from '@azohra/meteo.station';
import type { RegionCode } from '@stations/geography/regions';
import {
  defaultCategoryForVendor,
  parseStationUid,
  type CatalogueStation,
  type StationCategory,
  type StationVendor,
} from './catalogue.ts';

/**
 * Pilot-calibrated freshness thresholds for tactical free-flight decisions on launch or in the air:
 * - `freeflight` launch windtalkers: thermal cycles last 3–10 min and gust fronts arrive in 10–15 min.
 *   Readings are `live` up to 4 min (2 min for 30s sonic anemometers), `aging` up to 15 min (7.5 min for 30s),
 *   and `stale` beyond 15 min.
 * - `synoptic`, `pws`, and `marine` valley/coastal stations: `live` up to 10 min, `aging` up to 30 min,
 *   and `stale` beyond 30 min as daytime valley breeze and sea-breeze convergence evolve.
 * - `mountain` telemetry (RAWS / SNOTEL / Avalanche): `live` up to 15 min, `aging` up to 45 min,
 *   and `stale` beyond 45 min regardless of slower satellite/radio transmission schedules.
 */
export function pilotFreshnessThresholds(
  meta: Pick<StationMeta, 'recommendedPollSeconds'>,
  category: StationCategory = 'freeflight',
): FreshnessThresholds {
  if (category === 'freeflight') {
    const currentForMs = Math.min(
      300_000,
      Math.max(60_000, meta.recommendedPollSeconds * 4 * 1_000),
    );
    const staleAfterMs = Math.min(
      900_000,
      Math.max(450_000, Math.round(currentForMs * 3.75)),
    );
    return { currentForMs, staleAfterMs };
  }
  if (category === 'mountain') {
    return {
      currentForMs: 15 * 60_000,
      staleAfterMs: 45 * 60_000,
    };
  }
  return {
    currentForMs: 10 * 60_000,
    staleAfterMs: 30 * 60_000,
  };
}

export function pilotFreshness(
  input: {
    readonly observedAt: string;
    readonly servedAt: string;
    readonly receivedAtMs: number;
    readonly nowMs: number;
  },
  meta: Pick<StationMeta, 'recommendedPollSeconds'>,
  category: StationCategory = 'freeflight',
): FreshnessStatus {
  return freshness(input, pilotFreshnessThresholds(meta, category));
}

export interface StationFeatureProperties {
  readonly uid: string;
  readonly vendor: StationVendor | 'unknown';
  readonly category: StationCategory;
  readonly name: string;
  readonly sourceLabel: string;
  readonly elevationM: number | null;
  readonly country: RegionCode | null;
  readonly region: string | null;
  readonly pageUrl: string | null;
  readonly nearestLaunchSlug: string | null;
  readonly nearestLaunchDistanceKm: number | null;
  readonly status: 'catalogue' | 'ok' | 'unavailable';
  readonly freshness: FreshnessStatus | null;
  readonly unavailableReason: UnavailableReason | null;
  readonly observedAt: string | null;
  readonly windAvgMps: number | null;
  readonly windGustMps: number | null;
  readonly windLullMps: number | null;
  readonly windDirectionDeg: number | null;
  readonly windCompass: string | null;
  readonly temperatureC: number | null;
  readonly relativeHumidityPercent: number | null;
  readonly seaLevelPressureHpa: number | null;
  readonly capabilities: StationCapabilities;
}

export interface StationFeature {
  readonly type: 'Feature';
  readonly id: string;
  readonly geometry: {
    readonly type: 'Point';
    readonly coordinates:
      | readonly [longitude: number, latitude: number]
      | readonly [longitude: number, latitude: number, elevationM: number];
  };
  readonly properties: StationFeatureProperties;
}

export interface StationFeatureCollection {
  readonly type: 'FeatureCollection';
  readonly generatedAt: string;
  readonly features: readonly StationFeature[];
}

function pointCoordinates(
  longitude: number,
  latitude: number,
  elevationM: number | null,
): StationFeature['geometry']['coordinates'] {
  return elevationM !== null ? [longitude, latitude, elevationM] : [longitude, latitude];
}

export function catalogueToGeoJson(
  stations: readonly CatalogueStation[],
  generatedAt = new Date().toISOString(),
): StationFeatureCollection {
  const features: StationFeature[] = stations.map(station => ({
    type: 'Feature',
    id: station.uid,
    geometry: {
      type: 'Point',
      coordinates: pointCoordinates(station.longitude, station.latitude, station.elevationM),
    },
    properties: {
      uid: station.uid,
      vendor: station.vendor,
      category: station.category ?? defaultCategoryForVendor(station.vendor),
      name: station.name,
      sourceLabel: station.vendor,
      elevationM: station.elevationM,
      country: station.country,
      region: station.region,
      pageUrl: station.pageUrl,
      nearestLaunchSlug: station.launchContext?.nearestLaunchSlug ?? null,
      nearestLaunchDistanceKm: station.launchContext?.distanceKm ?? null,
      status: 'catalogue',
      freshness: null,
      unavailableReason: null,
      observedAt: null,
      windAvgMps: null,
      windGustMps: null,
      windLullMps: null,
      windDirectionDeg: null,
      windCompass: null,
      temperatureC: null,
      relativeHumidityPercent: null,
      seaLevelPressureHpa: null,
      capabilities: station.capabilities,
    },
  }));
  return {
    type: 'FeatureCollection',
    generatedAt,
    features,
  };
}

function stationToFeature(
  station: Station,
  servedAt: string,
  referenceMs: number,
  catalogueEntry?: CatalogueStation,
): StationFeature | null {
  const latitude = station.latitude ?? catalogueEntry?.latitude ?? null;
  const longitude = station.longitude ?? catalogueEntry?.longitude ?? null;
  if (latitude === null || longitude === null) return null;
  const elevationM = station.elevationM ?? catalogueEntry?.elevationM ?? null;
  const parsedUid = parseStationUid(station.id);
  const vendor = catalogueEntry?.vendor ?? parsedUid?.vendor ?? 'unknown';
  const category: StationCategory =
    catalogueEntry?.category ??
    (vendor === 'unknown' ? 'pws' : defaultCategoryForVendor(vendor));

  if (station.status === 'unavailable') {
    return {
      type: 'Feature',
      id: station.id,
      geometry: {
        type: 'Point',
        coordinates: pointCoordinates(longitude, latitude, elevationM),
      },
      properties: {
        uid: station.id,
        vendor,
        category,
        name: station.name,
        sourceLabel: station.sourceLabel,
        elevationM,
        country: catalogueEntry?.country ?? null,
        region: catalogueEntry?.region ?? null,
        pageUrl: station.pageUrl ?? catalogueEntry?.pageUrl ?? null,
        nearestLaunchSlug: catalogueEntry?.launchContext?.nearestLaunchSlug ?? null,
        nearestLaunchDistanceKm: catalogueEntry?.launchContext?.distanceKm ?? null,
        status: 'unavailable',
        freshness: null,
        unavailableReason: station.reason,
        observedAt: null,
        windAvgMps: null,
        windGustMps: null,
        windLullMps: null,
        windDirectionDeg: null,
        windCompass: null,
        temperatureC: null,
        relativeHumidityPercent: null,
        seaLevelPressureHpa: null,
        capabilities: station.capabilities,
      },
    };
  }

  const { reading } = station;
  const dir = reading.windDirectionDeg;
  const statusFreshness = pilotFreshness(
    {
      observedAt: reading.observedAt,
      servedAt,
      receivedAtMs: referenceMs,
      nowMs: referenceMs,
    },
    station,
    category,
  );

  return {
    type: 'Feature',
    id: station.id,
    geometry: {
      type: 'Point',
      coordinates: pointCoordinates(longitude, latitude, elevationM),
    },
    properties: {
      uid: station.id,
      vendor,
      category,
      name: station.name,
      sourceLabel: station.sourceLabel,
      elevationM,
      country: catalogueEntry?.country ?? null,
      region: catalogueEntry?.region ?? null,
      pageUrl: station.pageUrl ?? catalogueEntry?.pageUrl ?? null,
      nearestLaunchSlug: catalogueEntry?.launchContext?.nearestLaunchSlug ?? null,
      nearestLaunchDistanceKm: catalogueEntry?.launchContext?.distanceKm ?? null,
      status: 'ok',
      freshness: statusFreshness,
      unavailableReason: null,
      observedAt: reading.observedAt,
      windAvgMps: reading.windAvgMps,
      windGustMps: reading.windGustMps,
      windLullMps: reading.windLullMps,
      windDirectionDeg: dir,
      windCompass: dir === null ? null : compassDirection(dir),
      temperatureC: reading.temperatureC,
      relativeHumidityPercent: reading.conditions?.relativeHumidityPercent ?? null,
      seaLevelPressureHpa: reading.conditions?.seaLevelPressureHpa ?? null,
      capabilities: station.capabilities,
    },
  };
}

export function feedToGeoJson(
  feed: StationFeed,
  catalogueByUid?: ReadonlyMap<string, CatalogueStation>,
): StationFeatureCollection {
  const servedAtMs = Date.parse(feed.servedAt);
  const referenceMs = Number.isFinite(servedAtMs) ? servedAtMs : Date.now();
  const features: StationFeature[] = [];
  for (const station of feed.stations) {
    const feature = stationToFeature(
      station,
      feed.servedAt,
      referenceMs,
      catalogueByUid?.get(station.id),
    );
    if (feature) features.push(feature);
  }
  return {
    type: 'FeatureCollection',
    generatedAt: feed.servedAt,
    features,
  };
}
