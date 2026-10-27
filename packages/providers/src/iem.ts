import {
  KNOTS_TO_MPS,
  fahrenheitToCelsius,
  finiteNumber,
  isRecentObservation,
  isRecord,
  optionalWindMps,
  pressureHpa,
  utcObservationTimeMs,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  type AirConditions,
  type Reading,
} from '@azohra/meteo.station';
import {
  logUpstreamFailure,
  type StationAdapterOptions,
  type StationConfigInput,
} from '@azohra/meteo.station/server';
import {
  defineStationAdapter,
  resolveEnvironment,
} from './server.ts';
import { fetchUpstreamText } from '@azohra/meteo.station/server';
import {
  formatStationUid,
  mergeCatalogueStations,
  type CatalogueStation,
} from '@stations/contracts';
import {
  INITIAL_SCOPE_REGIONS,
  inferRegionCode,
  validPosition,
  type Coverage,
  type RegionCode,
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

export const IEM_NETWORK_GEOJSON_BASE_URL =
  'https://mesonet.agron.iastate.edu/geojson/network';
export const IEM_CURRENTS_URL =
  'https://mesonet.agron.iastate.edu/api/1/currents.json';

const CACHE_TTL_SECONDS = 120;

export const US_STATE_CODES = [
  'AK', 'AL', 'AR', 'AZ', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD',
  'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH',
  'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'PR', 'RI',
  'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VT', 'WA', 'WI', 'WV', 'WY',
] as const;

export const CA_PROVINCE_CODES = [
  'AB', 'BC', 'MB', 'NB', 'NF', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
] as const;

export function iemNetworksForRegions(
  regions: readonly RegionCode[],
  includeDcp = true,
): string[] {
  const networks: string[] = [];
  for (const code of regions) {
    if (code === 'US') {
      if (includeDcp) networks.push('USCRN');
      for (const st of US_STATE_CODES) {
        networks.push(`${st}_ASOS`);
        if (includeDcp) {
          networks.push(`${st}_DCP`);
          networks.push(`${st}_RWIS`);
        }
      }
    } else if (code === 'CA') {
      for (const prov of CA_PROVINCE_CODES) {
        networks.push(`CA_${prov}_ASOS`);
      }
    } else if (code === 'MX') {
      networks.push('MX__ASOS');
    } else if (code === 'AM') {
      networks.push('AM__ASOS');
    }
  }
  return networks;
}

export type IemStationConfig = {
  readonly station: CatalogueStation;
};

export type IemAdapterOptions = StationAdapterOptions & {
  readonly currentsUrl?: string;
};

export function parseIemNetworkGeoJson(text: string, fallbackNetwork?: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || !Array.isArray(data.features)) {
    throw new Error('IEM network GeoJSON is missing features array');
  }
  const stations: CatalogueStation[] = [];
  for (const feature of data.features) {
    if (!isRecord(feature)) continue;
    const props = isRecord(feature.properties) ? feature.properties : {};
    const geom = isRecord(feature.geometry) ? feature.geometry : null;
    const coords = geom && Array.isArray(geom.coordinates) ? geom.coordinates : null;
    if (!coords || coords.length < 2) continue;

    const longitude = finiteNumber(coords[0]);
    const latitude = finiteNumber(coords[1]);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }

    const idRaw = feature.id ?? props.sid ?? props.id;
    if (typeof idRaw !== 'string' && typeof idRaw !== 'number') continue;
    if (props.online === false) continue;
    if (typeof props.archive_end === 'string' && props.archive_end.trim() !== '') continue;
    const stationId = String(idRaw).trim().toUpperCase();
    if (!stationId) continue;
    const network =
      typeof props.network === 'string' && props.network.trim()
        ? props.network.trim()
        : fallbackNetwork;
    if (!network) continue;
    // IEM identifiers are unique within a network, not across all networks.
    const nativeId = `${network}:${stationId}`;

    const declaredCountry = typeof props.country === 'string' ? props.country : null;
    const country = inferRegionCode({ latitude, longitude }, declaredCountry);
    const region =
      typeof props.state === 'string' && props.state.trim() ? props.state.trim() : null;
    const elevationM = finiteNumber(props.elevation);
    const tz =
      typeof props.tzname === 'string' && props.tzname.trim()
        ? props.tzname.trim()
        : null;
    const name =
      typeof props.sname === 'string' && props.sname.trim()
        ? props.sname.trim()
        : `IEM ${stationId}`;
    const isDcp = network.endsWith('_DCP') || network.endsWith('_RWIS') || network === 'USCRN';

    stations.push({
      uid: formatStationUid('iem', nativeId),
      vendor: 'iem',
      nativeId,
      name,
      latitude,
      longitude,
      elevationM: elevationM !== null ? Math.round(elevationM) : null,
      country,
      region,
      timeZone: tz,
      pageUrl: `https://mesonet.agron.iastate.edu/sites/site.php?station=${encodeURIComponent(stationId)}&network=${encodeURIComponent(network)}`,
      category: isDcp ? 'mountain' : 'synoptic',
      ...(isDcp ? {} : { place: 'airport' as const }),
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: true,
        history: false,
      },
      samplingWindowSeconds: isDcp ? 900 : 120,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationId,
        network,
      },
    });
  }
  return stations;
}

