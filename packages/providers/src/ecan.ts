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
  optionalWindMps,
  windDirection,
} from './observation-values.ts';
import { defaultTimeZoneForPoint } from './region-hints.ts';
import { defineStationAdapter, resolveEnvironment } from './server.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

const coverage: Coverage = { kind: 'global' };
const ECAN_CACHE_TTL_SECONDS = 300;

/** Environment Canterbury public ArcGIS wind-gauge layer. */
export const ECAN_WIND_LAYER_URL =
  'https://gis.ecan.govt.nz/arcgis/rest/services/Public/Wind_Gauge_Data/MapServer/0/query';

export function parseEcanWindFeatures(text: string, nowMs: number): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || !Array.isArray(data.features)) return [];
  const stations: CatalogueStation[] = [];
  for (const feature of data.features) {
    if (!isRecord(feature)) continue;
    const attrs = isRecord(feature.attributes) ? feature.attributes : null;
    const geometry = isRecord(feature.geometry) ? feature.geometry : null;
    if (!attrs || !geometry) continue;
    const name = typeof attrs.station === 'string' ? attrs.station.trim() : '';
    if (!name) continue;
    const latitude = finiteNumber(geometry.y);
    const longitude = finiteNumber(geometry.x);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) continue;
    if (!coversPoint(REGIONS.NZ.coverage, { latitude, longitude })) continue;

    const dateMs = finiteNumber(attrs.date_time);
    if (dateMs === null || !isRecentObservation(new Date(dateMs).toISOString(), nowMs)) continue;

    const point = { latitude, longitude };
    stations.push({
      uid: formatStationUid('ecan', name),
      vendor: 'ecan',
      nativeId: name,
      name: `${name} (ECan)`,
      latitude,
      longitude,
      elevationM: null,
      country: inferRegionCode(point, 'NZ'),
      // Host is Environment Canterbury; region label is owned by this feed, not inferred.
      region: 'Canterbury',
      timeZone: defaultTimeZoneForPoint(point) ?? 'Pacific/Auckland',
      pageUrl: 'https://www.ecan.govt.nz/',
      category: 'synoptic',
      capabilities: {
        gustLull: true,
        temperature: false,
        conditions: false,
        history: false,
      },
      samplingWindowSeconds: 600,
      recommendedPollSeconds: ECAN_CACHE_TTL_SECONDS,
      locator: {
        stationName: name,
        layerUrl: ECAN_WIND_LAYER_URL,
      },
    });
  }
  return stations;
}

/**
 * Parse a single ECan feature observation.
 * Prefer `windspeed_kph` / `windmax` as km/h when present; otherwise treat
 * `windspeed` / `windmax` as m/s (field names from the live ArcGIS layer).
 */
export function parseEcanObservation(text: string, stationName: string): Reading {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || !Array.isArray(data.features)) {
    throw new Error('ECan response missing features');
  }
  const feature = data.features.find(row => {
    if (!isRecord(row) || !isRecord(row.attributes)) return false;
    return row.attributes.station === stationName;
  });
  if (!feature || !isRecord(feature) || !isRecord(feature.attributes)) {
    throw new Error(`ECan station not found: ${stationName}`);
  }
  const attrs = feature.attributes;
  const dateMs = finiteNumber(attrs.date_time);
  if (dateMs === null) throw new Error('ECan observation missing date_time');
  const speedKmh = finiteNumber(attrs.windspeed_kph);
  const avgMps =
    speedKmh !== null
      ? optionalWindMps(kmhToMps(speedKmh))
      : optionalWindMps(finiteNumber(attrs.windspeed));
  if (avgMps === null) throw new Error('ECan observation missing wind speed');
  const gustRaw = finiteNumber(attrs.windmax);
  const gustMps =
    gustRaw === null
      ? null
      : speedKmh !== null
        ? optionalWindMps(kmhToMps(gustRaw))
        : optionalWindMps(gustRaw);
  return {
    observedAt: new Date(dateMs).toISOString(),
    windAvgMps: plausibleWindMps(avgMps, 'ECan'),
    windDirectionDeg: windDirection(finiteNumber(attrs.winddirection) ?? Number.NaN),
    windGustMps: gustMps === null ? null : plausibleWindMps(gustMps, 'ECan'),
    windLullMps: null,
    temperatureC: null,
    windChillC: null,
    conditions: null,
  };
}

export type EcanStationConfig = { readonly station: CatalogueStation };
export type EcanAdapterOptions = StationAdapterOptions;

export const loadEcanStation = defineStationAdapter<EcanStationConfig, EcanAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Environment Canterbury'),
  load: async ({ station }, { environment }) => {
    const url = new URL(ECAN_WIND_LAYER_URL);
    url.searchParams.set('where', `station='${station.nativeId.replace(/'/g, "''")}'`);
    url.searchParams.set('outFields', '*');
    url.searchParams.set('returnGeometry', 'true');
    url.searchParams.set('outSR', '4326');
    url.searchParams.set('f', 'json');
    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `ecan/station/${station.nativeId}`,
      cacheTtlSeconds: ECAN_CACHE_TTL_SECONDS,
      subject: `ECan wind gauge ${station.nativeId}`,
    });
    return { reading: parseEcanObservation(text, station.nativeId), history: null };
  },
});

export const ecanProvider: StationNetworkProvider = {
  vendor: 'ecan',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'ecan');
    const batches: CatalogueStation[][] = [seeds];
    const regions = options.regions ?? INITIAL_SCOPE_REGIONS;
    if (options.includeRemoteDiscovery !== false && regions.includes('NZ')) {
      const environment = resolveEnvironment(options.environment);
      try {
        const url = new URL(ECAN_WIND_LAYER_URL);
        url.searchParams.set('where', '1=1');
        url.searchParams.set('outFields', '*');
        url.searchParams.set('returnGeometry', 'true');
        url.searchParams.set('outSR', '4326');
        url.searchParams.set('f', 'json');
        const text = await fetchUpstreamText(environment, {
          url,
          cacheKey: 'ecan/wind/all',
          cacheTtlSeconds: 900,
          subject: 'ECan wind gauges',
          timeoutMs: 20_000,
        });
        batches.push(parseEcanWindFeatures(text, environment.now().getTime()));
      } catch (error) {
        logUpstreamFailure(environment, 'ECan discovery failed', error);
      }
    }
    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadEcanStation({ station }, { environment, historyHours, mode }),
    );
  },
};
