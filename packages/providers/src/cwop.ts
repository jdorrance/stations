import {
  INHG_TO_HPA,
  MPH_TO_MPS,
  fahrenheitToCelsius,
  finiteNumber,
  isRecentObservation,
  isRecord,
  observationTimeMs,
  optionalWindMps,
  pressureHpa,
  utcPartsMs,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { credentialCacheScope } from './freeflight-observations.ts';
import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  unavailableStation,
  type AirConditions,
  type History,
  type HistoryPoint,
  type Reading,
} from '@azohra/meteo.station';
import {
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
  type Position,
} from '@stations/geography';
import {
  createSeededProvider,
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
  unconfiguredCustomStation,
} from './azohra-vendors.ts';
import type {
  DiscoverOptions,
  ProviderCredentials,
  StationNetworkProvider,
} from './types.ts';

export const FINDU_RAW_WX_URL = 'http://www.findu.com/cgi-bin/rawwx.cgi';
export const FINDU_NEAR_WX_URL = 'http://www.findu.com/cgi-bin/wxnear.cgi';
export const WINDY_PWS_URL = 'https://node.windy.com/obs/measurement/v3/pws';
export const WU_PWS_CURRENT_URL = 'https://api.weather.com/v2/pws/observations/current';
export const SYNOPTIC_LATEST_URL = 'https://api.synopticdata.com/v2/stations/latest';
export const AMBIENT_DEVICES_URL = 'https://rt.ambientweather.net/v1/devices';

const CACHE_TTL_SECONDS = 120;

/**
 * Parses a raw APRS / CWOP weather packet:
 * Example: `CW0001>APRS,TCPXX*:@261800z4729.97N/12200.54W_315/012g018t058r000p000P000h65b10142`
 */
export function parseAprsWxPacket(rawText: string, nowMs = Date.now(), expectedCallsign?: string): Reading {
  const lines = rawText.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').trim().split(/\r?\n/);
  const clean = lines.find(line => /_/.test(line) && (!expectedCallsign
    || line.match(/([A-Z0-9-]+)>[^:]*:/i)?.[1]?.toUpperCase() === expectedCallsign.toUpperCase())) ?? '';
  const timestamp = clean.match(/[@/](\d{2})(\d{2})(\d{2})z/i);
  if (!timestamp || !Number.isFinite(nowMs)) throw new Error('APRS/CWOP packet is missing a UTC observation timestamp');
  const reference = new Date(nowMs);
  const candidates = [-1, 0, 1].map(offset => {
    const month = new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth() + offset, 1));
    return utcPartsMs(month.getUTCFullYear(), month.getUTCMonth() + 1, Number(timestamp[1]), Number(timestamp[2]), Number(timestamp[3]));
  }).filter(ms => Number.isFinite(ms) && ms <= nowMs + 300_000);
  const observedAtMs = Math.max(...candidates);
  if (!Number.isFinite(observedAtMs)) throw new Error('APRS/CWOP packet has an invalid observation timestamp');
  const wxMatch = clean.match(/_(\d{3}|\.{3})\/(\d{3}|\.{3})g(\d{3}|\.{3})t(-?\d{2,3}|\.{3})([^\r\n]*)/);
  if (!wxMatch) {
    throw new Error('APRS/CWOP packet did not contain a valid weather block');
  }

  const [, dirStr, spdStr, gustStr, tempStr, tail = ''] = wxMatch;
  if (!spdStr || spdStr === '...') {
    throw new Error('APRS/CWOP packet is missing sustained wind speed');
  }

  const spdMph = Number(spdStr);
  const windAvgMps = plausibleWindMps(spdMph * MPH_TO_MPS, 'CWOP/APRS');

  const gustMph = gustStr && gustStr !== '...' ? Number(gustStr) : null;
  const windGustMps =
    gustMph === null || !Number.isFinite(gustMph)
      ? null
      : plausibleWindMps(gustMph * MPH_TO_MPS, 'CWOP/APRS');

  const dirDeg = dirStr && dirStr !== '...' ? Number(dirStr) : null;
  const tempF = tempStr && tempStr !== '...' ? Number(tempStr) : null;

  const humMatch = tail.match(/h(\d{2})/);
  const baroMatch = tail.match(/b(\d{5})/);
  const rainTodayMatch = tail.match(/P(\d{3})/);

  const rh = humMatch ? (Number(humMatch[1]) === 0 ? 100 : Number(humMatch[1])) : null;
  const baroHpa = baroMatch ? Number(baroMatch[1]) / 10 : null;
  const rainTodayMm = rainTodayMatch ? Math.round(Number(rainTodayMatch[1]) * 0.254 * 10) / 10 : null;

  const conditions: AirConditions = {
    ...emptyConditions(),
    relativeHumidityPercent: rh !== null && rh >= 0 && rh <= 100 ? rh : null,
    seaLevelPressureHpa:
      baroHpa !== null && baroHpa >= 300 && baroHpa <= 1100 ? baroHpa : null,
    precipitationTodayMm: rainTodayMm,
  };

  return {
    observedAt: new Date(observedAtMs).toISOString(),
    windAvgMps,
    windDirectionDeg:
      isCalm(windAvgMps) || dirDeg === null || !Number.isFinite(dirDeg)
        ? null
        : windDirection(dirDeg),
    windGustMps,
    windLullMps: null,
    temperatureC:
      tempF === null || !Number.isFinite(tempF) ? null : fahrenheitToCelsius(tempF),
    windChillC: null,
    conditions,
  };
}

