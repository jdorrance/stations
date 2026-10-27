import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  type AirConditions,
  type Reading,
  type StationTelemetry,
} from '@azohra/meteo.station';
import {
  boundedResponseText,
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
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import type {
  DiscoverOptions,
  ProviderCredentials,
  StationNetworkProvider,
} from './types.ts';
import { credentialCacheScope, observationTimeIso } from './freeflight-observations.ts';
import {
  FEET_TO_METERS,
  finiteNumber,
  isRecentObservation,
  isRecord,
  utcObservationTimeMs,
  windDirection,
} from './observation-values.ts';

export const HOLFUY_LIVE_URL = 'https://api.holfuy.com/live/';
export const HOLFUY_STATIONS_LIST_URL = 'https://api.holfuy.com/stations/stations.json';
export const HOLFUY_PAGE_URL = 'https://holfuy.com/en/weather';
export const HOLFUY_WIDGET_JSON_URL = 'https://holfuy.com/puget/mjso.php';
const CACHE_TTL_SECONDS = 60;

export type HolfuyStationConfig = {
  readonly station: CatalogueStation;
  readonly password?: string;
};

export type HolfuyAdapterOptions = StationAdapterOptions & {
  readonly baseUrl?: string;
  readonly pageBaseUrl?: string;
  readonly widgetJsonUrl?: string;
};

export interface HolfuyObservation {
  readonly reading: Reading;
  readonly telemetry: StationTelemetry | null;
}

function parseHolfuySpeedMps(value: unknown, speedUnit: string): number | null {
  const n = finiteNumber(value);
  if (n === null) return null;
  const normalizedUnit = speedUnit.trim().toLowerCase();
  if (!['km/h', 'kmh', 'mph', 'knots', 'kt', 'm/s'].includes(normalizedUnit)) {
    throw new Error(`Holfuy returned unsupported wind unit: ${speedUnit}`);
  }
  const mps =
    normalizedUnit === 'km/h' || normalizedUnit === 'kmh'
      ? kmhToMps(n)
      : normalizedUnit === 'mph'
        ? n * 0.44704
        : normalizedUnit === 'knots' || normalizedUnit === 'kt'
          ? n * 0.5144444444444445
          : n;
  return plausibleWindMps(mps, 'Holfuy');
}

export function parseHolfuyObservation(text: string, expectedStationId: string): HolfuyObservation {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw new Error('Holfuy returned non-object payload');
  if (typeof data.error === 'string') {
    throw new Error(`Holfuy error: ${data.error}`);
  }
  const stationId = data.stationId !== undefined ? String(data.stationId) : null;
  if (stationId !== expectedStationId) {
    throw new Error(`Holfuy returned wrong stationId (expected ${expectedStationId})`);
  }

  const dateTimeRaw = typeof data.dateTime === 'string' ? data.dateTime.trim() : null;
  if (!dateTimeRaw) throw new Error('Holfuy payload is missing dateTime');
  const observedAtMs = utcObservationTimeMs(dateTimeRaw);
  if (!Number.isFinite(observedAtMs)) {
    throw new Error('Holfuy returned invalid dateTime');
  }

  const windBlock = isRecord(data.wind) ? data.wind : data;
  const speedUnit = typeof windBlock.unit === 'string' ? windBlock.unit : 'm/s';
  const windAvgMps = parseHolfuySpeedMps(windBlock.speed, speedUnit);
  if (windAvgMps === null) throw new Error('Holfuy payload is missing wind speed');

  const windGustMps = parseHolfuySpeedMps(windBlock.gust, speedUnit);
  const windLullMps = parseHolfuySpeedMps(windBlock.min, speedUnit);
  const directionRaw = finiteNumber(windBlock.direction);

  const temperatureC = finiteNumber(data.temperature);
  const humidity = finiteNumber(data.humidity);
  const pressure = finiteNumber(data.pressure);
  const hasConditions = humidity !== null || pressure !== null;
  const conditions: AirConditions | null = hasConditions
    ? {
        ...emptyConditions(),
        relativeHumidityPercent:
          humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
        seaLevelPressureHpa:
          pressure !== null && pressure >= 300 && pressure <= 1100 ? pressure : null,
      }
    : null;

  const battery = finiteNumber(data.battery);
  const telemetry: StationTelemetry | null =
    battery !== null && battery >= 0 && battery <= 100 ? { batteryVoltage: battery } : null;

  return {
    reading: {
      observedAt: new Date(observedAtMs).toISOString(),
      windAvgMps,
      windDirectionDeg:
        isCalm(windAvgMps) ? null : windDirection(directionRaw),
      windGustMps,
      windLullMps,
      temperatureC,
      windChillC: null,
      conditions,
    },
    telemetry,
  };
}

function parseHolfuyRelativeUpdatedIso(updated: unknown, referenceNowMs?: number): string | null {
  if (typeof updated !== 'string' || referenceNowMs === undefined || !Number.isFinite(referenceNowMs)) {
    return null;
  }
  const clean = updated.replace(/<[^>]+>/g, ' ').trim();
  const match = clean.match(/^(\d+)\s*(sec|second|min|minute|hour|hr|day)s?\.?\s*ago$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const multiplierMs =
    unit.startsWith('sec')
      ? 1_000
      : unit.startsWith('min')
        ? 60_000
        : unit.startsWith('h')
          ? 3_600_000
          : 86_400_000;
  return new Date(referenceNowMs - amount * multiplierMs).toISOString();
}

/**
 * Parses Holfuy's public keyless widget endpoint (`https://holfuy.com/puget/mjso.php?k={id}`).
 * Speeds from `mjso.php` default to km/h unless `su` / `unit` states otherwise.
 */
export function parseHolfuyWidgetJson(text: string, referenceNowMs?: number): HolfuyObservation {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data)) throw new Error('Holfuy widget returned non-object payload');
  if (data.valid === false || (typeof data.valid === 'string' && data.valid !== 'ok')) {
    throw new Error('Holfuy widget reported no active station data');
  }
  if (data.s !== undefined && data.timestamp === undefined && data.ts === undefined) {
    throw new Error('Holfuy widget returned session decoy payload');
  }
  const observedAt =
    observationTimeIso(data.timestamp ?? data.ts ?? data.dateTime ?? data.time) ??
    parseHolfuyRelativeUpdatedIso(data.updated, referenceNowMs);
  if (!observedAt) throw new Error('Holfuy widget is missing an observation timestamp');
  const speedUnit = typeof data.su === 'string' ? data.su : typeof data.unit === 'string' ? data.unit : 'km/h';
  const windAvgMps = parseHolfuySpeedMps(data.speed ?? data.wind_speed, speedUnit);
  if (windAvgMps === null) throw new Error('Holfuy widget payload is missing speed');

  const windGustMps = parseHolfuySpeedMps(data.gust ?? data.wind_gust, speedUnit);
  const windLullMps = parseHolfuySpeedMps(data.min ?? data.lull, speedUnit);
  const dirDeg = finiteNumber(data.dir ?? data.direction);
  const temperatureC = finiteNumber(data.temperature ?? data.temp);
  const humidity = finiteNumber(data.humidity ?? data.rh);
  const pressure = finiteNumber(data.pressure ?? data.baro);

  const conditions: AirConditions | null =
    humidity !== null || pressure !== null
      ? {
          ...emptyConditions(),
          relativeHumidityPercent:
            humidity !== null && humidity >= 0 && humidity <= 100 ? humidity : null,
          seaLevelPressureHpa:
            pressure !== null && pressure >= 300 && pressure <= 1100 ? pressure : null,
        }
      : null;

  return {
    reading: {
      observedAt,
      windAvgMps,
      windDirectionDeg: isCalm(windAvgMps) ? null : windDirection(dirDeg),
      windGustMps,
      windLullMps,
      temperatureC,
      windChillC: null,
      conditions,
    },
    telemetry: null,
  };
}

