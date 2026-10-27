import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
import { type Reading } from '@azohra/meteo.station';
import {
  fetchUpstreamText,
  logUpstreamFailure,
  type StationAdapterOptions,
  type StationConfigInput,
} from '@azohra/meteo.station/server';
import {
  formatStationUid,
  mergeCatalogueStations,
  type CatalogueStation,
  type StationVendor,
} from '@stations/contracts';
import {
  INITIAL_SCOPE_REGIONS,
  coversPoint,
  inferRegionCode,
  validPosition,
  REGIONS,
  type Coverage,
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import {
  finiteNumber,
  isRecentObservation,
  isRecord,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { defaultTimeZoneForPoint } from './region-hints.ts';
import { defineStationAdapter, resolveEnvironment } from './server.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

const coverage: Coverage = { kind: 'global' };
const ZEPHYR_CACHE_TTL_SECONDS = 300;

export const ZEPHYR_STATIONS_URL = 'https://api.zephyrapp.nz/stations';

/**
 * Zephyr `type` values owned by a working direct provider in this registry.
 * Omitted from Zephyr discovery so the direct feed remains primary; unwrap
 * still maps residual aggregator rows onto the direct UID for dedup.
 *
 * Intentionally not mapped (stay on Zephyr as the live path):
 * - `windy` — our windy provider is seed/token scoped and cannot discover NZ.
 * - `tempest` — needs per-station tokens; Zephyr is the reachable feed.
 * - council aliases (`gw`, `hbrc`, `tdc`, `envdata`) — Hilltop GetData is
 *   disabled from the crawl network (see hilltop.ts).
 */
export const ZEPHYR_DIRECT_TYPE_MAP: Readonly<
  Record<string, { vendor: StationVendor; normalizeId?: (id: string) => string }>
> = {
  wu: { vendor: 'wunderground' },
  holfuy: { vendor: 'holfuy' },
  windguru: { vendor: 'windguru' },
  wl: { vendor: 'weatherlink' },
};

export function parseZephyrStations(text: string, nowMs: number): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  const rows = Array.isArray(data) ? data : [];
  const stations: CatalogueStation[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row.isOffline === true) continue;
    const id = typeof row._id === 'string' ? row._id.trim() : '';
    if (!id) continue;
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name) continue;
    const loc =
      isRecord(row.location) && Array.isArray(row.location.coordinates)
        ? row.location.coordinates
        : null;
    if (!loc || loc.length < 2) continue;
    const longitude = finiteNumber(loc[0]);
    const latitude = finiteNumber(loc[1]);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) continue;
    const point = { latitude, longitude };
    if (!coversPoint(REGIONS.NZ.coverage, point)) continue;
    const lastUpdate = typeof row.lastUpdate === 'string' ? row.lastUpdate : null;
    if (!lastUpdate || !isRecentObservation(lastUpdate, nowMs)) continue;
    const type = typeof row.type === 'string' ? row.type.trim().toLowerCase() : '';
    // Unknown types stay. A fixed allow-list would drop new ports.
    if (type && Object.hasOwn(ZEPHYR_DIRECT_TYPE_MAP, type)) continue;
    const externalId = typeof row.externalId === 'string' ? row.externalId.trim() : null;
    const externalLink = typeof row.externalLink === 'string' ? row.externalLink.trim() : null;
    const elevationM = finiteNumber(row.elevation);

    stations.push({
      uid: formatStationUid('zephyr', id),
      vendor: 'zephyr',
      nativeId: id,
      name,
      latitude,
      longitude,
      elevationM,
      country: inferRegionCode(point, 'NZ'),
      region: null,
      timeZone: defaultTimeZoneForPoint(point) ?? 'Pacific/Auckland',
      pageUrl: externalLink || `https://zephyrapp.nz/?station=${encodeURIComponent(id)}`,
      // Only MetService rows are clearly synoptic; everything else is opaque PWS/club.
      category: type === 'metservice' ? 'synoptic' : 'pws',
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: false,
        history: false,
      },
      samplingWindowSeconds: 60,
      recommendedPollSeconds: ZEPHYR_CACHE_TTL_SECONDS,
      locator: {
        zephyrId: id,
        ...(type ? { zephyrType: type } : {}),
        ...(externalId ? { externalId } : {}),
        ...(externalLink ? { externalLink } : {}),
      },
    });
  }
  return stations;
}

/** Zephyr currentAverage / currentGust are km/h (documented by the Zephyr NZ API). */
export function parseZephyrObservation(text: string): Reading {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw new Error('Zephyr station payload is not an object');
  if (data.isOffline === true) throw new Error('Zephyr station is offline');
  if (data.isError === true) throw new Error('Zephyr station is in error');
  const lastUpdate = typeof data.lastUpdate === 'string' ? data.lastUpdate : null;
  if (!lastUpdate) throw new Error('Zephyr observation missing lastUpdate');
  const avgKmh = finiteNumber(data.currentAverage);
  if (avgKmh === null) throw new Error('Zephyr observation missing currentAverage');
  const gustKmh = finiteNumber(data.currentGust);
  const bearing = finiteNumber(data.currentBearing);
  const temperatureC = validTemperatureC(finiteNumber(data.currentTemperature) ?? Number.NaN);
  return {
    observedAt: new Date(lastUpdate).toISOString(),
    windAvgMps: plausibleWindMps(kmhToMps(avgKmh), 'Zephyr'),
    windDirectionDeg: bearing === null ? null : windDirection(bearing),
    windGustMps: gustKmh === null ? null : plausibleWindMps(kmhToMps(gustKmh), 'Zephyr'),
    windLullMps: null,
    temperatureC,
    windChillC: null,
    // Feed does not publish air conditions; do not invent emptyConditions().
    conditions: null,
  };
}

export type ZephyrStationConfig = { readonly station: CatalogueStation };
export type ZephyrAdapterOptions = StationAdapterOptions;

export const loadZephyrStation = defineStationAdapter<ZephyrStationConfig, ZephyrAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Zephyr NZ'),
  load: async ({ station }, { environment }) => {
    const url = new URL(`${ZEPHYR_STATIONS_URL}/${encodeURIComponent(station.nativeId)}`);
    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `zephyr/station/${station.nativeId}`,
      cacheTtlSeconds: ZEPHYR_CACHE_TTL_SECONDS,
      subject: `Zephyr station ${station.nativeId}`,
    });
    return { reading: parseZephyrObservation(text), history: null };
  },
});

export const zephyrProvider: StationNetworkProvider = {
  vendor: 'zephyr',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'zephyr');
    const batches: CatalogueStation[][] = [seeds];
    const regions = options.regions ?? INITIAL_SCOPE_REGIONS;
    if (options.includeRemoteDiscovery !== false && regions.includes('NZ')) {
      const environment = resolveEnvironment(options.environment);
      try {
        const text = await fetchUpstreamText(environment, {
          url: ZEPHYR_STATIONS_URL,
          cacheKey: 'zephyr/stations/all',
          cacheTtlSeconds: 900,
          subject: 'Zephyr NZ station index',
          limitBytes: 4 * 1024 * 1024,
        });
        batches.push(parseZephyrStations(text, environment.now().getTime()));
      } catch (error) {
        logUpstreamFailure(environment, 'Zephyr discovery failed', error);
      }
    }
    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadZephyrStation({ station }, { environment, historyHours, mode }),
    );
  },
};