export const loadCwopStation = defineStationAdapter<
  { readonly station: CatalogueStation },
  StationAdapterOptions & { readonly finduUrl?: string }
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'CWOP / APRS'),
  load: async ({ station }, { environment, options }) => {
    const url = new URL(options.finduUrl ?? FINDU_RAW_WX_URL);
    url.searchParams.set('call', station.nativeId);
    url.searchParams.set('start', '1');
    url.searchParams.set('length', '1');

    const text = await fetchUpstreamText(environment, {
      url,
      accept: 'text/html,text/plain',
      cacheKey: `cwop/raw/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `CWOP station ${station.nativeId}`,
    });

    return {
      reading: parseAprsWxPacket(text, environment.now().getTime(), station.nativeId),
      history: null,
    };
  },
});

/**
 * Parses Windy's v3 PWS measurement endpoint:
 * `https://node.windy.com/obs/measurement/v3/pws/{id}/10/1`
 * Series `wind` and `gust` are in m/s; `temp` is in Kelvin!
 */
export function parseWindyPwsResponse(
  text: string,
): { reading: Reading; history: History | null } {
  const root: unknown = JSON.parse(text);
  const d = isRecord(root) && isRecord(root.data) ? root.data : isRecord(root) ? root : null;
  if (!d || !Array.isArray(d.ts) || !Array.isArray(d.wind) || d.ts.length === 0) {
    throw new Error('Windy PWS payload is missing ts/wind arrays');
  }

  const tsArr = d.ts;
  const windArr = d.wind;
  const gustArr = Array.isArray(d.gust) ? d.gust : [];
  const dirArr = Array.isArray(d.windDir) ? d.windDir : [];
  const tempArr = Array.isArray(d.temp) ? d.temp : [];
  const rhArr = Array.isArray(d.rh) ? d.rh : [];
  const pressArr = Array.isArray(d.pressure) ? d.pressure : [];

  const points: HistoryPoint[] = [];
  let latestReading: Reading | null = null;
  let latestMs = -Infinity;

  for (let i = 0; i < tsArr.length; i += 1) {
    const tsRaw = finiteNumber(tsArr[i]);
    const wRaw = finiteNumber(windArr[i]);
    if (tsRaw === null || wRaw === null || wRaw < 0) continue;
    const observedAtMs = observationTimeMs(tsRaw);
    if (!Number.isFinite(observedAtMs) || optionalWindMps(wRaw) === null) continue;
    const observedAt = new Date(observedAtMs).toISOString();
    const windAvgMps = plausibleWindMps(wRaw, 'Windy PWS');

    const gRaw = finiteNumber(gustArr[i]);
    const windGustMps =
      optionalWindMps(gRaw);
    const dirRaw = finiteNumber(dirArr[i]);
    const windDirectionDeg =
      isCalm(windAvgMps) || dirRaw === null ? null : windDirection(dirRaw);

    const tRaw = finiteNumber(tempArr[i]);
    const temperatureC = tRaw !== null && tRaw >= 173.15 && tRaw <= 343.15
      ? Math.round((tRaw - 273.15) * 10) / 10 : null;

    const pRaw = finiteNumber(pressArr[i]);
    const rawPressureHpa =
      pRaw === null
        ? null
        : pRaw > 2000
          ? Math.round((pRaw / 100) * 10) / 10
          : pRaw >= 300 && pRaw <= 1100
            ? pRaw
            : null;
    const seaLevelPressureHpa = pressureHpa(rawPressureHpa);

    points.push({
      observedAt,
      windAvgMps,
      windGustMps,
      windLullMps: null,
      windDirectionDeg,
      temperatureC: validTemperatureC(temperatureC),
      seaLevelPressureHpa,
    });

    if (observedAtMs > latestMs) {
      latestMs = observedAtMs;
      const rhRaw = finiteNumber(rhArr[i]);
      latestReading = {
        observedAt,
        windAvgMps,
        windDirectionDeg,
        windGustMps,
        windLullMps: null,
        temperatureC: validTemperatureC(temperatureC),
        windChillC: null,
        conditions:
          rhRaw !== null || seaLevelPressureHpa !== null
            ? {
                ...emptyConditions(),
                relativeHumidityPercent:
                  rhRaw !== null && rhRaw >= 0 && rhRaw <= 100 ? rhRaw : null,
                seaLevelPressureHpa,
              }
            : null,
      };
    }
  }

  if (!latestReading) {
    throw new Error('Windy PWS contained no valid readings');
  }
  return {
    reading: latestReading,
    history: points.length > 1 ? { periodMinutes: 10, points: points.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)) } : null,
  };
}

export const loadWindyStation = defineStationAdapter<
  { readonly station: CatalogueStation },
  StationAdapterOptions & { readonly windyBaseUrl?: string }
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Windy Station'),
  load: async ({ station }, { environment, options }) => {
    const base = (options.windyBaseUrl ?? WINDY_PWS_URL).replace(/\/$/, '');
    const text = await fetchUpstreamText(environment, {
      url: `${base}/${encodeURIComponent(station.nativeId)}/10/1`,
      cacheKey: `windy/pws/${station.nativeId}`,
      cacheTtlSeconds: 60,
      subject: `Windy station ${station.nativeId}`,
    });
    const { reading, history } = parseWindyPwsResponse(text);
    return { reading, history };
  },
});