function normalizeHolfuyCountry(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (['US', 'U1', 'UM', 'UE'].includes(code)) return 'US';
  if (['CA', 'C1', 'C2', 'C3'].includes(code)) return 'CA';
  if (code === 'MX') return 'MX';
  if (code === 'AM') return 'AM';
  return code || null;
}

function decodeHtmlText(raw: string): string {
  return raw
    .replace(/&amp;/gi, '&')
    .replace(/&period;/gi, '.')
    .replace(/&comma;/gi, ',')
    .replace(/&apos;|&#0?39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&oslash;/gi, 'ø')
    .replace(/&aring;/gi, 'å')
    .replace(/&auml;/gi, 'ä')
    .replace(/&ouml;/gi, 'ö')
    .replace(/&uuml;/gi, 'ü')
    .replace(/&eacute;/gi, 'é')
    .replace(/&egrave;/gi, 'è')
    .replace(/&ntilde;/gi, 'ñ')
    .replace(/&oacute;/gi, 'ó')
    .replace(/&aacute;/gi, 'á')
    .replace(/&iacute;/gi, 'í')
    .replace(/&uacute;/gi, 'ú')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFavorableDirections(
  start1: unknown,
  end1: unknown,
  start2?: unknown,
  end2?: unknown,
): { fromDeg: number; toDeg: number }[] | undefined {
  const arcs: { fromDeg: number; toDeg: number }[] = [];
  for (const [sRaw, eRaw] of [
    [start1, end1],
    [start2, end2],
  ]) {
    const fromDeg = finiteNumber(sRaw);
    const toDeg = finiteNumber(eRaw);
    if (
      fromDeg !== null &&
      toDeg !== null &&
      fromDeg >= 0 &&
      fromDeg <= 360 &&
      toDeg >= 0 &&
      toDeg <= 360 &&
      fromDeg !== toDeg &&
      !(fromDeg === 0 && toDeg === 360)
    ) {
      arcs.push({ fromDeg: fromDeg % 360, toDeg: toDeg % 360 });
    }
  }
  return arcs.length > 0 ? arcs : undefined;
}

export function parseHolfuyStationsList(text: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  const list =
    isRecord(data) && Array.isArray(data.holfuyStationsList)
      ? data.holfuyStationsList
      : Array.isArray(data)
        ? data
        : [];
  const stations: CatalogueStation[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    const idRaw = row.id ?? row.stationId;
    if (typeof idRaw !== 'number' && typeof idRaw !== 'string') continue;
    const nativeId = String(idRaw).trim();
    if (!nativeId) continue;
    const loc = isRecord(row.location) ? row.location : row;
    const latitude = finiteNumber(loc.latitude ?? loc.lat);
    const longitude = finiteNumber(loc.longitude ?? loc.lon);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }
    if (latitude === 0 && longitude === 0) continue;
    const countryHint = normalizeHolfuyCountry(loc.countryCode ?? row.country);
    const country = inferRegionCode({ latitude, longitude }, countryHint);
    const elevationM = finiteNumber(loc.altitude ?? loc.elevation);
    const name =
      typeof row.name === 'string' && row.name.trim() ? row.name.trim() : `Holfuy ${nativeId}`;
    const zones = isRecord(row.directionZones) ? row.directionZones : null;
    const green = zones && isRecord(zones.green) ? zones.green : null;
    const declaredFavorableDirections = green
      ? extractFavorableDirections(green.start, green.stop)
      : undefined;

    stations.push({
      uid: formatStationUid('holfuy', nativeId),
      vendor: 'holfuy',
      nativeId,
      name,
      latitude,
      longitude,
      elevationM: elevationM !== null ? Math.round(elevationM) : null,
      country,
      region: null,
      timeZone: null,
      pageUrl: `https://holfuy.com/en/weather/${encodeURIComponent(nativeId)}`,
      category: 'freeflight',
      ...(declaredFavorableDirections ? { declaredFavorableDirections } : {}),
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: true,
        history: false,
        battery: true,
      },
      samplingWindowSeconds: 60,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationId: Number.isFinite(Number(nativeId)) ? Number(nativeId) : nativeId,
      },
    });
  }
  return stations;
}

