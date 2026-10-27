import {
  FEET_TO_METERS,
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
  type ResolvedEnvironment,
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
export const WU_PWS_NEAR_URL = 'https://api.weather.com/v3/location/near';
export const SYNOPTIC_AUTH_URL = 'https://api.synopticdata.com/v2/auth';
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

function parseSynopticObservationsBlock(obs: Record<string, unknown>): Reading | null {
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
  if (!wspd || optionalWindMps(wspd.value) === null) return null;
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
    windGustMps:
      !wgst || optionalWindMps(wgst.value) === null
        ? null
        : plausibleWindMps(wgst.value, 'Synoptic'),
    windLullMps: null,
    temperatureC: validTemperatureC(temp ? temp.value : null),
    windChillC: null,
    conditions: {
      ...emptyConditions(),
      dewPointC: validTemperatureC(dewp ? dewp.value : null),
      relativeHumidityPercent: rh && rh.value >= 0 && rh.value <= 100 ? rh.value : null,
      seaLevelPressureHpa: pressureHpa(slp ? slp.value / 100 : null),
    },
  };
}

export function parseSynopticLatest(text: string, expectedId?: string): Reading {
  const data: unknown = JSON.parse(text);
  const stn =
    isRecord(data) && Array.isArray(data.STATION)
      ? data.STATION.find(
          (row): row is Record<string, unknown> =>
            isRecord(row) && (!expectedId || row.STID === expectedId),
        )
      : null;
  const obs = stn && isRecord(stn.OBSERVATIONS) ? stn.OBSERVATIONS : null;
  if (!obs) throw new Error('Synoptic response is missing STATION[0].OBSERVATIONS');
  const reading = parseSynopticObservationsBlock(obs);
  if (!reading) throw new Error('Synoptic station is missing wind_speed_value');
  return reading;
}

export interface SynopticParsedStation {
  readonly station: CatalogueStation;
  readonly reading: Reading | null;
}

export function parseSynopticStationEntry(raw: unknown): SynopticParsedStation | null {
  if (!isRecord(raw)) return null;
  const stid = typeof raw.STID === 'string' ? raw.STID.trim().toUpperCase() : '';
  if (!stid) return null;

  const latitude = finiteNumber(raw.LATITUDE ?? raw.latitude);
  const longitude = finiteNumber(raw.LONGITUDE ?? raw.longitude);
  if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
    return null;
  }

  const units = isRecord(raw.UNITS) ? raw.UNITS : null;
  const elevRaw = finiteNumber(raw.ELEVATION ?? raw.elevation);
  const elevationM =
    elevRaw === null
      ? null
      : units?.elevation === 'm'
        ? Math.round(elevRaw)
        : Math.round(elevRaw * FEET_TO_METERS);

  const countryHint = typeof raw.COUNTRY === 'string' ? raw.COUNTRY.trim().toUpperCase() : null;
  const country = inferRegionCode({ latitude, longitude }, countryHint);
  const region = typeof raw.STATE === 'string' && raw.STATE.trim() ? raw.STATE.trim() : null;
  const timeZone =
    typeof raw.TIMEZONE === 'string' && raw.TIMEZONE.trim() ? raw.TIMEZONE.trim() : null;
  const name =
    typeof raw.NAME === 'string' && raw.NAME.trim() ? raw.NAME.trim() : `Synoptic ${stid}`;
  const mnetId =
    typeof raw.MNET_ID === 'string' || typeof raw.MNET_ID === 'number'
      ? String(raw.MNET_ID).trim()
      : null;

  const isAsos = mnetId === '1' && /^[A-Z][A-Z0-9]{3}$/.test(stid);
  const isRaws = mnetId === '2';
  const isCwop = mnetId === '65';
  const aliases = isAsos
    ? [formatStationUid('awc', stid)]
    : isCwop
      ? [formatStationUid('cwop', stid)]
      : null;
  const category = isCwop
    ? 'pws'
    : isRaws || mnetId === '29' || mnetId === '99' || mnetId === '283' || (elevationM !== null && elevationM >= 600)
      ? 'mountain'
      : 'synoptic';

  const station: CatalogueStation = {
    uid: formatStationUid('synoptic', stid),
    vendor: 'synoptic',
    nativeId: stid,
    name,
    latitude,
    longitude,
    elevationM,
    country,
    region,
    timeZone,
    pageUrl: `https://explore.synopticdata.com/${encodeURIComponent(stid)}/24h`,
    category,
    ...(aliases ? { aliases } : {}),
    capabilities: {
      gustLull: true,
      temperature: true,
      conditions: true,
      history: false,
    },
    samplingWindowSeconds: 300,
    recommendedPollSeconds: CACHE_TTL_SECONDS,
    locator: {
      stid,
      ...(mnetId ? { mnetId } : {}),
      ...(isAsos ? { icaoId: stid } : {}),
      ...(isRaws && /^[A-Z0-9]{5}$/.test(stid) ? { nwsId: stid } : {}),
    },
  };

  const obs = isRecord(raw.OBSERVATIONS) ? raw.OBSERVATIONS : null;
  const reading = obs ? parseSynopticObservationsBlock(obs) : null;
  return { station, reading };
}