export function parseWuPwsCurrent(text: string, expectedId?: string): Reading {
  const data: unknown = JSON.parse(text);
  const obs =
    isRecord(data) && Array.isArray(data.observations)
      ? data.observations.filter((row): row is Record<string, unknown> => isRecord(row)
        && (!expectedId || row.stationID === expectedId))
        .sort((a, b) => observationTimeMs(b.obsTimeUtc) - observationTimeMs(a.obsTimeUtc))[0]
      : null;
  if (!obs) throw new Error('Weather Underground returned no observations');

  const obsTimeUtc = observationTimeMs(obs.obsTimeUtc);
  if (!Number.isFinite(obsTimeUtc)) throw new Error('WU observation is missing obsTimeUtc');

  const m = isRecord(obs.metric)
    ? obs.metric
    : isRecord(obs.metric_si)
      ? obs.metric_si
      : null;
  const isSi = !isRecord(obs.metric) && isRecord(obs.metric_si);
  if (!m) throw new Error('WU observation is missing metric block');

  const rawSpeed = finiteNumber(m.windSpeed);
  if (rawSpeed === null || rawSpeed < 0) throw new Error('WU observation is missing windSpeed');
  const windAvgMps = plausibleWindMps(isSi ? rawSpeed : kmhToMps(rawSpeed), 'WU PWS');

  const rawGust = finiteNumber(m.windGust);
  const windGustMps =
    rawGust === null || rawGust < 0
      ? null
      : plausibleWindMps(isSi ? rawGust : kmhToMps(rawGust), 'WU PWS');
  const dirDeg = finiteNumber(obs.winddir);
  const temperatureC = finiteNumber(m.temp);
  const dewPointC = finiteNumber(m.dewpt);
  const rh = finiteNumber(obs.humidity);
  const pressure = finiteNumber(m.pressure);
  const solar = finiteNumber(obs.solarRadiation);
  const uv = finiteNumber(obs.uv);
  const precipRate = finiteNumber(m.precipRate);
  const precipTotal = finiteNumber(m.precipTotal);

  return {
    observedAt: new Date(obsTimeUtc).toISOString(),
    windAvgMps,
    windDirectionDeg: isCalm(windAvgMps) || dirDeg === null ? null : windDirection(dirDeg),
    windGustMps,
    windLullMps: null,
    temperatureC: validTemperatureC(temperatureC),
    windChillC: finiteNumber(m.windChill),
    conditions: {
      ...emptyConditions(),
      dewPointC: validTemperatureC(dewPointC),
      relativeHumidityPercent: rh !== null && rh >= 0 && rh <= 100 ? rh : null,
      seaLevelPressureHpa:
        pressure !== null && pressure >= 300 && pressure <= 1100 ? pressure : null,
      solarRadiationWm2: solar !== null && solar >= 0 ? solar : null,
      uvIndex: uv !== null && uv >= 0 ? uv : null,
      precipitationRateMmPerHour: precipRate !== null && precipRate >= 0 ? precipRate : null,
      precipitationTodayMm: precipTotal !== null && precipTotal >= 0 ? precipTotal : null,
    },
  };
}

