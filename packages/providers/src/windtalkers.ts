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
} from './server.ts';
import { fetchUpstreamText } from '@azohra/meteo.station/server';
import type { CatalogueStation } from '@stations/contracts';
import type { Coverage } from '@stations/geography';
import {
  createSeededProvider,
  customStationConfig,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';
import { cacheIdentity, credentialCacheScope, observationTimeIso } from './freeflight-observations.ts';
import {
  INHG_TO_HPA,
  KNOTS_TO_MPS,
  MPH_TO_MPS,
  fahrenheitToCelsius,
  finiteNumber,
  isRecord,
  pressureHpa,
  windDirection,
} from './observation-values.ts';

export const WEATHERLINK_BULLETIN_URL = 'https://www.weatherlink.com/bulletin/data';
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
export function parseWeatherLinkBulletin(text: string, _legacyNowMs?: number): Reading {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw new Error('WeatherLink returned non-object payload');

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

  // Format 2: WeatherLink Embeddable Page JSON
  const avgMph = finiteNumber(data.wind ?? data.windSpeed ?? data.avgWind);
  if (avgMph === null || avgMph < 0) {
    throw new Error('WeatherLink payload is missing wind speed');
  }
  const windAvgMps = plausibleWindMps(avgMph * MPH_TO_MPS, 'WeatherLink');
  const gustMph = finiteNumber(data.gust ?? data.windGust ?? data.highWind);
  const dirDeg = finiteNumber(data.windDirection ?? data.windDir ?? data.dir);
  const tempF = finiteNumber(data.temp ?? data.temperature ?? data.outsideTemp);
  const observedAt = observationTimeIso(data.time ?? data.timestamp ?? data.lastReceived);
  if (!observedAt) throw new Error('WeatherLink payload is missing an observation timestamp');

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
    conditions: null,
  };
}

export const loadWeatherLinkStation = defineStationAdapter<
  WeatherLinkStationConfig,
  WeatherLinkAdapterOptions
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'WeatherLink'),
  load: async ({ station, cookie }, { environment, options }) => {
    const bulletinBaseUrl = new URL(options.bulletinBaseUrl ?? WEATHERLINK_BULLETIN_URL);
    const endpoint =
      typeof station.locator.endpointUrl === 'string'
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
      cacheKey: `weatherlink/${await credentialCacheScope(cookie)}/${await cacheIdentity(endpointUrl.href)}/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `WeatherLink station ${station.nativeId}`,
    });

    return {
      reading: parseWeatherLinkBulletin(text),
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

export const weatherLinkProvider: StationNetworkProvider = createSeededProvider(
  'weatherlink',
  station =>
    customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadWeatherLinkStation({ station }, { environment, historyHours, mode }),
    ),
);

export const realtimeTxtProvider: StationNetworkProvider = createSeededProvider(
  'realtime_txt',
  station =>
    customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadRealtimeTxtStation({ station }, { environment, historyHours, mode }),
    ),
);
