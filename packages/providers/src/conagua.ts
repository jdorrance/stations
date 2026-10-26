import {
  finiteNumber,
  isRecord,
  observationTimeMs,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  unavailableStation,
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
  unconfiguredCustomStation,
} from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

export const CONAGUA_EMAS_CAPAS_URL =
  'https://smn.conagua.gob.mx/tools/PHP/ConsultaCapas.php?clave=20&tipo=EMAS';
const CACHE_TTL_SECONDS = 600;

export type ConaguaStationConfig = {
  readonly station: CatalogueStation;
};

export type ConaguaAdapterOptions = StationAdapterOptions & {
  readonly capasUrl?: string;
};

export function parseConaguaEmasCatalogue(text: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) {
    throw new Error('CONAGUA EMAs ConsultaCapas response must be a JSON array');
  }
  const stations: CatalogueStation[] = [];
  for (const row of data) {
    if (!isRecord(row)) continue;
    const idRaw = row.id_estacion ?? row.id;
    if (typeof idRaw !== 'string' && typeof idRaw !== 'number') continue;
    const nativeId = String(idRaw).trim();
    if (!nativeId) continue;

    const latitude = finiteNumber(row.latitud ?? row.lat);
    const longitude = finiteNumber(row.longitud ?? row.lon);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }

    const country = inferRegionCode({ latitude, longitude }, 'MX');
    const name =
      typeof row.nombre === 'string' && row.nombre.trim()
        ? row.nombre.trim()
        : `CONAGUA EMA ${nativeId}`;
    const elevationM = finiteNumber(row.altitud ?? row.elevation);

    stations.push({
      uid: formatStationUid('conagua', nativeId),
      vendor: 'conagua',
      nativeId,
      name,
      latitude,
      longitude,
      elevationM,
      country,
      region: typeof row.estado === 'string' ? row.estado : null,
      timeZone: null,
      pageUrl: 'https://smn.conagua.gob.mx/tools/GUI/EMAS.php',
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
        idEstacion: nativeId,
      },
    });
  }
  return stations;
}

export function parseConaguaEmaObservation(text: string, _nowMs?: number, expectedId?: string): Reading {
  const data: unknown = JSON.parse(text);
  const rows = Array.isArray(data) ? data : [data];
  const eligible = rows.filter((item): item is Record<string, unknown> => isRecord(item)
    && (!expectedId || String(item.id_estacion ?? item.id ?? '') === expectedId));
  const row = eligible.sort((a, b) => observationTimeMs(b.fecha) - observationTimeMs(a.fecha))[0];
  if (!isRecord(row)) {
    throw new Error('CONAGUA EMA observation response is empty');
  }

  const avgKmh = finiteNumber(row.vel_viento ?? row.viento ?? row.wspd ?? row.ws);
  if (avgKmh === null || avgKmh < 0) {
    throw new Error('CONAGUA EMA payload is missing wind speed');
  }
  const windAvgMps = plausibleWindMps(kmhToMps(avgKmh), 'CONAGUA EMA');
  const gustKmh = finiteNumber(row.raf_viento ?? row.rafaga ?? row.wgst);
  const windGustMps =
    gustKmh === null || gustKmh < 0
      ? null
      : plausibleWindMps(kmhToMps(gustKmh), 'CONAGUA EMA');
  const dirDeg = finiteNumber(row.dir_viento ?? row.direccion ?? row.wdir);
  const temperatureC = finiteNumber(row.temperatura ?? row.temp);
  const rh = finiteNumber(row.humedad ?? row.rh);
  const pressure = finiteNumber(row.presion_nivel_mar ?? row.slp);
  const rain = finiteNumber(row.precipitacion ?? row.rain);
  const solar = finiteNumber(row.radiacion ?? row.srad);

  const observedAtMs = observationTimeMs(row.fecha);
  if (!Number.isFinite(observedAtMs)) throw new Error('CONAGUA EMA observation is missing an unambiguous timestamp');

  const conditions: AirConditions = {
    ...emptyConditions(),
    relativeHumidityPercent: rh !== null && rh >= 0 && rh <= 100 ? rh : null,
    seaLevelPressureHpa:
      pressure !== null && pressure >= 300 && pressure <= 1100 ? pressure : null,
    precipitationTodayMm: rain !== null && rain >= 0 ? rain : null,
    solarRadiationWm2: solar !== null && solar >= 0 ? solar : null,
  };

  return {
    observedAt: new Date(observedAtMs).toISOString(),
    windAvgMps,
    windDirectionDeg: isCalm(windAvgMps) || dirDeg === null ? null : windDirection(dirDeg),
    windGustMps,
    windLullMps: null,
    temperatureC: validTemperatureC(temperatureC),
    windChillC: null,
    conditions,
  };
}

export const loadConaguaStation = defineStationAdapter<
  ConaguaStationConfig,
  ConaguaAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'SMN CONAGUA EMA'),
  load: async ({ station }, { environment, options }) => {
    const endpoint =
      typeof station.locator.endpointUrl === 'string'
        ? station.locator.endpointUrl
        : options.capasUrl;
    if (!endpoint) throw new Error('CONAGUA station requires an observation endpoint; ConsultaCapas only provides catalogue metadata');

    const text = await fetchUpstreamText(environment, {
      url: endpoint,
      cacheKey: `conagua/ema/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `CONAGUA EMA ${station.nativeId}`,
    });

    return {
      reading: parseConaguaEmaObservation(text, undefined, station.nativeId),
      history: null,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const conaguaProvider: StationNetworkProvider = {
  vendor: 'conagua',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'conagua');
    const batches: CatalogueStation[][] = [seeds];
    const regions = options.regions ?? INITIAL_SCOPE_REGIONS;

    if (options.includeRemoteDiscovery !== false && regions.includes('MX')) {
      const environment = resolveEnvironment(options.environment);
      try {
        const text = await fetchUpstreamText(environment, {
          url: CONAGUA_EMAS_CAPAS_URL,
          cacheKey: 'conagua/emas/all',
          cacheTtlSeconds: 3_600,
          subject: 'SMN CONAGUA EMAs catalogue',
          timeoutMs: 10_000,
        });
        batches.push(parseConaguaEmasCatalogue(text));
      } catch (error) {
        logUpstreamFailure(environment, 'CONAGUA discovery failed', error);
        // Fallback to seeds
      }
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    if (typeof station.locator.endpointUrl !== 'string' || !station.locator.endpointUrl.trim()) {
      return unconfiguredCustomStation(station, 'SMN CONAGUA EMA');
    }
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadConaguaStation({ station }, { environment, historyHours, mode }),
    );
  },
};