export function parseSynopticLatestStations(text: string): SynopticParsedStation[] {
  const data: unknown = JSON.parse(text);
  const rows = isRecord(data) && Array.isArray(data.STATION) ? data.STATION : [];
  const out: SynopticParsedStation[] = [];
  for (const row of rows) {
    const parsed = parseSynopticStationEntry(row);
    if (parsed) out.push(parsed);
  }
  return out;
}

const inFlightSynopticAuth = new WeakMap<object, Map<string, Promise<string>>>();

export async function resolveSynopticToken(
  tokenOrApiKey: string,
  environment: ResolvedEnvironment,
  authUrl = SYNOPTIC_AUTH_URL,
): Promise<string> {
  const trimmed = tokenOrApiKey.trim();
  if (!trimmed) throw new Error('Synoptic token or API key is empty');
  // Tokens are 32-char hex strings (or short test tokens); API keys are 40+ chars
  if (trimmed.length <= 36) return trimmed;

  const scope = await credentialCacheScope(trimmed);
  const cacheKey = `synoptic/auth/${scope}`;
  const cached = await environment.cache.get(cacheKey);
  if (cached) {
    const parsedCached: unknown = JSON.parse(cached);
    const cachedToken =
      isRecord(parsedCached) && typeof parsedCached.TOKEN === 'string'
        ? parsedCached.TOKEN.trim()
        : '';
    if (cachedToken) return cachedToken;
  }

  let envInFlight = inFlightSynopticAuth.get(environment.cache);
  if (!envInFlight) {
    envInFlight = new Map<string, Promise<string>>();
    inFlightSynopticAuth.set(environment.cache, envInFlight);
  }
  const inflightKey = `${authUrl}|${scope}`;
  const existing = envInFlight.get(inflightKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const url = new URL(authUrl);
      url.searchParams.set('apikey', trimmed);
      const text = await fetchUpstreamText(environment, {
        url,
        cacheKey,
        cacheTtlSeconds: 3_600,
        subject: 'Synoptic API key token exchange',
      });
      const parsed: unknown = JSON.parse(text);
      const token = isRecord(parsed) && typeof parsed.TOKEN === 'string' ? parsed.TOKEN.trim() : '';
      if (!token) throw new Error('Synoptic /v2/auth response did not contain a valid TOKEN');
      return token;
    } finally {
      envInFlight.delete(inflightKey);
    }
  })();

  envInFlight.set(inflightKey, promise);
  return promise;
}

export const loadSynopticStation = defineStationAdapter<
  { readonly station: CatalogueStation; readonly token: string },
  StationAdapterOptions & { readonly synopticUrl?: string; readonly synopticAuthUrl?: string }