export const loadWuPwsStation = defineStationAdapter<
  { readonly station: CatalogueStation; readonly apiKey: string },
  StationAdapterOptions & { readonly wuUrl?: string }
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Weather Underground'),
  load: async ({ station, apiKey }, { environment, options }) => {
    const url = new URL(options.wuUrl ?? WU_PWS_CURRENT_URL);
    url.searchParams.set('stationId', station.nativeId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('units', 'm');
    url.searchParams.set('numericPrecision', 'decimal');
    url.searchParams.set('apiKey', apiKey);

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `wunderground/current/${await credentialCacheScope(apiKey)}/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `WU PWS ${station.nativeId}`,
    });
    return {
      reading: parseWuPwsCurrent(text, station.nativeId),
      history: null,
    };
  },
});

export function parseSynopticLatest(text: string, expectedId?: string): Reading {
  const data: unknown = JSON.parse(text);
  const stn =
    isRecord(data) && Array.isArray(data.STATION)
      ? data.STATION.find((row): row is Record<string, unknown> => isRecord(row) && (!expectedId || row.STID === expectedId))
      : null;
  const obs = stn && isRecord(stn.OBSERVATIONS) ? stn.OBSERVATIONS : null;
  if (!obs) throw new Error('Synoptic response is missing STATION[0].OBSERVATIONS');

  const valOf = (prefix: string): { value: number; ms: number } | null => {
    let latest: { value: number; ms: number } | null = null;
    for (const [k, v] of Object.entries(obs)) {
      if (k.startsWith(prefix) && isRecord(v)) {
        const num = finiteNumber(v.value);
        const ms = observationTimeMs(v.date_time);
        if (num !== null && Number.isFinite(ms) && (!latest || ms > latest.ms)) {
          latest = {
            value: num,
            ms,
          };
        }
      }
    }
    return latest;
  };

  const wspd = valOf('wind_speed_value');
  if (!wspd || wspd.value < 0) throw new Error('Synoptic station is missing wind_speed_value');
  const windAvgMps = plausibleWindMps(wspd.value, 'Synoptic');
  const concurrent = (prefix: string) => {
    const value = valOf(prefix);
    return value?.ms === wspd.ms ? value : null;
  };
  const wgst = concurrent('wind_gust_value');
  const wdir = concurrent('wind_direction_value');
  const temp = concurrent('air_temp_value');
  const dewp = concurrent('dew_point_temperature_value');
  const rh = concurrent('relative_humidity_value');
  const slp = concurrent('sea_level_pressure_value');
  const observedAtMs = wspd.ms;

  return {
    observedAt: new Date(observedAtMs).toISOString(),
    windAvgMps,
    windDirectionDeg: isCalm(windAvgMps) || !wdir ? null : windDirection(wdir.value),
    windGustMps: !wgst || wgst.value < 0 ? null : plausibleWindMps(wgst.value, 'Synoptic'),
    windLullMps: null,
    temperatureC: validTemperatureC(temp ? temp.value : null),
    windChillC: null,
    conditions: {
      ...emptyConditions(),
      dewPointC: validTemperatureC(dewp ? dewp.value : null),
      relativeHumidityPercent: rh && rh.value >= 0 && rh.value <= 100 ? rh.value : null,
      seaLevelPressureHpa:
        pressureHpa(slp ? slp.value / 100 : null),
    },
  };
}

export const loadSynopticStation = defineStationAdapter<
  { readonly station: CatalogueStation; readonly token: string },
  StationAdapterOptions & { readonly synopticUrl?: string }
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Synoptic / MesoWest'),
  load: async ({ station, token }, { environment, options }) => {
    const url = new URL(options.synopticUrl ?? SYNOPTIC_LATEST_URL);
    url.searchParams.set('stid', station.nativeId);
    url.searchParams.set('units', 'metric');
    url.searchParams.set('token', token);

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `synoptic/latest/${await credentialCacheScope(token)}/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `Synoptic station ${station.nativeId}`,
    });
    return {
      reading: parseSynopticLatest(text, station.nativeId),
      history: null,
    };
  },
});

