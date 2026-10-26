import {
  finiteNumber,
  isRecord,
  observationTimeMs,
  optionalWindMps,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
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
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

export const ECCC_SWOB_STATIONS_URL =
  'https://api.weather.gc.ca/collections/swob-stations/items';
export const ECCC_SWOB_REALTIME_URL =
  'https://api.weather.gc.ca/collections/swob-realtime/items';

const CACHE_TTL_SECONDS = 300;

export type EcccStationConfig = {
  readonly station: CatalogueStation;
};

export type EcccAdapterOptions = StationAdapterOptions & {
  readonly realtimeUrl?: string;
};

export function parseEcccSwobStations(text: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || !Array.isArray(data.features)) {
    throw new Error('ECCC swob-stations response is missing features array');
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

    const iataRaw =
      typeof props.iata_id === 'string'
        ? props.iata_id.trim()
        : typeof props.icao_stn_id === 'string'
          ? props.icao_stn_id.trim()
          : null;
    const mscRaw =
      typeof props.msc_id === 'string' || typeof props.msc_id === 'number'
        ? String(props.msc_id).trim()
        : typeof feature.id === 'string'
          ? feature.id.trim()
          : null;
    const nativeId = (iataRaw || mscRaw || '').toUpperCase();
    if (!nativeId) continue;

    const country = inferRegionCode({ latitude, longitude }, 'CA');
    const elevationM = finiteNumber(props.elevation ?? coords[2]);
    const name =
      (typeof props.name === 'string' && props.name.trim()) ||
      (typeof props.stn_nam === 'string' && props.stn_nam.trim()) ||
      `ECCC ${nativeId}`;

    const icaoId =
      iataRaw && iataRaw.length === 3 ? `C${iataRaw.toUpperCase()}` : iataRaw || null;

    stations.push({
      uid: formatStationUid('eccc', nativeId),
      vendor: 'eccc',
      nativeId,
      name,
      latitude,
      longitude,
      elevationM: elevationM !== null ? Math.round(elevationM) : null,
      country,
      region: typeof props.province_territory === 'string' ? props.province_territory : typeof props.prov === 'string' ? props.prov : null,
      timeZone: null,
      pageUrl: 'https://api.weather.gc.ca/collections/swob-realtime',
      category: 'synoptic',
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: true,
        history: false,
      },
      samplingWindowSeconds: 600,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationId: nativeId,
        ...(icaoId ? { icaoId } : {}),
        ...(mscRaw ? { mscId: mscRaw } : {}),
      },
    });
  }
  return stations;
}

function swobWind(props: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber(props[key]);
    if (value === null || value < 0) continue;
    const unit = props[`${key}-uom`];
    const mps = unit === 'm/s' ? value : unit === 'knots' || unit === 'kt' ? value * 0.5144444444444445
      : unit === undefined || unit === 'km/h' ? kmhToMps(value) : NaN;
    const wind = optionalWindMps(mps);
    if (wind !== null) return wind;
  }
  return null;
}

const SWOB_AVERAGE_KEYS = ['avg_wnd_spd_10m_pst10mts', 'avg_wnd_spd_10m_pst2mts', 'avg_wnd_spd_10m_pst1mt', 'avg_wnd_spd_10m_pst1hr', 'avg_wnd_spd_pst10mts', 'wnd_spd'];