>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Synoptic / MesoWest'),
  load: async ({ station, token: rawTokenOrKey }, { environment, options }) => {
    const token = await resolveSynopticToken(
      rawTokenOrKey,
      environment,
      options.synopticAuthUrl,
    );
    const url = new URL(options.synopticUrl ?? SYNOPTIC_LATEST_URL);
    url.searchParams.set('stid', station.nativeId);
    url.searchParams.set('units', 'metric');
    url.searchParams.set('token', token);

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `synoptic/latest/${await credentialCacheScope(rawTokenOrKey)}/${station.nativeId}`,
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
                const rawText = await fetchUpstreamText(environment, {
                  url: `${FINDU_RAW_WX_URL}?call=${encodeURIComponent(call)}&start=1&length=1`,
                  accept: 'text/html,text/plain',
                  cacheKey: `cwop/raw/${call}`,
                  cacheTtlSeconds: CACHE_TTL_SECONDS,
                  subject: `CWOP station ${call}`,
                  timeoutMs: 5_000,
                });
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

const WU_ARMENIA_GEOCODES: readonly Position[] = [
  { latitude: 40.27, longitude: 44.7 }, // Mount Hatis / Kotayk
  { latitude: 40.59, longitude: 44.47 }, // Aparan / Mount Ara
  { latitude: 40.55, longitude: 44.95 }, // Lake Sevan / Tsovagyugh
  { latitude: 40.79, longitude: 43.85 }, // Gyumri / Shirak
  { latitude: 40.75, longitude: 44.87 }, // Dilijan / Ijevan / Tavush
  { latitude: 39.85, longitude: 45.0 }, // Vedi / Areni / Vayots Dzor
  { latitude: 39.45, longitude: 46.25 }, // Goris / Tatev / Syunik
  { latitude: 40.84, longitude: 44.48 }, // Vanadzor / Spitak / Lori
];

const WU_US_LAUNCH_GEOCODES: readonly Position[] = [
  // VA / MD / WV / PA Mid-Atlantic & Appalachian grid (no radius restriction)
  { latitude: 38.8706, longitude: -78.45 }, // Woodstock Tower VA
  { latitude: 38.7251, longitude: -78.5089 }, // Edith's Gap / Luray VA
  { latitude: 38.8537, longitude: -78.2066 }, // Dickey's Ridge / Front Royal VA
  { latitude: 38.405, longitude: -78.765 }, // Massanutten / Harrisonburg VA
  { latitude: 38.3105, longitude: -78.512 }, // Daniels / Charlottesville VA
  { latitude: 37.9336, longitude: -78.9528 }, // Raven's Roost / Wintergreen VA
  { latitude: 37.6314, longitude: -79.8317 }, // Eagle Rock / Botetourt VA
  { latitude: 37.27, longitude: -79.94 }, // Roanoke / Blue Ridge VA
  { latitude: 37.13, longitude: -80.41 }, // Blacksburg / New River Valley VA
  { latitude: 39.18, longitude: -78.16 }, // Winchester / Northern Shenandoah VA
  { latitude: 39.11, longitude: -77.56 }, // Leesburg / Loudoun VA
  { latitude: 38.67, longitude: -78.32 }, // Thornton Gap / Panorama VA
  { latitude: 38.03, longitude: -79.07 }, // Waynesboro / Afton Mtn VA
  { latitude: 37.5131, longitude: -80.4329 }, // Peter's Mountain WV/VA
  { latitude: 37.8, longitude: -80.45 }, // Lewisburg / Greenbrier WV
  { latitude: 37.78, longitude: -81.19 }, // Beckley / New River Gorge WV
  { latitude: 38.2043, longitude: -80.2273 }, // Cranberry Mountain / Marlinton WV
  { latitude: 38.4211, longitude: -79.9966 }, // Snowshoe Mountain WV
  { latitude: 38.7401, longitude: -79.62 }, // Pharis Knob / Seneca Rocks / Spruce Knob WV
  { latitude: 38.9989, longitude: -79.4352 }, // Canaan Valley / Davis WV
  { latitude: 39.002, longitude: -79.4679 }, // Pointy Knob / Dolly Sods WV
  { latitude: 38.89, longitude: -79.85 }, // Elkins / Bickle Knob WV
  { latitude: 39.65, longitude: -79.96 }, // Morgantown / Coopers Rock WV
  { latitude: 39.45, longitude: -77.96 }, // Martinsburg / Eastern Panhandle WV
  { latitude: 39.65, longitude: -78.76 }, // Cumberland / Dans Mountain MD
  { latitude: 39.55, longitude: -79.35 }, // Deep Creek / Wisp / Garrett County MD
  { latitude: 39.6961, longitude: -77.5161 }, // High Rock / Pen Mar / Quirauk MD
  { latitude: 39.41, longitude: -77.41 }, // Frederick / Catoctin Mountain MD
  { latitude: 39.9144, longitude: -77.9583 }, // Pulpit / Tuscarora PA/MD
  { latitude: 40.0972, longitude: -78.0909 }, // Bill's Hill PA/MD
  { latitude: 39.7947, longitude: -76.647 }, // Shoestring Airpark 0P2 PA/MD
  // Additional North American soaring hubs
  { latitude: 36.3, longitude: -81.72 }, // Tater Hill / Boone NC
  { latitude: 35.35, longitude: -85.4 }, // Henson Gap / Sequatchie TN
  { latitude: 34.89, longitude: -85.46 }, // Lookout Mountain GA
  { latitude: 43.37, longitude: -72.36 }, // Morningside NH / VT
  { latitude: 40.0631, longitude: -105.2989 }, // Boulder CO
  { latitude: 39.7449, longitude: -105.2411 }, // Lookout Mountain Golden CO
  { latitude: 40.4535, longitude: -111.9032 }, // Point of the Mountain UT
  { latitude: 38.5362, longitude: -112.073 }, // Monroe Peak / Cove UT
  { latitude: 37.6666, longitude: -122.4949 }, // Mussel Rock / Funston CA
  { latitude: 34.45, longitude: -119.7 }, // Santa Barbara CA
  { latitude: 34.22, longitude: -117.3 }, // Crestline / Marshall CA
  { latitude: 32.89, longitude: -117.25 }, // Torrey Pines CA
  { latitude: 42.2317, longitude: -123.004 }, // Woodrat Mountain OR
  { latitude: 45.7, longitude: -121.88 }, // Columbia River Gorge WA/OR
  { latitude: 47.4995, longitude: -122.009 }, // Tiger Mountain WA
  { latitude: 47.8042, longitude: -120.039 }, // Chelan Butte WA
  { latitude: 48.6097, longitude: -122.426 }, // Blanchard WA
  { latitude: 49.2, longitude: -121.9 }, // Fraser Valley / Woodside BC
  { latitude: 51.27, longitude: -116.9 }, // Golden / Mount 7 BC
  { latitude: 19.16, longitude: -100.12 }, // Valle de Bravo MX
];

export function parseWuNearLocations(
  text: string,
  maxDistanceKm = Infinity,
  allowAllInArmenia = true,
): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  const loc = isRecord(data) && isRecord(data.location) ? data.location : null;
  if (!loc || !Array.isArray(loc.stationId)) return [];

  const ids = loc.stationId;
  const names = Array.isArray(loc.stationName) ? loc.stationName : [];
  const lats = Array.isArray(loc.latitude) ? loc.latitude : [];
  const lons = Array.isArray(loc.longitude) ? loc.longitude : [];
  const countries = Array.isArray(loc.country) ? loc.country : [];
  const states = Array.isArray(loc.adminDistrictCode) ? loc.adminDistrictCode : [];
  const distances = Array.isArray(loc.distanceKm) ? loc.distanceKm : [];

  const out: CatalogueStation[] = [];
  for (let i = 0; i < ids.length; i += 1) {
    const rawId = ids[i];
    if (typeof rawId !== 'string' || !rawId.trim()) continue;
    const nativeId = rawId.trim().toUpperCase();
    const latitude = finiteNumber(lats[i]);
    const longitude = finiteNumber(lons[i]);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }

    const rawCountry = typeof countries[i] === 'string' ? countries[i].trim().toUpperCase() : null;
    const isArmenia =
      rawCountry === 'AM' ||
      (latitude >= 38.84 &&
        latitude <= 41.3 &&
        longitude >= 43.44 &&
        longitude <= 46.63 &&
        !(longitude > 45.4 && latitude > 40.55));
    const distKm = finiteNumber(distances[i]);
    if (!allowAllInArmenia || !isArmenia) {
      if (distKm !== null && distKm > maxDistanceKm) continue;
    }

    const country = inferRegionCode({ latitude, longitude }, isArmenia ? 'AM' : rawCountry);
    const region =
      typeof states[i] === 'string' && states[i].trim() ? states[i].trim() : null;
    const rawName =
      typeof names[i] === 'string' && names[i].trim() ? names[i].trim() : `WU ${nativeId}`;

    out.push({
      uid: formatStationUid('wunderground', nativeId),
      vendor: 'wunderground',
      nativeId,
      name: `${rawName} (${nativeId})`,
      latitude,
      longitude,
      elevationM: null,
      country,
      region,
      timeZone: isArmenia ? 'Asia/Yerevan' : null,
      pageUrl: `https://www.wunderground.com/dashboard/pws/${encodeURIComponent(nativeId)}`,
      category: 'pws',
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
      },
    });
  }
  return out;
}