export function parseAmbientDeviceObservation(text: string): Reading {
  const data: unknown = JSON.parse(text);
  const first = Array.isArray(data) ? data[0] : data;
  if (!isRecord(first)) throw new Error('Ambient Weather returned empty payload');
  const row = isRecord(first.lastData) ? first.lastData : first;

  const dateutc = finiteNumber(row.dateutc);
  const observedAtMs =
    observationTimeMs(dateutc ?? row.date);
  if (!Number.isFinite(observedAtMs)) {
    throw new Error('Ambient Weather payload is missing dateutc');
  }

  const spdMph = finiteNumber(row.windspeedmph);
  if (spdMph === null || spdMph < 0) {
    throw new Error('Ambient Weather payload is missing windspeedmph');
  }
  const windAvgMps = plausibleWindMps(spdMph * MPH_TO_MPS, 'Ambient Weather');
  const gustMph = finiteNumber(row.windgustmph);
  const dirDeg = finiteNumber(row.winddir);
  const tempF = finiteNumber(row.tempf);
  const dewF = finiteNumber(row.dewPoint);
  const hum = finiteNumber(row.humidity);
  const baroIn = finiteNumber(row.baromrelin);
  const solar = finiteNumber(row.solarradiation);
  const uv = finiteNumber(row.uv);

  return {
    observedAt: new Date(observedAtMs).toISOString(),
    windAvgMps,
    windDirectionDeg: isCalm(windAvgMps) || dirDeg === null ? null : windDirection(dirDeg),
    windGustMps:
      gustMph === null || gustMph < 0
        ? null
        : plausibleWindMps(gustMph * MPH_TO_MPS, 'Ambient Weather'),
    windLullMps: null,
    temperatureC: validTemperatureC(tempF === null ? null : fahrenheitToCelsius(tempF)),
    windChillC: null,
    conditions: {
      ...emptyConditions(),
      dewPointC: validTemperatureC(dewF === null ? null : fahrenheitToCelsius(dewF)),
      relativeHumidityPercent: hum !== null && hum >= 0 && hum <= 100 ? hum : null,
      seaLevelPressureHpa:
        pressureHpa(baroIn !== null ? Math.round(baroIn * INHG_TO_HPA * 10) / 10 : null),
      solarRadiationWm2: solar !== null && solar >= 0 ? solar : null,
      uvIndex: uv !== null && uv >= 0 ? uv : null,
    },
  };
}