export function parseEcccSwobRealtime(text: string, expectedStationId?: string): Reading {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || !Array.isArray(data.features) || data.features.length === 0) {
    throw new Error('ECCC swob-realtime returned no features');
  }

  // Pick the feature with the newest timestamp
  let newestProps: Record<string, unknown> | null = null;
  let newestMs = -Infinity;
  for (const feature of data.features) {
    if (!isRecord(feature) || !isRecord(feature.properties)) continue;
    const p = feature.properties;
    if (expectedStationId) {
      const expected = expectedStationId.toUpperCase();
      const identities = [p['msc_id-value'], p['tc_id-value'], p['icao_stn_id-value']]
        .filter(value => typeof value === 'string' || typeof value === 'number').map(value => String(value).toUpperCase());
      if (!identities.some(id => id === expected || (id.length === 3 && `C${id}` === expected))) continue;
    }
    const dtStr =
      typeof p['date_tm-value'] === 'string'
        ? p['date_tm-value']
        : typeof p.date_tm === 'string'
          ? p.date_tm
          : null;
    const ms = observationTimeMs(dtStr ?? p.obs_date_tm);
    if (Number.isFinite(ms) && ms > newestMs && swobWind(p, SWOB_AVERAGE_KEYS) !== null) {
      newestMs = ms;
      newestProps = p;
    }
  }

  if (!newestProps || !Number.isFinite(newestMs)) {
    throw new Error('ECCC swob-realtime features had no valid date_tm-value');
  }

  const windAvgMps = swobWind(newestProps, SWOB_AVERAGE_KEYS)!;
  const windGustMps = swobWind(newestProps, ['max_wnd_spd_10m_pst10mts', 'max_wnd_spd_10m_pst1mt', 'max_wnd_spd_10m_pst1hr', 'max_wnd_spd_pst1hr']);

  const dirDeg =
    finiteNumber(newestProps.avg_wnd_dir_10m_pst10mts) ??
    finiteNumber(newestProps.avg_wnd_dir_10m_pst2mts) ??
    finiteNumber(newestProps.avg_wnd_dir_10m_pst1mt) ??
    finiteNumber(newestProps.avg_wnd_dir_10m_pst1hr) ??
    finiteNumber(newestProps.wnd_dir);

  const temperatureC =
    finiteNumber(newestProps.air_temp) ??
    finiteNumber(newestProps.avg_air_temp_pst1hr);
  const dewPointC =
    finiteNumber(newestProps.dwpt_temp) ??
    finiteNumber(newestProps.avg_dwpt_temp_pst1hr);
  const rh =
    finiteNumber(newestProps.rel_hum) ??
    finiteNumber(newestProps.avg_rel_hum_pst1hr);
  const rawMslp = finiteNumber(newestProps.mslp);
  const mslp = rawMslp === null ? null : newestProps['mslp-uom'] === 'kPa' ? rawMslp * 10
    : newestProps['mslp-uom'] === 'Pa' ? rawMslp / 100 : rawMslp;
  const pcpn1hr = finiteNumber(newestProps.pcpn_amt_pst1hr);

  const conditions: AirConditions = {
    ...emptyConditions(),
    dewPointC: validTemperatureC(dewPointC),
    relativeHumidityPercent: rh !== null && rh >= 0 && rh <= 100 ? rh : null,
    seaLevelPressureHpa: mslp !== null && mslp >= 300 && mslp <= 1100 ? mslp : null,
    precipitationRateMmPerHour: pcpn1hr !== null && pcpn1hr >= 0 ? pcpn1hr : null,
  };

  return {
    observedAt: new Date(newestMs).toISOString(),
    windAvgMps,
    windDirectionDeg: isCalm(windAvgMps) || dirDeg === null ? null : windDirection(dirDeg),
    windGustMps,
    windLullMps: null,
    temperatureC: validTemperatureC(temperatureC),
    windChillC: null,
    conditions,
  };
}

export const loadEcccStation = defineStationAdapter<EcccStationConfig, EcccAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'ECCC SWOB'),
  load: async ({ station }, { environment, options }) => {
    const url = new URL(options.realtimeUrl ?? ECCC_SWOB_REALTIME_URL);
    const mscId = typeof station.locator.mscId === 'string' ? station.locator.mscId : null;
    const expectedId = mscId ?? station.nativeId;
    url.searchParams.set(mscId ? 'msc_id-value' : 'tc_id-value', mscId ?? (station.nativeId.length === 4 && station.nativeId.startsWith('C') ? station.nativeId.slice(1) : station.nativeId));
    url.searchParams.set('sortby', '-date_tm-value');
    url.searchParams.set('limit', '20');
    url.searchParams.set('f', 'json');

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `eccc/swob/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `ECCC SWOB station ${station.nativeId}`,
    });

    return {
      reading: parseEcccSwobRealtime(text, expectedId),
      history: null,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const ecccProvider: StationNetworkProvider = {
  vendor: 'eccc',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'eccc');
    const batches: CatalogueStation[][] = [seeds];
    const regions = options.regions ?? INITIAL_SCOPE_REGIONS;

    if (options.includeRemoteDiscovery !== false && regions.includes('CA')) {
      const environment = resolveEnvironment(options.environment);
      try {
        const url = new URL(ECCC_SWOB_STATIONS_URL);
        url.searchParams.set('f', 'json');
        url.searchParams.set('limit', '2500');
        if (options.bounds) {
          url.searchParams.set('bbox', options.bounds.join(','));
        }
        let nextUrl: URL | null = url;
        for (let page = 0; nextUrl && page < 20; page += 1) {
          const currentUrl: URL = nextUrl;
          const text = await fetchUpstreamText(environment, {
            url: currentUrl, cacheKey: `eccc/swob-stations/${currentUrl.search}`, cacheTtlSeconds: 3_600,
            subject: 'ECCC SWOB stations catalogue', timeoutMs: 12_000, limitBytes: 6 * 1024 * 1024,
          });
          batches.push(parseEcccSwobStations(text));
          const root: unknown = JSON.parse(text);
          const next = isRecord(root) && Array.isArray(root.links)
            ? root.links.find(link => isRecord(link) && link.rel === 'next') : null;
          nextUrl = isRecord(next) && typeof next.href === 'string' ? new URL(next.href, currentUrl) : null;
          if (nextUrl && nextUrl.origin !== url.origin) throw new Error('ECCC pagination returned an unexpected origin');
        }
        if (nextUrl) logUpstreamFailure(environment, 'ECCC discovery incomplete', new Error('Pagination limit reached'));
      } catch (error) {
        logUpstreamFailure(environment, 'ECCC discovery failed', error);
        // Fallback to seeds
      }
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadEcccStation({ station }, { environment, historyHours, mode }),
    );
  },
};
