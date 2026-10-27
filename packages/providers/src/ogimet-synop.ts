import { plausibleWindMps } from '@azohra/meteo.core';
import {
  emptyConditions,
  isCalm,
  type AirConditions,
  type History,
  type HistoryPoint,
  type Reading,
} from '@azohra/meteo.station';
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
  type Coverage,
  type RegionCode,
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import {
  KNOTS_TO_MPS,
  isRecentObservation,
  optionalWindMps,
  pressureHpa,
  relativeHumidityFromDewPoint,
  utcPartsMs,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { defineStationAdapter, resolveEnvironment } from './server.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

export const OGIMET_GETSYNOP_URL = 'https://www.ogimet.com/cgi-bin/getsynop';

const DEFAULT_CACHE_TTL_SECONDS = 900;

export interface OgimetWmoStationMeta {
  readonly wmoId: string;
  readonly name: string;
  /** Administrative/local region when known from a trusted source; else null. */
  readonly region: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly elevationM: number;
  readonly timeZone?: string;
}

export interface OgimetSynopProviderOptions {
  readonly vendor: Exclude<StationVendor, 'custom'>;
  readonly region: RegionCode;
  /** Ogimet `state=` query value (e.g. `Arme`, `New Zealand`). */
  readonly stateQuery: string;
  readonly stations: readonly OgimetWmoStationMeta[];
  readonly defaultTimeZone: string;
  readonly sourceLabel: string;
  readonly nameSuffix: (meta: OgimetWmoStationMeta) => string;
  readonly cacheTtlSeconds?: number;
}

export type OgimetSynopStationConfig = {
  readonly station: CatalogueStation;
};

export type OgimetSynopAdapterOptions = StationAdapterOptions & {
  readonly getsynopUrl?: string;
};

/**
 * Parses a single Ogimet WMO FM-12 SYNOP CSV line:
 * Example: `37699,2026,10,26,12,00,AAXX 26121 37699 32698 51301 10118 20060 38154 48542 57004 85200=`
 */
export function parseOgimetSynopLine(
  line: string,
): { wmoId: string; reading: Reading } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const match = trimmed.match(
    /^(\d{5}),(\d{4}),(\d{2}),(\d{2}),(\d{2}),(\d{2}),AAXX\s+(\d{2})(\d{2})([0134/])\s+(\d{5})\s+([^\s=]+)\s+([^\s=]+)(.*)$/,
  );
  if (!match) return null;

  const [, csvWmoId, yearStr, monthStr, dayStr, hourStr, minStr, , , iwChar, bodyWmoId, , nddffGroup, rest = ''] = match;
  if (csvWmoId !== bodyWmoId) return null;
  const observedAtMs = utcPartsMs(
    Number(yearStr),
    Number(monthStr),
    Number(dayStr),
    Number(hourStr),
    Number(minStr),
  );
  if (!Number.isFinite(observedAtMs)) return null;

  if (!/^[0-9/](\d{2})(\d{2})$/.test(nddffGroup!)) return null;
  const ddRaw = Number(nddffGroup!.slice(1, 3));
  const ffRaw = Number(nddffGroup!.slice(3, 5));
  if (!Number.isFinite(ddRaw) || !Number.isFinite(ffRaw)) return null;

  // Code table 1855: 0/1 = m/s, 3/4 = knots, / = wind speed not available.
  if (iwChar !== '0' && iwChar !== '1' && iwChar !== '3' && iwChar !== '4') return null;
  const isKnots = iwChar === '3' || iwChar === '4';

  // ff = 99 means the speed is in the following 00fff group, same units as iw.
  let speedRaw = ffRaw;
  let remainder = rest;
  if (ffRaw === 99) {
    const extended = remainder.trim().match(/^00(\d{3})([\s\S]*)$/);
    if (!extended) return null;
    speedRaw = Number(extended[1]);
    remainder = extended[2] ?? '';
    if (!Number.isFinite(speedRaw)) return null;
  }

  const rawMps = isKnots ? speedRaw * KNOTS_TO_MPS : speedRaw;
  if (optionalWindMps(rawMps) === null) return null;
  const windAvgMps = plausibleWindMps(rawMps, 'WMO SYNOP');
  const dirDeg =
    isCalm(windAvgMps) || ddRaw === 0 || ddRaw === 99 || ddRaw > 36
      ? null
      : windDirection(ddRaw * 10);

  const tokens = remainder.replace(/=+$/, '').trim().split(/\s+/).filter(Boolean);
  let section = 1;
  let temperatureC: number | null = null;
  let dewPointC: number | null = null;
  let seaLevelPressureHpa: number | null = null;
  let windGustMps: number | null = null;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === '333') {
      section = 3;
      continue;
    }
    if (token === '555') {
      section = 5;
      continue;
    }
    if (section === 1) {
      if (/^1([01])(\d{3})$/.test(token)) {
        const sign = token[1] === '1' ? -1 : 1;
        temperatureC = validTemperatureC((sign * Number(token.slice(2))) / 10);
      } else if (/^2([01])(\d{3})$/.test(token)) {
        const sign = token[1] === '1' ? -1 : 1;
        dewPointC = validTemperatureC((sign * Number(token.slice(2))) / 10);
      } else if (/^4([09]\d{3})$/.test(token)) {
        const pVal = Number(token.slice(1));
        const hpa = pVal < 5000 ? 1000 + pVal / 10 : 900 + (pVal - 9000) / 10;
        seaLevelPressureHpa = pressureHpa(Math.round(hpa * 10) / 10);
      }
    } else if (section === 3) {
      // 910ff / 911ff / 912ff: gust in the same units as iw. 99 defers to 00fff.
      const gustMatch = /^91[012](\d{2})$/.exec(token);
      if (!gustMatch) continue;
      let gustVal = Number(gustMatch[1]);
      if (gustVal === 99) {
        const extendedGust = tokens[index + 1]?.match(/^00(\d{3})$/);
        if (!extendedGust) continue;
        gustVal = Number(extendedGust[1]);
        index += 1;
      }
      const gustMps = isKnots ? gustVal * KNOTS_TO_MPS : gustVal;
      const checked = optionalWindMps(gustMps);
      windGustMps = checked === null ? null : plausibleWindMps(checked, 'WMO SYNOP');
    }
  }

  const relativeHumidityPercent = relativeHumidityFromDewPoint(temperatureC, dewPointC);
  const hasConditions =
    dewPointC !== null || relativeHumidityPercent !== null || seaLevelPressureHpa !== null;
  const conditions: AirConditions | null = hasConditions
    ? {
        ...emptyConditions(),
        dewPointC,
        relativeHumidityPercent,
        seaLevelPressureHpa,
      }
    : null;

  return {
    wmoId: csvWmoId!,
    reading: {
      observedAt: new Date(observedAtMs).toISOString(),
      windAvgMps,
      windDirectionDeg: dirDeg,
      windGustMps,
      windLullMps: null,
      temperatureC,
      windChillC: null,
      conditions,
    },
  };
}