export function parseIemCurrentRow(row: unknown): { stationId: string; reading: Reading } | null {
  if (!isRecord(row)) return null;
  const stationId =
    typeof row.station === 'string'
      ? row.station.trim().toUpperCase()
      : typeof row.id === 'string'
        ? row.id.trim().toUpperCase()
        : null;
  if (!stationId) return null;

  const validRaw =
    typeof row.utc_valid === 'string'
      ? row.utc_valid
      : null;
  const observedAtMs = utcObservationTimeMs(validRaw);
  if (!Number.isFinite(observedAtMs)) return null;

  const sknt = finiteNumber(row.sknt);
  if (sknt === null || optionalWindMps(sknt * KNOTS_TO_MPS) === null) return null;
  const windAvgMps = plausibleWindMps(sknt * KNOTS_TO_MPS, 'IEM');

  const gustKt = finiteNumber(row.gust);
  const windGustMps =
    gustKt === null || gustKt < 0
      ? null
      : optionalWindMps(gustKt * KNOTS_TO_MPS);
  const drct = finiteNumber(row.drct);
  const tmpf = finiteNumber(row.tmpf);
  const dwpf = finiteNumber(row.dwpf);
  const relh = finiteNumber(row.relh);
  const mslp = finiteNumber(row.mslp);
  const srad = finiteNumber(row.srad);
  const pday = finiteNumber(row.pday);

  const seaLevelPressure = pressureHpa(mslp);

  const conditions: AirConditions = {
    ...emptyConditions(),
    dewPointC: validTemperatureC(dwpf === null ? null : fahrenheitToCelsius(dwpf)),
    relativeHumidityPercent: relh !== null && relh >= 0 && relh <= 100 ? relh : null,
    seaLevelPressureHpa:
      seaLevelPressure,
    solarRadiationWm2: srad !== null && srad >= 0 ? srad : null,
    precipitationTodayMm:
      pday !== null && pday >= 0 ? Math.round(pday * 25.4 * 10) / 10 : null,
  };

  return {
    stationId,
    reading: {
      observedAt: new Date(observedAtMs).toISOString(),
      windAvgMps,
      windDirectionDeg: isCalm(windAvgMps) || drct === null ? null : windDirection(drct),
      windGustMps,
      windLullMps: null,
      temperatureC: validTemperatureC(tmpf === null ? null : fahrenheitToCelsius(tmpf)),
      windChillC: null,
      conditions,
    },
  };
}

export function parseIemCurrentsResponse(text: string): Map<string, Reading> {
  const root: unknown = JSON.parse(text);
  const rows =
    isRecord(root) && Array.isArray(root.data)
      ? root.data
      : Array.isArray(root)
        ? root
        : [];
  const map = new Map<string, Reading>();
  for (const row of rows) {
    const parsed = parseIemCurrentRow(row);
    if (parsed && (!map.has(parsed.stationId) || Date.parse(map.get(parsed.stationId)!.observedAt) < Date.parse(parsed.reading.observedAt))) {
      map.set(parsed.stationId, parsed.reading);
    }
  }
  return map;
}

export const loadIemStation = defineStationAdapter<IemStationConfig, IemAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'IEM / ASOS-DCP'),
  load: async ({ station }, { environment, options }) => {
    const url = new URL(options.currentsUrl ?? IEM_CURRENTS_URL);
    const stationId = typeof station.locator.stationId === 'string' ? station.locator.stationId : station.nativeId.split(':').at(-1)!;
    url.searchParams.set('station', stationId);
    if (typeof station.locator.network === 'string') {
      url.searchParams.set('network', station.locator.network);
    }

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `iem/currents/${station.locator.network ?? ''}/${stationId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `IEM station ${station.nativeId}`,
    });

    const currents = parseIemCurrentsResponse(text);
    const reading = currents.get(stationId.toUpperCase());
    if (!reading) {
      throw new Error(`IEM returned no current observation for ${station.nativeId}`);
    }
    return {
      reading,
      history: null,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const iemProvider: StationNetworkProvider = {
  vendor: 'iem',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'iem');
    const batches: CatalogueStation[][] = [seeds];

    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      const regions = options.regions ?? INITIAL_SCOPE_REGIONS;
      const networks = iemNetworksForRegions(regions, true);
      const concurrency = 8;
      for (let i = 0; i < networks.length; i += concurrency) {
        const slice = networks.slice(i, i + concurrency);
        const loaded = await Promise.all(
          slice.map(async network => {
            try {
              const text = await fetchUpstreamText(environment, {
                url: `${IEM_NETWORK_GEOJSON_BASE_URL}/${encodeURIComponent(network)}.geojson`,
                cacheKey: `iem/network/${network}`,
                cacheTtlSeconds: 3_600,
                subject: `IEM network ${network}`,
                timeoutMs: 8_000,
                limitBytes: 4 * 1024 * 1024,
              });
              const candidates = parseIemNetworkGeoJson(text, network);
              if (candidates.length === 0) return [];
              try {
                const currentsUrl = new URL(IEM_CURRENTS_URL);
                currentsUrl.searchParams.set('network', network);
                const currentsText = await fetchUpstreamText(environment, {
                  url: currentsUrl,
                  cacheKey: `iem/network-currents/${network}`,
                  cacheTtlSeconds: 600,
                  subject: `IEM currents ${network}`,
                  timeoutMs: 10_000,
                  limitBytes: 6 * 1024 * 1024,
                });
                const currents = parseIemCurrentsResponse(currentsText);
                const nowMs = environment.now().getTime();
                return candidates.filter(station => {
                  const sid =
                    typeof station.locator.stationId === 'string'
                      ? station.locator.stationId.toUpperCase()
                      : station.nativeId.split(':').at(-1)!.toUpperCase();
                  const reading = currents.get(sid);
                  return (
                    reading !== undefined &&
                    isRecentObservation(reading.observedAt, nowMs)
                  );
                });
              } catch {
                return candidates;
              }
            } catch (error) {
              logUpstreamFailure(environment, 'IEM discovery failed', error);
              return [];
            }
          }),
        );
        for (const batch of loaded) batches.push(batch);
      }
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadIemStation({ station }, { environment, historyHours, mode }),
    );
  },
};
