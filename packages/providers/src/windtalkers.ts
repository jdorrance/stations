import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  type AirConditions,
  type Reading,
} from '@azohra/meteo.station';
import {
  naiveLocalToIso,
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
  createSpatialIndex,
  inferRegionCode,
  validPosition,
  type Coverage,
  type Position,
} from '@stations/geography';
import {
  createSeededProvider,
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';
import { cacheIdentity, credentialCacheScope, observationTimeIso } from './freeflight-observations.ts';
import {
  FEET_TO_METERS,
  INHG_TO_HPA,
  KNOTS_TO_MPS,
  MAX_OBSERVATION_AGE_SECONDS,
  MPH_TO_MPS,
  fahrenheitToCelsius,
  finiteNumber,
  isRecentObservation,
  isRecord,
  optionalWindMps,
  pressureHpa,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';

export const WEATHERLINK_BULLETIN_URL = 'https://www.weatherlink.com/bulletin/data';
export const WEATHERLINK_MAP_DATA_URL = 'https://www.weatherlink.com/map/data';
export const WEATHERLINK_MAP_STATION_URL = 'https://www.weatherlink.com/map/data/station';
export const SIERRA_GLIDING_STATIONS_URL = 'https://sierragliding.us/api/stations';
export const CRESTLINE_WEATHER_API_URL = 'https://crestlinesoaring.org/apis/weather-station-data/';
export const AVIATIONWX_AIRPORTS_URL = 'https://api.aviationwx.org/v1/airports';
const CACHE_TTL_SECONDS = 60;

export type WeatherLinkStationConfig = {
  readonly station: CatalogueStation;
  readonly cookie?: string;
};

export type WeatherLinkAdapterOptions = StationAdapterOptions & {
  readonly bulletinBaseUrl?: string;
};

/**
 * Parses a Davis WeatherLink public bulletin JSON payload (`oMaiaData` or flat embed).
 */
export function parseWeatherLinkBulletin(
  text: string,
  _legacyNowMs?: number,
  stationKey?: string,
): Reading {
  const data: unknown = JSON.parse(text);

  // Format 0a: Sierra Gliding cellular windtalker JSON array
  if (Array.isArray(data)) {
    for (let i = data.length - 1; i >= 0; i -= 1) {
      const row = data[i];
      if (!isRecord(row)) continue;
      const observedAt = observationTimeIso(row.timestamp);
      const avgMph = finiteNumber(row.windspeed_avg ?? row.windspeed);
      if (!observedAt || avgMph === null || avgMph < 0) continue;
      const windAvgMps = plausibleWindMps(avgMph * MPH_TO_MPS, 'Sierra Gliding');
      const gustMph = finiteNumber(row.windspeed_max);
      const lullMph = finiteNumber(row.windspeed_min);
      const dirDeg = finiteNumber(row.wind_direction_avg ?? row.wind_direction);
      const tempC = finiteNumber(row.external_temp);
      return {
        observedAt,
        windAvgMps,
        windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dirDeg),
        windGustMps:
          gustMph === null || gustMph < 0 ? null : optionalWindMps(gustMph * MPH_TO_MPS),
        windLullMps:
          lullMph === null || lullMph < 0 ? null : optionalWindMps(lullMph * MPH_TO_MPS),
        temperatureC: validTemperatureC(tempC),
        windChillC: null,
        conditions: null,
      };
    }
    throw new Error('Sierra Gliding windtalker returned no valid observations');
  }

  if (!isRecord(data)) throw new Error('WeatherLink returned non-object payload');

  // Format 0c: AviationWX.org backcountry airpark v1 JSON (`{ weather: { ... }, meta: { ... } }`)
  if (isRecord(data.weather) && isRecord(data.meta)) {
    const w = data.weather;
    const m = data.meta;
    const observedAt = observationTimeIso(w.observation_time ?? m.observation_time);
    if (!observedAt) throw new Error('AviationWX payload is missing observation_time');
    const wspdKt = finiteNumber(w.wind_speed);
    if (wspdKt === null || wspdKt < 0) throw new Error('AviationWX payload is missing wind_speed');
    const windAvgMps = plausibleWindMps(wspdKt * KNOTS_TO_MPS, 'AviationWX');
    const gustKt = finiteNumber(w.gust_speed);
    const windGustMps =
      gustKt === null || gustKt < 0 ? null : optionalWindMps(gustKt * KNOTS_TO_MPS);
    const wdirObj = isRecord(w.wind_direction) ? w.wind_direction : null;
    const dirDeg = wdirObj
      ? finiteNumber(wdirObj.true_north ?? wdirObj.magnetic_north)
      : finiteNumber(w.wind_direction);
    const tempC = validTemperatureC(finiteNumber(w.temperature));
    const dewC = validTemperatureC(finiteNumber(w.dewpoint));
    const rh = finiteNumber(w.humidity);
    const baroInHg = finiteNumber(w.pressure);
    const rainIn = finiteNumber(w.precip_accum);

    return {
      observedAt,
      windAvgMps,
      windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dirDeg),
      windGustMps,
      windLullMps: null,
      temperatureC: tempC,
      windChillC: null,
      conditions: {
        ...emptyConditions(),
        dewPointC: dewC,
        relativeHumidityPercent: rh !== null && rh >= 0 && rh <= 100 ? rh : null,
        seaLevelPressureHpa:
          baroInHg !== null ? pressureHpa(Math.round(baroInHg * INHG_TO_HPA * 10) / 10) : null,
        precipitationTodayMm:
          rainIn !== null && rainIn >= 0 ? Math.round(rainIn * 25.4 * 10) / 10 : null,
      },
    };
  }

  // Format 0b: Crestline Soaring Society multi-station JSON (`crs`, `mar`, `ajx`)
  const cssKey = stationKey && Array.isArray(data[stationKey]) ? stationKey : null;
  if (cssKey) {
    const series = data[cssKey] as unknown[];
    for (let i = series.length - 1; i >= 0; i -= 1) {
      const row = series[i];
      if (!isRecord(row) || typeof row.dt !== 'string') continue;
      const avgMph = finiteNumber(row.w);
      if (avgMph === null || avgMph < 0) continue;
      const observedAt = naiveLocalToIso(row.dt.trim().replace(' ', 'T'), 'America/Los_Angeles');
      const windAvgMps = plausibleWindMps(avgMph * MPH_TO_MPS, 'Crestline Windtalker');
      const gustMph = finiteNumber(row.g);
      const dirDeg = finiteNumber(row.dir);
      const tempF = finiteNumber(row.f);
      return {
        observedAt,
        windAvgMps,
        windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dirDeg),
        windGustMps:
          gustMph === null || gustMph < 0 ? null : optionalWindMps(gustMph * MPH_TO_MPS),
        windLullMps: null,
        temperatureC: validTemperatureC(tempF === null ? null : fahrenheitToCelsius(tempF)),
        windChillC: null,
        conditions: null,
      };
    }
    throw new Error(`Crestline windtalker returned no active reading for ${cssKey}`);
  }

  // Format 1: WeatherLink Bulletin `oMaiaData` logicalSensor array
  if (Array.isArray(data.oMaiaData) && isRecord(data.oMaiaData[0])) {
    const item = data.oMaiaData[0];
    const observedAt = observationTimeIso(item.timestamp ?? item.lastReceived ?? data.timestamp ?? data.lastReceived);
    if (!observedAt) throw new Error('WeatherLink bulletin is missing an observation timestamp');
    const sensors = Array.isArray(item.logicalSensor) ? item.logicalSensor : [];
    const byName = new Map<string, number>();
    for (const sensor of sensors) {
      if (!isRecord(sensor) || !Array.isArray(sensor.sensorDataType)) continue;
      for (const entry of sensor.sensorDataType) {
        if (!isRecord(entry) || typeof entry.sensorDataName !== 'string') continue;
        const val = finiteNumber(entry.dataValue);
        if (val !== null) byName.set(entry.sensorDataName, val);
      }
    }

    const avgMph =
      byName.get('10 Min Avg Wind Speed') ??
      byName.get('2 Min Avg Wind Speed') ??
      byName.get('Wind Speed');
    if (avgMph === undefined || avgMph < 0) {
      throw new Error('WeatherLink bulletin is missing wind speed');
    }
    const windAvgMps = plausibleWindMps(avgMph * MPH_TO_MPS, 'WeatherLink');
    const gustMph =
      byName.get('10 Min High Wind Speed') ?? byName.get('High Wind Speed') ?? null;
    const dirDeg =
      byName.get('10 Min Scalar Avg Wind Direction') ??
      byName.get('Wind Direction') ??
      null;
    const tempF = byName.get('Temp') ?? byName.get('Outside Temp') ?? null;
    const hum = byName.get('Hum') ?? byName.get('Outside Humidity') ?? null;
    const baroInHg = byName.get('Barometer') ?? null;

    const conditions: AirConditions | null =
      hum !== null || baroInHg !== null
        ? {
            ...emptyConditions(),
            relativeHumidityPercent: hum !== null && hum >= 0 && hum <= 100 ? hum : null,
            seaLevelPressureHpa:
              baroInHg !== null ? pressureHpa(Math.round(baroInHg * INHG_TO_HPA * 10) / 10) : null,
          }
        : null;

    return {
      observedAt,
      windAvgMps,
      windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dirDeg),
      windGustMps:
        gustMph === null || gustMph < 0
          ? null
          : plausibleWindMps(gustMph * MPH_TO_MPS, 'WeatherLink'),
      windLullMps: null,
      temperatureC: tempF === null ? null : fahrenheitToCelsius(tempF),
      windChillC: null,
      conditions,
    };
  }

  // Format 2: WeatherLink Embeddable Page / Public Map Station JSON
  const avgMph = finiteNumber(data.wind ?? data.windSpeed ?? data.avgWind);
  if (avgMph === null || avgMph < 0) {
    throw new Error('WeatherLink payload is missing wind speed');
  }
  const windAvgMps = plausibleWindMps(avgMph * MPH_TO_MPS, 'WeatherLink');
  const gustMph = finiteNumber(data.gust ?? data.windGust ?? data.highWind);
  const dirDeg = finiteNumber(data.windDirection ?? data.windDir ?? data.dir);
  const tempF = finiteNumber(data.temp ?? data.temperature ?? data.outsideTemp);
  const hum = finiteNumber(data.humidity ?? data.hum);
  const baroInHg = finiteNumber(data.barometer ?? data.baro);
  const observedAt = observationTimeIso(
    data.time ?? data.timestamp ?? data.lastReceived ?? data.lastTimestamp,
  );
  if (!observedAt) throw new Error('WeatherLink payload is missing an observation timestamp');

  const conditions: AirConditions | null =
    (hum !== null && hum >= 0 && hum <= 100) || baroInHg !== null
      ? {
          ...emptyConditions(),
          relativeHumidityPercent: hum !== null && hum >= 0 && hum <= 100 ? hum : null,
          seaLevelPressureHpa:
            baroInHg !== null ? pressureHpa(Math.round(baroInHg * INHG_TO_HPA * 10) / 10) : null,
        }
      : null;

  return {
    observedAt,
    windAvgMps,
    windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dirDeg),
    windGustMps:
      gustMph === null || gustMph < 0
        ? null
        : plausibleWindMps(gustMph * MPH_TO_MPS, 'WeatherLink'),
    windLullMps: null,
    temperatureC: tempF === null ? null : fahrenheitToCelsius(tempF),
    windChillC: null,
    conditions,
  };
}