export const loadAmbientStation = defineStationAdapter<
  {
    readonly station: CatalogueStation;
    readonly apiKey: string;
    readonly applicationKey: string;
  },
  StationAdapterOptions & { readonly ambientBaseUrl?: string }
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Ambient Weather'),
  load: async ({ station, apiKey, applicationKey }, { environment, options }) => {
    const base = (options.ambientBaseUrl ?? AMBIENT_DEVICES_URL).replace(/\/$/, '');
    const url = new URL(`${base}/${encodeURIComponent(station.nativeId)}`);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('applicationKey', applicationKey);
    url.searchParams.set('limit', '1');

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `ambient/device/${await credentialCacheScope(JSON.stringify([apiKey, applicationKey]))}/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `Ambient Weather ${station.nativeId}`,
    });
    return {
      reading: parseAmbientDeviceObservation(text),
      history: null,
    };
  },
});

const CWOP_HUBS: readonly Position[] = [
  { latitude: 48.61, longitude: -122.43 },
  { latitude: 47.5, longitude: -122.01 },
  { latitude: 47.8, longitude: -120.04 },
  { latitude: 45.7, longitude: -121.88 },
  { latitude: 42.23, longitude: -123.0 },
  { latitude: 49.2, longitude: -121.9 },
  { latitude: 50.3, longitude: -122.74 },
  { latitude: 51.27, longitude: -116.9 },
  { latitude: 43.8, longitude: -113.38 },
  { latitude: 43.59, longitude: -110.83 },
  { latitude: 40.45, longitude: -111.9 },
  { latitude: 38.54, longitude: -112.07 },
  { latitude: 40.06, longitude: -105.3 },
  { latitude: 39.74, longitude: -105.24 },
  { latitude: 35.21, longitude: -106.45 },
  { latitude: 39.31, longitude: -119.88 },
  { latitude: 37.8, longitude: -122.46 },
  { latitude: 37.38, longitude: -118.4 },
  { latitude: 34.45, longitude: -119.7 },
  { latitude: 34.22, longitude: -117.3 },
  { latitude: 32.89, longitude: -117.25 },
  { latitude: 38.87, longitude: -78.45 },
  { latitude: 36.3, longitude: -81.72 },
  { latitude: 35.35, longitude: -85.4 },
  { latitude: 34.89, longitude: -85.46 },
  { latitude: 43.37, longitude: -72.36 },
];

function parseAprsPosition(rawText: string, expectedCallsign: string): Position | null {
  const lines = rawText
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .trim()
    .split(/\r?\n/);
  const clean =
    lines.find(
      line =>
        /_/.test(line) &&
        line.match(/([A-Z0-9-]+)>[^:]*:/i)?.[1]?.toUpperCase() ===
          expectedCallsign.toUpperCase(),
    ) ?? '';
  const match = clean.match(/(\d{2})(\d{2}\.\d{2})([NS])[/\\](\d{3})(\d{2}\.\d{2})([EW])/i);
  if (!match) return null;
  const latDeg = Number(match[1]);
  const latMin = Number(match[2]);
  const latSign = match[3]!.toUpperCase() === 'S' ? -1 : 1;
  const lonDeg = Number(match[4]);
  const lonMin = Number(match[5]);
  const lonSign = match[6]!.toUpperCase() === 'W' ? -1 : 1;
  const latitude = Math.round((latDeg + latMin / 60) * latSign * 1e5) / 1e5;
  const longitude = Math.round((lonDeg + lonMin / 60) * lonSign * 1e5) / 1e5;
  return validPosition({ latitude, longitude }) ? { latitude, longitude } : null;
}

function parseFinduNearCalls(html: string): string[] {
  const calls: string[] = [];
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]!);
  for (const row of rows) {
    const callMatch = row.match(/wxpage\.cgi\?call=([A-Z0-9-]+)/i);
    if (!callMatch) continue;
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m =>
      m[1]!.replace(/<[^>]+>/g, '').trim(),
    );
    // Column 5 is wind speed; skip stations with blank wind speed
    if (cells.length >= 6 && cells[5] !== '' && Number.isFinite(Number(cells[5]))) {
      calls.push(callMatch[1]!.toUpperCase());
    }
  }
  return calls;
}

const cwopCoverage: Coverage = { kind: 'global' };

export const cwopProvider: StationNetworkProvider = {
  vendor: 'cwop',
  coverage: cwopCoverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'cwop');
    const batches: CatalogueStation[][] = [seeds];

    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      const nowMs = environment.now().getTime();
      try {
        // Probe first hub via environment.fetch so offline unit tests fail closed without external calls
        const firstHub = CWOP_HUBS[0]!;
        const firstUrl = new URL(FINDU_NEAR_WX_URL);
        firstUrl.searchParams.set('lat', String(firstHub.latitude));
        firstUrl.searchParams.set('lon', String(firstHub.longitude));
        firstUrl.searchParams.set('cnt', '12');
        const firstHtml = await fetchUpstreamText(environment, {
          url: firstUrl,
          accept: 'text/html,text/plain',
          cacheKey: `cwop/near/${firstHub.latitude},${firstHub.longitude}`,
          cacheTtlSeconds: 1_800,
          subject: `CWOP near (${firstHub.latitude}, ${firstHub.longitude})`,
        });

        const callsigns = new Set<string>(parseFinduNearCalls(firstHtml));
        const remainingHubs = CWOP_HUBS.slice(1);
        const concurrency = 6;
        for (let i = 0; i < remainingHubs.length; i += concurrency) {
          const slice = remainingHubs.slice(i, i + concurrency);
          const hubCalls = await Promise.all(
            slice.map(async hub => {
              try {
                const url = new URL(FINDU_NEAR_WX_URL);
                url.searchParams.set('lat', String(hub.latitude));
                url.searchParams.set('lon', String(hub.longitude));
                url.searchParams.set('cnt', '12');
                const html = await fetchUpstreamText(environment, {
                  url,
                  accept: 'text/html,text/plain',
                  cacheKey: `cwop/near/${hub.latitude},${hub.longitude}`,
                  cacheTtlSeconds: 1_800,
                  subject: `CWOP near (${hub.latitude}, ${hub.longitude})`,
                  timeoutMs: 5_000,
                });
                return parseFinduNearCalls(html);
              } catch {
                return [];
              }
            }),
          );
          for (const list of hubCalls) {
            for (const c of list) callsigns.add(c);
          }
        }

        const allCalls = [...callsigns];
        const discovered: CatalogueStation[] = [];
        const probeConcurrency = 15;
        for (let i = 0; i < allCalls.length; i += probeConcurrency) {
          const slice = allCalls.slice(i, i + probeConcurrency);
          const probed = await Promise.all(
            slice.map(async call => {
              try {
                const res = await fetch(
                  `${FINDU_RAW_WX_URL}?call=${encodeURIComponent(call)}&start=1&length=1`,
                  {
                    headers: { 'User-Agent': environment.userAgent },
                    signal: AbortSignal.timeout(5_000),
                  },
                );
                if (!res.ok) return null;
                const rawText = await res.text();
                const pos = parseAprsPosition(rawText, call);
                if (!pos) return null;
                const reading = parseAprsWxPacket(rawText, nowMs, call);
                if (!isRecentObservation(reading.observedAt, nowMs)) return null;
                return {
                  uid: formatStationUid('cwop', call),
                  vendor: 'cwop' as const,
                  nativeId: call,
                  name: `CWOP ${call}`,
                  latitude: pos.latitude,
                  longitude: pos.longitude,
                  elevationM: null,
                  country: inferRegionCode(pos),
                  region: null,
                  timeZone: null,
                  pageUrl: `http://www.findu.com/cgi-bin/wxpage.cgi?call=${encodeURIComponent(call)}`,
                  category: 'pws' as const,
                  capabilities: {
                    gustLull: true,
                    temperature: true,
                    conditions: true,
                    history: false,
                  },
                  samplingWindowSeconds: 300,
                  recommendedPollSeconds: CACHE_TTL_SECONDS,
                  locator: {
                    callsign: call,
                  },
                } satisfies CatalogueStation;
              } catch {
                return null;
              }
            }),
          );
          for (const st of probed) {
            if (st) discovered.push(st);
          }
        }
        batches.push(discovered);
      } catch {
        // Offline or unmocked environment
      }
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadCwopStation({ station }, { environment, historyHours, mode }),
    );
  },
};