export function parseHolfuyWeatherPageHtml(
  html: string,
  fallbackId?: string,
  baseStation?: CatalogueStation,
): { station: CatalogueStation; isActive: boolean } | null {
  const stattrMatch = html.match(/var\s+stattr\s*=\s*(\{[^;]+\})/);
  if (!stattrMatch) return null;
  let stattr: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(stattrMatch[1]!);
    if (!isRecord(parsed)) return null;
    stattr = parsed;
  } catch {
    return null;
  }

  const nativeId = String(stattr.id ?? fallbackId ?? '').trim();
  if (!nativeId || (fallbackId !== undefined && nativeId !== String(fallbackId).trim())) {
    return null;
  }

  const mapMatch = html.match(/\/map\/la=([-0-9.]+)&lo=([-0-9.]+)/i);
  const latitude = mapMatch ? finiteNumber(mapMatch[1]) : (baseStation?.latitude ?? null);
  const longitude = mapMatch ? finiteNumber(mapMatch[2]) : (baseStation?.longitude ?? null);
  if (
    latitude === null ||
    longitude === null ||
    !validPosition({ latitude, longitude }) ||
    (latitude === 0 && longitude === 0)
  ) {
    return null;
  }

  const ctitleMatch = html.match(/<span\s+class=["']ctitle["']>([^<]+)<\/span>/i);
  const rawTitle = ctitleMatch?.[1] ? decodeHtmlText(ctitleMatch[1]) : '';
  const name = rawTitle || baseStation?.name || `Holfuy ${nativeId}`;

  const altScriptMatch = html.match(/stattr\.altitude\s*=\s*([-0-9.]+)/i);
  const altHtmlMatch = html.match(/<b>\s*([-0-9.]+)\s*(m|ft)\s*<\/b>\s*\(AMSL\)/i);
  let elevationM = baseStation?.elevationM ?? null;
  if (altScriptMatch) {
    const val = finiteNumber(altScriptMatch[1]);
    if (val !== null) elevationM = Math.round(val);
  } else if (altHtmlMatch) {
    const val = finiteNumber(altHtmlMatch[1]);
    const unit = altHtmlMatch[2]?.toLowerCase();
    if (val !== null) {
      elevationM = Math.round(unit === 'ft' ? val * FEET_TO_METERS : val);
    }
  }

  const countryHint = normalizeHolfuyCountry(stattr.country);
  const country = inferRegionCode({ latitude, longitude }, countryHint);
  const declaredFavorableDirections =
    extractFavorableDirections(stattr.o_s, stattr.o_e, stattr.o2_s, stattr.o2_e) ??
    baseStation?.declaredFavorableDirections ??
    undefined;

  const isActive = /Speed<\/td>(?:<td>-<\/td>)*<td style="background:/i.test(html);

  const station: CatalogueStation = {
    uid: formatStationUid('holfuy', nativeId),
    vendor: 'holfuy',
    nativeId,
    name,
    latitude,
    longitude,
    elevationM,
    country,
    region: baseStation?.region ?? null,
    timeZone: baseStation?.timeZone ?? null,
    pageUrl: `https://holfuy.com/en/weather/${encodeURIComponent(nativeId)}`,
    category: 'freeflight',
    ...(declaredFavorableDirections ? { declaredFavorableDirections } : {}),
    capabilities: {
      gustLull: true,
      temperature: true,
      conditions: true,
      history: false,
      battery: true,
    },
    samplingWindowSeconds: 60,
    recommendedPollSeconds: CACHE_TTL_SECONDS,
    locator: {
      stationId: Number.isFinite(Number(nativeId)) ? Number(nativeId) : nativeId,
    },
  };

  return { station, isActive };
}

async function fetchHolfuyKeylessWidget(
  environment: ResolvedEnvironment,
  stationId: string,
  options: HolfuyAdapterOptions,
): Promise<HolfuyObservation> {
  const cached = await environment.cache.get(`holfuy/widget/${stationId}`);
  if (cached !== null) {
    return parseHolfuyWidgetJson(cached);
  }

  const pageUrl = `${options.pageBaseUrl ?? HOLFUY_PAGE_URL}/${encodeURIComponent(stationId)}`;
  const pageRes = await environment.fetch(pageUrl, {
    headers: { 'User-Agent': environment.userAgent },
    signal: AbortSignal.timeout(8_000),
    redirect: 'error',
  });
  if (!pageRes.ok) {
    throw new Error(`Holfuy page returned ${pageRes.status}`);
  }
  const cookieHeader = pageRes.headers.get('set-cookie')?.split(';')[0] ?? '';
  try {
    await pageRes.body?.cancel();
  } catch {
    // ignore
  }

  const widgetUrl = `${options.widgetJsonUrl ?? HOLFUY_WIDGET_JSON_URL}?k=${encodeURIComponent(stationId)}`;
  const widgetRes = await environment.fetch(widgetUrl, {
    headers: {
      Accept: 'application/json',
      'User-Agent': environment.userAgent,
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      Referer: pageUrl,
    },
    signal: AbortSignal.timeout(8_000),
    redirect: 'error',
  });
  if (!widgetRes.ok) {
    throw new Error(`Holfuy widget endpoint returned ${widgetRes.status}`);
  }
  const text = await boundedResponseText(widgetRes, 128 * 1024, 'Holfuy widget');
  const observation = parseHolfuyWidgetJson(text, environment.now().getTime());
  const normalizedPayload = JSON.stringify({
    ...JSON.parse(text),
    timestamp: observation.reading.observedAt,
  });
  await environment.cache.put(`holfuy/widget/${stationId}`, normalizedPayload, CACHE_TTL_SECONDS);
  return observation;
}

export const loadHolfuyStation = defineStationAdapter<HolfuyStationConfig, HolfuyAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'Holfuy'),
  load: async ({ station, password }, { environment, options }) => {
    const url = new URL(options.baseUrl ?? HOLFUY_LIVE_URL);
    url.searchParams.set('s', station.nativeId);
    if (password) url.searchParams.set('pw', password);
    url.searchParams.set('m', 'JSON');
    url.searchParams.set('tu', 'C');
    url.searchParams.set('su', 'm/s');
    url.searchParams.set('utc', '');
    if (station.capabilities.battery) {
      url.searchParams.set('batt', '');
    }

    try {
      const text = await fetchUpstreamText(environment, {
        url,
        cacheKey: `holfuy/${await credentialCacheScope(password)}/${station.nativeId}/${station.capabilities.battery ? 'battery' : 'basic'}`,
        cacheTtlSeconds: CACHE_TTL_SECONDS,
        subject: `Holfuy station ${station.nativeId}`,
      });
      const observation = parseHolfuyObservation(text, station.nativeId);
      return {
        reading: observation.reading,
        history: null,
        telemetry: observation.telemetry,
      };
    } catch (apiError) {
      if (password) throw apiError;
      const widgetObs = await fetchHolfuyKeylessWidget(environment, station.nativeId, options);
      return {
        reading: widgetObs.reading,
        history: null,
        telemetry: widgetObs.telemetry,
      };
    }
  },
});