export const loadWeatherLinkStation = defineStationAdapter<
  WeatherLinkStationConfig,
  WeatherLinkAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'WeatherLink'),
  load: async ({ station, cookie }, { environment, options }) => {
    const sierraId =
      typeof station.locator.sierraGlidingId === 'string' ||
      typeof station.locator.sierraGlidingId === 'number'
        ? String(station.locator.sierraGlidingId)
        : null;
    const crestlineKey =
      typeof station.locator.crestlineKey === 'string'
        ? station.locator.crestlineKey
        : null;
    const mapStationId =
      typeof station.locator.mapStationId === 'string'
        ? station.locator.mapStationId
        : null;
    const aviationWxId =
      typeof station.locator.aviationWxId === 'string'
        ? station.locator.aviationWxId
        : null;

    const nowSec = Math.floor(environment.now().getTime() / 1_000);
    const bulletinBaseUrl = new URL(options.bulletinBaseUrl ?? WEATHERLINK_BULLETIN_URL);
    const endpoint = sierraId
      ? `https://sierragliding.us/api/station/${encodeURIComponent(sierraId)}/data?start=${nowSec - 7200}&end=${nowSec}&sample=60`
      : crestlineKey
        ? CRESTLINE_WEATHER_API_URL
        : aviationWxId
          ? `${AVIATIONWX_AIRPORTS_URL}/${encodeURIComponent(aviationWxId)}/weather`
          : mapStationId
            ? `${WEATHERLINK_MAP_STATION_URL}/${encodeURIComponent(mapStationId)}?aqiSchemeId=1&woodsmokeEnabled=false`
            : typeof station.locator.endpointUrl === 'string'
              ? station.locator.endpointUrl
              : `${bulletinBaseUrl.toString().replace(/\/$/, '')}/${encodeURIComponent(station.nativeId)}`;
    const endpointUrl = new URL(endpoint);
    // Metadata cannot redirect a server credential to an unrelated host.
    if (cookie && (endpointUrl.protocol !== 'https:' || endpointUrl.origin !== bulletinBaseUrl.origin)) {
      throw new Error('WeatherLink authenticated endpoint must use the configured HTTPS origin');
    }

    const fetchEnvironment = cookie
      ? { ...environment, fetch: (input: RequestInfo | URL, init?: RequestInit) => environment.fetch(input, { ...init, redirect: 'error' }) }
      : environment;
    const text = await fetchUpstreamText(fetchEnvironment, {
      url: endpointUrl,
      headers: cookie ? { Cookie: cookie } : undefined,
      cacheKey: crestlineKey
        ? 'weatherlink/crestline/all'
        : `weatherlink/${await credentialCacheScope(cookie)}/${await cacheIdentity(endpointUrl.origin + endpointUrl.pathname)}/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `WeatherLink station ${station.nativeId}`,
    });

    return {
      reading: parseWeatherLinkBulletin(text, undefined, crestlineKey ?? undefined),
      history: null,
    };
  },
});

export type RealtimeTxtStationConfig = {
  readonly station: CatalogueStation;
};

function convertSpeedUnitToMps(value: number, unit: string): number {
  const u = unit.trim().toLowerCase();
  if (u === 'km/h' || u === 'kmh' || u === 'kph') return kmhToMps(value);
  if (u === 'mph') return value * MPH_TO_MPS;
  if (u === 'kts' || u === 'knots' || u === 'kt') return value * KNOTS_TO_MPS;
  if (u === 'm/s') return value;
  throw new Error(`realtime.txt returned unsupported wind unit: ${unit}`);
}

/**
 * Parses the 58-field Cumulus / WeeWX / Saratoga `realtime.txt` format used by self-hosted
 * club windtalkers and personal mountain stations.
 */
export function parseRealtimeTxt(text: string, timeZone: string): Reading {
  const fields = text.trim().split(/\s+/);
  if (fields.length < 18) {
    throw new Error(`realtime.txt expected at least 18 space-separated fields, got ${fields.length}`);
  }
  if (!timeZone) throw new Error('realtime.txt requires the station time zone');
  const dateMatch = /^(\d{2})[/.\-](\d{2})[/.\-](\d{2}|\d{4})$/.exec(fields[0]!);
  const isoDate = /^\d{4}-\d{2}-\d{2}$/.test(fields[0]!)
    ? fields[0]
    : dateMatch
      ? `${dateMatch[3]!.length === 2 ? `20${dateMatch[3]}` : dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`
      : null;
  if (!isoDate) throw new Error('realtime.txt returned an invalid observation date');
  const observedAt = naiveLocalToIso(`${isoDate}T${fields[1]}`, timeZone);
  if (fields[50] === '1') throw new Error('realtime.txt reports lost sensor contact');

  // Fields:
  // 0: date (dd/mm/yy or yy-mm-dd)
  // 1: time (HH:MM:SS)
  // 2: temp
  // 3: hum
  // 4: dew
  // 5: ws_avg
  // 6: ws_latest
  // 7: bearing
  // 8: rain_rate
  // 9: rain_today
  // 10: baro
  // 13: wind_unit (mph, m/s, km/h, kts)
  // 14: temp_unit (C, F)
  // 15: press_unit (hPa, mb, in)
  // 40: high_gust_10min; instantaneous field 6 is not a gust measurement
  const windUnit = fields[13] ?? 'm/s';
  const tempUnit = (fields[14] ?? 'C').toUpperCase();
  const pressUnit = (fields[15] ?? 'hPa').toLowerCase();
  if (!['C', 'F'].includes(tempUnit) || !['hpa', 'mb', 'in'].includes(pressUnit)) {
    throw new Error('realtime.txt returned unsupported temperature or pressure units');
  }

  const rawAvg = finiteNumber(fields[5]);
  if (rawAvg === null || rawAvg < 0) {
    throw new Error('realtime.txt is missing average wind speed');
  }
  const windAvgMps = plausibleWindMps(
    convertSpeedUnitToMps(rawAvg, windUnit),
    'realtime.txt',
  );

  const rawGust = finiteNumber(fields[40]);
  const windGustMps =
    rawGust === null || rawGust < 0
      ? null
      : plausibleWindMps(convertSpeedUnitToMps(rawGust, windUnit), 'realtime.txt');

  const bearingDeg = finiteNumber(fields[46]) ?? finiteNumber(fields[7]);
  const rawTemp = finiteNumber(fields[2]);
  const rawDew = finiteNumber(fields[4]);
  const hum = finiteNumber(fields[3]);
  const rawBaro = finiteNumber(fields[10]);

  const toCelsius = (val: number | null): number | null =>
    val === null ? null : tempUnit.includes('F') ? fahrenheitToCelsius(val) : val;

  const temperatureC = toCelsius(rawTemp);
  const dewPointC = toCelsius(rawDew);
  const seaLevelPressureHpa =
    rawBaro === null
      ? null
      : pressUnit.includes('in')
        ? Math.round(rawBaro * INHG_TO_HPA * 10) / 10
        : rawBaro;

  const conditions: AirConditions = {
    ...emptyConditions(),
    dewPointC,
    relativeHumidityPercent: hum !== null && hum >= 0 && hum <= 100 ? hum : null,
    seaLevelPressureHpa:
      seaLevelPressureHpa !== null && seaLevelPressureHpa >= 300 && seaLevelPressureHpa <= 1100
        ? seaLevelPressureHpa
        : null,
  };

  return {
    observedAt,
    windAvgMps,
    windDirectionDeg:
      isCalm(windAvgMps) ? null : windDirection(bearingDeg),
    windGustMps,
    windLullMps: null,
    temperatureC,
    windChillC: null,
    conditions,
  };
}

export const loadRealtimeTxtStation = defineStationAdapter<
  RealtimeTxtStationConfig,
  StationAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Club Windtalker'),
  load: async ({ station }, { environment }) => {
    const url =
      typeof station.locator.realtimeUrl === 'string'
        ? station.locator.realtimeUrl
        : station.pageUrl;
    if (!url) {
      throw new Error(`realtime_txt station ${station.uid} is missing locator.realtimeUrl`);
    }
    const text = await fetchUpstreamText(environment, {
      url,
      accept: 'text/plain,*/*',
      cacheKey: `realtime_txt/${station.nativeId}`,
      cacheTtlSeconds: 30,
      subject: `realtime.txt ${station.name}`,
    });
    return {
      reading: parseRealtimeTxt(text, station.timeZone ?? ''),
      history: null,
    };
  },
});

const FALLBACK_FLYING_HUBS: readonly Position[] = [
  { latitude: 48.61, longitude: -122.43 },
  { latitude: 47.5, longitude: -122.01 },
  { latitude: 47.8, longitude: -120.04 },
  { latitude: 45.7, longitude: -121.88 },
  { latitude: 42.23, longitude: -123.0 },
  { latitude: 49.28, longitude: -121.85 },
  { latitude: 50.3, longitude: -122.74 },
  { latitude: 51.27, longitude: -116.9 },
  { latitude: 40.45, longitude: -111.9 },
  { latitude: 38.54, longitude: -112.07 },
  { latitude: 40.06, longitude: -105.3 },
  { latitude: 39.74, longitude: -105.24 },
  { latitude: 37.8, longitude: -122.46 },
  { latitude: 37.38, longitude: -118.4 },
  { latitude: 34.45, longitude: -119.7 },
  { latitude: 34.22, longitude: -117.3 },
  { latitude: 32.89, longitude: -117.25 },
  { latitude: 36.3, longitude: -81.72 },
  { latitude: 35.35, longitude: -85.4 },
  { latitude: 19.16, longitude: -100.12 },
];

const CRESTLINE_STATIONS: readonly {
  key: 'crs' | 'mar' | 'ajx';
  nativeId: string;
  name: string;
  latitude: number;
  longitude: number;
  elevationM: number;
  declaredFavorableDirections: readonly { fromDeg: number; toDeg: number }[];
}[] = [
  {
    key: 'crs',
    nativeId: 'crestline-launch',
    name: 'Crestline Launch (CSS Windtalker)',
    latitude: 34.2425,
    longitude: -117.3036,
    elevationM: 1595,
    declaredFavorableDirections: [{ fromDeg: 170, toDeg: 250 }],
  },
  {
    key: 'mar',
    nativeId: 'marshall-peak-css',
    name: 'Marshall Peak Launch (CSS Windtalker)',
    latitude: 34.209,
    longitude: -117.3027,
    elevationM: 1211,
    declaredFavorableDirections: [{ fromDeg: 140, toDeg: 245 }],
  },
  {
    key: 'ajx',
    nativeId: 'ajx-airpark-css',
    name: 'Andy Jackson Airpark LZ (CSS Windtalker)',
    latitude: 34.1934,
    longitude: -117.3239,
    elevationM: 525,
    declaredFavorableDirections: [{ fromDeg: 160, toDeg: 260 }],
  },
];

async function discoverCrestlineStations(
  environment: ReturnType<typeof resolveEnvironment>,
  nowMs: number,
): Promise<CatalogueStation[]> {
  try {
    const cssText = await fetchUpstreamText(environment, {
      url: CRESTLINE_WEATHER_API_URL,
      cacheKey: 'weatherlink/crestline/all',
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: 'Crestline Soaring Society weather API',
    });
    const cssStations: CatalogueStation[] = [];
    for (const item of CRESTLINE_STATIONS) {
      try {
        const reading = parseWeatherLinkBulletin(cssText, undefined, item.key);
        if (isRecentObservation(reading.observedAt, nowMs)) {
          cssStations.push({
            uid: formatStationUid('weatherlink', item.nativeId),
            vendor: 'weatherlink',
            nativeId: item.nativeId,
            name: item.name,
            latitude: item.latitude,
            longitude: item.longitude,
            elevationM: item.elevationM,
            country: 'US',
            region: 'CA',
            timeZone: 'America/Los_Angeles',
            pageUrl: 'https://crestlinesoaring.org/weather/',
            category: 'freeflight',
            declaredFavorableDirections: [...item.declaredFavorableDirections],
            capabilities: {
              gustLull: true,
              temperature: true,
              conditions: false,
              history: false,
            },
            samplingWindowSeconds: 120,
            recommendedPollSeconds: CACHE_TTL_SECONDS,
            locator: {
              stationId: item.nativeId,
              crestlineKey: item.key,
            },
          });
        }
      } catch {
        // Skip inactive Crestline station
      }
    }
    return cssStations;
  } catch {
    return [];
  }
}

async function discoverSierraGlidingStations(
  environment: ReturnType<typeof resolveEnvironment>,
  nowMs: number,
): Promise<CatalogueStation[]> {
  const nowSec = Math.floor(nowMs / 1_000);
  try {
    const sgAllText = await fetchUpstreamText(environment, {
      url: `${SIERRA_GLIDING_STATIONS_URL}?all=true`,
      cacheKey: 'weatherlink/sierragliding/all',
      cacheTtlSeconds: 3_600,
      subject: 'Sierra Gliding windtalkers',
    });
    const sgCuasaText = await fetchUpstreamText(environment, {
      url: `${SIERRA_GLIDING_STATIONS_URL}?groupName=CUASA`,
      cacheKey: 'weatherlink/sierragliding/cuasa',
      cacheTtlSeconds: 3_600,
      subject: 'Sierra Gliding CUASA windtalkers',
    }).catch(() => '[]');

    const sgRows = new Map<string, Record<string, unknown>>();
    for (const text of [sgAllText, sgCuasaText]) {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        for (const row of parsed) {
          if (isRecord(row) && (typeof row.id === 'number' || typeof row.id === 'string')) {
            sgRows.set(String(row.id), row);
          }
        }
      }
    }

    const sgActive: CatalogueStation[] = [];
    for (const [sgId, row] of sgRows) {
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      if (!name || /\btest\b|\bdefault\b/i.test(name)) continue;
      const latitude = finiteNumber(row.lat);
      const longitude = finiteNumber(row.lon);
      if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) continue;
      try {
        const dataText = await fetchUpstreamText(environment, {
          url: `https://sierragliding.us/api/station/${encodeURIComponent(sgId)}/data?start=${nowSec - 86400}&end=${nowSec}&sample=300`,
          cacheKey: `weatherlink/sierragliding/data/${sgId}`,
          cacheTtlSeconds: CACHE_TTL_SECONDS,
          subject: `Sierra Gliding station ${sgId}`,
          timeoutMs: 5_000,
        });
        const reading = parseWeatherLinkBulletin(dataText);
        if (!isRecentObservation(reading.observedAt, nowMs)) continue;
        const nativeId = `sg-${sgId}`;
        const elevM = finiteNumber(row.elevation);
        sgActive.push({
          uid: formatStationUid('weatherlink', nativeId),
          vendor: 'weatherlink',
          nativeId,
          name: `${name} (Sierra Gliding)`,
          latitude,
          longitude,
          elevationM: elevM !== null ? Math.round(elevM) : null,
          country: inferRegionCode({ latitude, longitude }, 'US'),
          region: longitude > -114 ? 'UT' : 'CA',
          timeZone: longitude > -114 ? 'America/Denver' : 'America/Los_Angeles',
          pageUrl: `https://sierragliding.us/#station=${encodeURIComponent(sgId)}&duration=3600`,
          category: 'freeflight',
          capabilities: {
            gustLull: true,
            temperature: true,
            conditions: false,
            history: false,
          },
          samplingWindowSeconds: 60,
          recommendedPollSeconds: CACHE_TTL_SECONDS,
          locator: {
            stationId: nativeId,
            sierraGlidingId: sgId,
          },
        });
      } catch {
        // Skip inactive Sierra Gliding station
      }
    }
    return sgActive;
  } catch {
    return [];
  }
}