export const windyProvider: StationNetworkProvider = createSeededProvider(
  'windy',
  station =>
    customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadWindyStation({ station }, { environment, historyHours, mode }),
    ),
);

export const wundergroundProvider: StationNetworkProvider = createSeededProvider(
  'wunderground',
  (station: CatalogueStation, credentials?: ProviderCredentials) => {
    const apiKey = credentials?.wuApiKey?.trim();
    if (!apiKey) return unconfiguredCustomStation(station, 'Weather Underground');
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadWuPwsStation({ station, apiKey }, { environment, historyHours, mode }),
    );
  },
);

export const synopticProvider: StationNetworkProvider = createSeededProvider(
  'synoptic',
  (station: CatalogueStation, credentials?: ProviderCredentials) => {
    const token = credentials?.synopticToken?.trim();
    if (!token) return unconfiguredCustomStation(station, 'Synoptic / MesoWest');
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadSynopticStation({ station, token }, { environment, historyHours, mode }),
    );
  },
);

export const ambientProvider: StationNetworkProvider = createSeededProvider(
  'ambient',
  (station: CatalogueStation, credentials?: ProviderCredentials) => {
    const apiKey = credentials?.ambientApiKey?.trim();
    const applicationKey = credentials?.ambientApplicationKey?.trim();
    if (!apiKey || !applicationKey) {
      return unconfiguredCustomStation(station, 'Ambient Weather');
    }
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadAmbientStation(
        { station, apiKey, applicationKey },
        { environment, historyHours, mode },
      ),
    );
  },
);