export const wundergroundProvider: StationNetworkProvider = {
  vendor: 'wunderground',
  coverage: cwopCoverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'wunderground');
    const batches: CatalogueStation[][] = [seeds];
    const apiKey = options.credentials?.wuApiKey?.trim();

    if (options.includeRemoteDiscovery !== false && apiKey) {
      const environment = resolveEnvironment(options.environment);
      const nowMs = environment.now().getTime();
      const regions = options.regions ?? INITIAL_SCOPE_REGIONS;
      const scopeKey = await credentialCacheScope(apiKey);
      const candidatesByUid = new Map<string, CatalogueStation>();

      const probeList: { pos: Position; maxKm: number; isAm: boolean }[] = [];
      if (regions.includes('AM')) {
        for (const pos of WU_ARMENIA_GEOCODES) {
          probeList.push({ pos, maxKm: Infinity, isAm: true });
        }
      }
      if (regions.includes('US') || regions.includes('CA') || regions.includes('MX')) {
        for (const pos of WU_US_LAUNCH_GEOCODES) {
          probeList.push({ pos, maxKm: Infinity, isAm: false });
        }
      }

      const concurrency = 6;
      for (let i = 0; i < probeList.length; i += concurrency) {
        const slice = probeList.slice(i, i + concurrency);
        const foundBatches = await Promise.all(
          slice.map(async ({ pos, maxKm, isAm }) => {
            try {
              const url = new URL(WU_PWS_NEAR_URL);
              url.searchParams.set('geocode', `${pos.latitude},${pos.longitude}`);
              url.searchParams.set('product', 'pws');
              url.searchParams.set('format', 'json');
              url.searchParams.set('apiKey', apiKey);
              const text = await fetchUpstreamText(environment, {
                url,
                cacheKey: `wunderground/near/${scopeKey}/${pos.latitude},${pos.longitude}`,
                cacheTtlSeconds: 3_600,
                subject: `WU PWS near (${pos.latitude}, ${pos.longitude})`,
                timeoutMs: 6_000,
              });
              return parseWuNearLocations(text, maxKm, isAm);
            } catch {
              return [];
            }
          }),
        );
        for (const batch of foundBatches) {
          for (const st of batch) candidatesByUid.set(st.uid, st);
        }
      }

      const candidates = [...candidatesByUid.values()];
      const active: CatalogueStation[] = [];
      const verifyConcurrency = 10;
      for (let i = 0; i < candidates.length; i += verifyConcurrency) {
        const slice = candidates.slice(i, i + verifyConcurrency);
        const checked = await Promise.all(
          slice.map(async candidate => {
            try {
              const url = new URL(WU_PWS_CURRENT_URL);
              url.searchParams.set('stationId', candidate.nativeId);
              url.searchParams.set('format', 'json');
              url.searchParams.set('units', 'm');
              url.searchParams.set('numericPrecision', 'decimal');
              url.searchParams.set('apiKey', apiKey);
              const text = await fetchUpstreamText(environment, {
                url,
                cacheKey: `wunderground/current/${scopeKey}/${candidate.nativeId}`,
                cacheTtlSeconds: CACHE_TTL_SECONDS,
                subject: `WU PWS ${candidate.nativeId}`,
                timeoutMs: 5_000,
              });
              const reading = parseWuPwsCurrent(text, candidate.nativeId);
              return isRecentObservation(reading.observedAt, nowMs) ? candidate : null;
            } catch {
              return null;
            }
          }),
        );
        for (const st of checked) {
          if (st) active.push(st);
        }
      }
      batches.push(active);
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation, credentials?: ProviderCredentials): StationConfigInput {
    const apiKey = credentials?.wuApiKey?.trim();
    if (!apiKey) return unconfiguredCustomStation(station, 'Weather Underground');
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadWuPwsStation({ station, apiKey }, { environment, historyHours, mode }),
    );
  },
};