const coverage: Coverage = { kind: 'global' };

export const holfuyProvider: StationNetworkProvider = {
  vendor: 'holfuy',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'holfuy');
    const batches: CatalogueStation[][] = [seeds];
    let discoveredGlobal = false;
    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      try {
        const text = await fetchUpstreamText(environment, {
          url: HOLFUY_STATIONS_LIST_URL,
          cacheKey: 'holfuy/stations/all',
          cacheTtlSeconds: 3_600,
          subject: 'Holfuy stations list',
          limitBytes: 2 * 1024 * 1024,
        });
        const baseList = parseHolfuyStationsList(text);
        const byId = new Map(baseList.map(station => [station.nativeId, station]));
        if (baseList.length > 50) {
          discoveredGlobal = true;
          const maxId = Math.max(2120, ...baseList.map(st => Number(st.nativeId) || 0));
          const allIds = Array.from({ length: maxId }, (_, index) => String(index + 1));
          const active: CatalogueStation[] = [];
          const concurrency = 28;
          for (let index = 0; index < allIds.length; index += concurrency) {
            const slice = allIds.slice(index, index + concurrency);
            const probed = await Promise.all(
              slice.map(async probeId => {
                try {
                  const html = await fetchUpstreamText(environment, {
                    url: `${HOLFUY_PAGE_URL}/${encodeURIComponent(probeId)}`,
                    accept: 'text/html,*/*',
                    cacheKey: `holfuy/page/${probeId}`,
                    cacheTtlSeconds: 1_800,
                    subject: `Holfuy station page ${probeId}`,
                    timeoutMs: 6_000,
                  });
                  const parsed = parseHolfuyWeatherPageHtml(html, probeId, byId.get(probeId));
                  return parsed && parsed.isActive ? parsed.station : null;
                } catch {
                  return null;
                }
              }),
            );
            for (const station of probed) {
              if (station) active.push(station);
            }
          }
          batches.push(active);
        } else {
          batches.push(baseList);
        }
      } catch {
        // Fallback to seeds + winds.mobi unwrapping
      }
    }
    const merged = mergeCatalogueStations(batches);
    if (discoveredGlobal && !options.bounds) {
      return merged;
    }
    return filterCatalogueStations(merged, {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(
    station: CatalogueStation,
    credentials?: ProviderCredentials,
  ): StationConfigInput {
    const password =
      credentials?.holfuyPasswords?.[station.nativeId] ??
      credentials?.holfuyApiKey;
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadHolfuyStation({ station, password }, { environment, historyHours, mode }),
    );
  },
};