export function parseOgimetSynopBatch(
  text: string,
  expectedWmoId?: string,
): { reading: Reading; history: History | null } {
  const lines = text.trim().split(/\r?\n/);
  const points: HistoryPoint[] = [];
  let latestReading: Reading | null = null;
  let latestMs = -Infinity;

  for (const line of lines) {
    const parsed = parseOgimetSynopLine(line);
    if (!parsed) continue;
    if (expectedWmoId && parsed.wmoId !== expectedWmoId) continue;
    const ms = Date.parse(parsed.reading.observedAt);
    if (!Number.isFinite(ms)) continue;

    points.push({
      observedAt: parsed.reading.observedAt,
      windAvgMps: parsed.reading.windAvgMps,
      windGustMps: parsed.reading.windGustMps,
      windLullMps: null,
      windDirectionDeg: parsed.reading.windDirectionDeg,
      temperatureC: parsed.reading.temperatureC,
      seaLevelPressureHpa: parsed.reading.conditions?.seaLevelPressureHpa ?? null,
    });

    if (ms >= latestMs) {
      latestMs = ms;
      latestReading = parsed.reading;
    }
  }

  if (!latestReading) {
    throw new Error(`No valid SYNOP observations found${expectedWmoId ? ` for ${expectedWmoId}` : ''}`);
  }
  points.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return {
    reading: latestReading,
    history: points.length > 1 ? { periodMinutes: 180, points } : null,
  };
}