async function discoverWeatherLinkMapStations(
  environment: ReturnType<typeof resolveEnvironment>,
  options: DiscoverOptions,
  nowMs: number,
): Promise<CatalogueStation[]> {
  try {
    const mapText = await fetchUpstreamText(environment, {
      url: WEATHERLINK_MAP_DATA_URL,
      cacheKey: 'weatherlink/map/all',
      cacheTtlSeconds: 3_600,
      subject: 'WeatherLink public map stations',
      timeoutMs: 12_000,
      limitBytes: 12 * 1024 * 1024,
    });
    const mapData: unknown = JSON.parse(mapText);
    if (!Array.isArray(mapData) || mapData.length <= 50) return [];

    const anchorPoints: readonly Position[] =
      options.launches && options.launches.length > 0
        ? options.launches
        : FALLBACK_FLYING_HUBS;
    const spatial = createSpatialIndex(anchorPoints);
    const radiusKm = 25;

    const candidates: {
      id: string;
      latitude: number;
      longitude: number;
      countryHint?: string;
    }[] = [];
    for (const row of mapData) {
      if (!isRecord(row) || typeof row.id !== 'string' || !row.id.trim()) continue;
      const tb = finiteNumber(row.tb);
      const latitude = finiteNumber(row.lat);
      const longitude = finiteNumber(row.lng);
      if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
        continue;
      }
      const isArmenia =
        latitude >= 38.84 &&
        latitude <= 41.3 &&
        longitude >= 43.44 &&
        longitude <= 46.63 &&
        !(longitude > 45.4 && latitude > 40.55);
      // Skip offline/unmapped stations (tb === -1) outside Armenia
      if (!isArmenia && tb !== null && tb < 0) continue;
      const isMidAtlantic =
        latitude >= 36.54 &&
        latitude <= 39.72 &&
        longitude >= -82.65 &&
        longitude <= -75.05;
      if (
        isArmenia ||
        isMidAtlantic ||
        spatial.queryRadius({ latitude, longitude }, radiusKm, 1).length > 0
      ) {
        candidates.push({
          id: row.id.trim(),
          latitude,
          longitude,
          ...(isArmenia ? { countryHint: 'AM' } : isMidAtlantic ? { countryHint: 'US' } : {}),
        });
      }
    }

    candidates.sort((a, b) => {
      const amA = a.countryHint === 'AM' ? 0 : 1;
      const amB = b.countryHint === 'AM' ? 0 : 1;
      return amA - amB;
    });

    const wlActive: CatalogueStation[] = [];
    const concurrency = 20;
    for (let index = 0; index < candidates.length; index += concurrency) {
      const slice = candidates.slice(index, index + concurrency);
      const checked = await Promise.all(
        slice.map(async candidate => {
          try {
            const detailText = await fetchUpstreamText(environment, {
              url: `${WEATHERLINK_MAP_STATION_URL}/${encodeURIComponent(candidate.id)}?aqiSchemeId=1&woodsmokeEnabled=false`,
              cacheKey: `weatherlink/map/station/${candidate.id}`,
              cacheTtlSeconds: CACHE_TTL_SECONDS,
              subject: `WeatherLink map station ${candidate.id}`,
              timeoutMs: 5_000,
            });
            const detail: unknown = JSON.parse(detailText);
            if (!isRecord(detail)) return null;
            const ageSec = finiteNumber(detail.ageInSeconds);
            if (ageSec !== null && (ageSec < 0 || ageSec > MAX_OBSERVATION_AGE_SECONDS)) {
              return null;
            }
            const reading = parseWeatherLinkBulletin(detailText);
            if (!isRecentObservation(reading.observedAt, nowMs)) return null;
            const rawName = typeof detail.sStation === 'string' ? detail.sStation.trim() : '';
            const name = rawName || `WeatherLink ${candidate.id.slice(0, 8)}`;
            const elevMatch = name.match(/\b([1-4])[',.]?(\d{3})\s*m\b/i);
            const elevationM = elevMatch
              ? Number(`${elevMatch[1]}${elevMatch[2]}`)
              : /Nor-Amberd/i.test(name)
                ? 2000
                : null;
            return {
              uid: formatStationUid('weatherlink', candidate.id),
              vendor: 'weatherlink' as const,
              nativeId: candidate.id,
              name,
              latitude: candidate.latitude,
              longitude: candidate.longitude,
              elevationM,
              country: inferRegionCode(
                {
                  latitude: candidate.latitude,
                  longitude: candidate.longitude,
                },
                candidate.countryHint,
              ),
              region: null,
              timeZone: candidate.countryHint === 'AM' ? 'Asia/Yerevan' : null,
              pageUrl: `https://www.weatherlink.com/map/${encodeURIComponent(candidate.id)}`,
              category: 'freeflight' as const,
              capabilities: {
                gustLull: true,
                temperature: true,
                conditions: true,
                history: false,
              },
              samplingWindowSeconds: 60,
              recommendedPollSeconds: CACHE_TTL_SECONDS,
              locator: {
                stationId: candidate.id,
                mapStationId: candidate.id,
              },
            } satisfies CatalogueStation;
          } catch {
            return null;
          }
        }),
      );
      for (const station of checked) {
        if (station) wlActive.push(station);
      }
    }
    return wlActive;
  } catch {
    return [];
  }
}

async function discoverAviationWxStations(
  environment: ReturnType<typeof resolveEnvironment>,
): Promise<CatalogueStation[]> {
  try {
    const text = await fetchUpstreamText(environment, {
      url: `${AVIATIONWX_AIRPORTS_URL}?has_weather=true`,
      cacheKey: 'weatherlink/aviationwx/airports',
      cacheTtlSeconds: 3_600,
      subject: 'AviationWX airpark weather directory',
    });
    const parsed: unknown = JSON.parse(text);
    const list =
      isRecord(parsed) && Array.isArray(parsed.airports)
        ? parsed.airports
        : Array.isArray(parsed)
          ? parsed
          : [];
    const out: CatalogueStation[] = [];
    for (const row of list) {
      if (!isRecord(row) || row.maintenance === true || row.has_weather === false) continue;
      const id = typeof row.id === 'string' ? row.id.trim().toLowerCase() : '';
      if (!id) continue;
      // Skip major 4-letter ICAO airports already covered by AWC METAR
      if (typeof row.icao === 'string' && /^[A-Z]{4}$/i.test(row.icao.trim())) continue;
      if (/^k[a-z]{3}$/i.test(id)) continue;

      const latitude = finiteNumber(row.lat);
      const longitude = finiteNumber(row.lon);
      if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
        continue;
      }
      const elevFt = finiteNumber(row.elevation_ft);
      const elevationM = elevFt !== null ? Math.round(elevFt * FEET_TO_METERS) : null;
      const rawName = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id.toUpperCase();
      const faa = typeof row.faa === 'string' && row.faa.trim() ? row.faa.trim().toUpperCase() : id.toUpperCase();
      const nativeId = `avwx-${id}`;

      out.push({
        uid: formatStationUid('weatherlink', nativeId),
        vendor: 'weatherlink',
        nativeId,
        name: `${rawName} (${faa} AviationWX)`,
        latitude,
        longitude,
        elevationM,
        country: inferRegionCode({ latitude, longitude }, id.startsWith('cy') ? 'CA' : 'US'),
        region: null,
        timeZone: typeof row.timezone === 'string' && row.timezone.trim() ? row.timezone.trim() : null,
        pageUrl: typeof row.url === 'string' && row.url.startsWith('http') ? row.url : `https://${id}.aviationwx.org/`,
        category: 'freeflight',
        capabilities: {
          gustLull: true,
          temperature: true,
          conditions: true,
          history: false,
        },
        samplingWindowSeconds: 60,
        recommendedPollSeconds: CACHE_TTL_SECONDS,
        locator: {
          stationId: nativeId,
          aviationWxId: id,
        },
      });
    }
    return out;
  } catch {
    return [];
  }
}

const coverage: Coverage = { kind: 'global' };

export const weatherLinkProvider: StationNetworkProvider = {
  vendor: 'weatherlink',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'weatherlink');
    const batches: CatalogueStation[][] = [seeds];

    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      const nowMs = environment.now().getTime();
      batches.push(await discoverCrestlineStations(environment, nowMs));
      batches.push(await discoverSierraGlidingStations(environment, nowMs));
      batches.push(await discoverAviationWxStations(environment));
      batches.push(await discoverWeatherLinkMapStations(environment, options, nowMs));
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadWeatherLinkStation({ station }, { environment, historyHours, mode }),
    );
  },
};

export const realtimeTxtProvider: StationNetworkProvider = createSeededProvider(
  'realtime_txt',
  station =>
    customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadRealtimeTxtStation({ station }, { environment, historyHours, mode }),
    ),
);