const SYNOPTIC_US_STATE_BATCHES: readonly string[] = [
  'AK,WA,OR,ID,MT,WY,HI',
  'CA,NV,UT,AZ,NM,CO',
  'ND,SD,NE,KS,OK,TX,MN,IA,MO',
  'AR,LA,WI,IL,MI,IN,OH,KY,TN',
  'MS,AL,GA,FL,SC,NC,VA,WV',
  'MD,DE,PA,NJ,NY,CT,RI,MA,VT,NH,ME,DC,PR',
];

export const synopticProvider: StationNetworkProvider = {
  vendor: 'synoptic',
  coverage: cwopCoverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'synoptic');
    const batches: CatalogueStation[][] = [seeds];
    const rawCred =
      options.credentials?.synopticToken?.trim() ||
      options.credentials?.synopticApiKey?.trim();

    if (options.includeRemoteDiscovery !== false && rawCred) {
      const environment = resolveEnvironment(options.environment);
      const nowMs = environment.now().getTime();
      const regions = options.regions ?? INITIAL_SCOPE_REGIONS;
      try {
        const token = await resolveSynopticToken(rawCred, environment);
        const scopeKey = await credentialCacheScope(rawCred);
        const queries: { key: string; param: [string, string] }[] = [];
        if (options.bounds) {
          const bbox = options.bounds.join(',');
          queries.push({ key: `bbox:${bbox}`, param: ['bbox', bbox] });
        } else {
          if (regions.includes('US')) {
            for (const [idx, stateGroup] of SYNOPTIC_US_STATE_BATCHES.entries()) {
              queries.push({
                key: `us-batch-${idx}`,
                param: ['state', stateGroup],
              });
            }
          }
          for (const country of ['CA', 'MX', 'AM'] as const) {
            if (regions.includes(country)) {
              queries.push({
                key: `country:${country}`,
                param: ['country', country],
              });
            }
          }
        }

        for (const query of queries) {
          try {
            const url = new URL(SYNOPTIC_LATEST_URL);
            url.searchParams.set(query.param[0], query.param[1]);
            url.searchParams.set('vars', 'wind_speed');
            url.searchParams.set('within', '43200');
            url.searchParams.set('units', 'metric');
            url.searchParams.set('token', token);

            const text = await fetchUpstreamText(environment, {
              url,
              cacheKey: `synoptic/discover/${scopeKey}/${query.key}`,
              cacheTtlSeconds: 900,
              subject: `Synoptic discovery ${query.key}`,
              timeoutMs: 18_000,
              limitBytes: 24 * 1024 * 1024,
            });
            const parsed = parseSynopticLatestStations(text).filter(
              entry =>
                entry.reading !== null &&
                isRecentObservation(entry.reading.observedAt, nowMs),
            );
            batches.push(parsed.map(entry => entry.station));
          } catch {
            // Best-effort regional query
          }
        }
      } catch {
        // Fallback to seeds if token exchange fails
      }
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation, credentials?: ProviderCredentials): StationConfigInput {
    const token =
      credentials?.synopticToken?.trim() || credentials?.synopticApiKey?.trim();
    if (!token) return unconfiguredCustomStation(station, 'Synoptic / MesoWest');
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadSynopticStation({ station, token }, { environment, historyHours, mode }),
    );
  },
};

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