export function formatOgimetBeginUtc(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}0000`;
}

export function catalogueStationFromWmoMeta(
  meta: OgimetWmoStationMeta,
  options: Pick<
    OgimetSynopProviderOptions,
    'vendor' | 'region' | 'defaultTimeZone' | 'nameSuffix' | 'cacheTtlSeconds'
  >,
): CatalogueStation {
  const cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  return {
    uid: formatStationUid(options.vendor, meta.wmoId),
    vendor: options.vendor,
    nativeId: meta.wmoId,
    name: `${meta.name}${options.nameSuffix(meta)}`,
    latitude: meta.latitude,
    longitude: meta.longitude,
    elevationM: meta.elevationM,
    country: options.region,
    region: meta.region,
    timeZone: meta.timeZone ?? options.defaultTimeZone,
    pageUrl: `https://www.ogimet.com/cgi-bin/gsynres?lang=en&ind=${encodeURIComponent(meta.wmoId)}&decoded=yes&ndays=2`,
    category: meta.elevationM >= 1600 ? 'mountain' : 'synoptic',
    capabilities: {
      gustLull: true,
      temperature: true,
      conditions: true,
      history: true,
    },
    samplingWindowSeconds: 600,
    recommendedPollSeconds: cacheTtlSeconds,
    locator: {
      wmoId: meta.wmoId,
    },
  };
}

export function createOgimetSynopLoader(
  options: Pick<OgimetSynopProviderOptions, 'vendor' | 'sourceLabel' | 'cacheTtlSeconds'>,
) {
  const cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  return defineStationAdapter<OgimetSynopStationConfig, OgimetSynopAdapterOptions>({
    meta: ({ station }) => stationMetaFromCatalogue(station, options.sourceLabel),
    load: async ({ station }, { environment, options: adapterOptions }) => {
      const url = new URL(adapterOptions.getsynopUrl ?? OGIMET_GETSYNOP_URL);
      url.searchParams.set('block', station.nativeId);
      url.searchParams.set('begin', formatOgimetBeginUtc(environment.now().getTime() - 48 * 3_600_000));

      const text = await fetchUpstreamText(environment, {
        url,
        cacheKey: `${options.vendor}/synop/${station.nativeId}`,
        cacheTtlSeconds,
        subject: `${options.sourceLabel} SYNOP ${station.nativeId}`,
      });

      const { reading, history } = parseOgimetSynopBatch(text, station.nativeId);
      return { reading, history };
    },
  });
}

export function createOgimetSynopProvider(
  options: OgimetSynopProviderOptions,
): StationNetworkProvider {
  const coverage: Coverage = { kind: 'global' };
  const cacheTtlSeconds = options.cacheTtlSeconds ?? DEFAULT_CACHE_TTL_SECONDS;
  const loadStation = createOgimetSynopLoader(options);

  return {
    vendor: options.vendor,
    coverage,
    async discover(discoverOptions: DiscoverOptions = {}): Promise<CatalogueStation[]> {
      const seeds = (discoverOptions.seeds ?? []).filter(
        station => station.vendor === options.vendor,
      );
      const batches: CatalogueStation[][] = [seeds];
      const regions = discoverOptions.regions ?? INITIAL_SCOPE_REGIONS;

      if (
        discoverOptions.includeRemoteDiscovery !== false &&
        regions.includes(options.region)
      ) {
        const environment = resolveEnvironment(discoverOptions.environment);
        const nowMs = environment.now().getTime();
        try {
          const url = new URL(OGIMET_GETSYNOP_URL);
          url.searchParams.set('state', options.stateQuery);
          url.searchParams.set('begin', formatOgimetBeginUtc(nowMs - 72 * 3_600_000));

          const text = await fetchUpstreamText(environment, {
            url,
            cacheKey: `${options.vendor}/synop/state/${encodeURIComponent(options.stateQuery)}`,
            cacheTtlSeconds: 1_800,
            subject: `${options.sourceLabel} WMO SYNOP state batch`,
          });

          const latestByWmo = new Map<string, string>();
          for (const line of text.trim().split(/\r?\n/)) {
            const parsed = parseOgimetSynopLine(line);
            if (!parsed) continue;
            const prev = latestByWmo.get(parsed.wmoId);
            if (!prev || Date.parse(parsed.reading.observedAt) >= Date.parse(prev)) {
              latestByWmo.set(parsed.wmoId, parsed.reading.observedAt);
            }
          }

          const activeStations = options.stations
            .filter(meta => {
              const latestIso = latestByWmo.get(meta.wmoId);
              return latestIso !== undefined && isRecentObservation(latestIso, nowMs);
            })
            .map(meta => catalogueStationFromWmoMeta(meta, options));

          batches.push(activeStations);
        } catch (error) {
          logUpstreamFailure(environment, `${options.vendor} discovery failed`, error);
        }
      }

      return filterCatalogueStations(mergeCatalogueStations(batches), {
        ...discoverOptions,
        regions,
      });
    },
    toStationConfig(station: CatalogueStation): StationConfigInput {
      return customStationConfig(station, ({ environment, historyHours, mode }) =>
        loadStation({ station }, { environment, historyHours, mode }),
      );
    },
  };
}
