import { kmhToMps, plausibleWindMps } from '@azohra/meteo.core';
import { type Reading } from '@azohra/meteo.station';
import {
  fetchUpstreamText,
  logUpstreamFailure,
  naiveLocalToIso,
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
  validPosition,
  type Coverage,
} from '@stations/geography';
import {
  customStationConfig,
  filterCatalogueStations,
  stationMetaFromCatalogue,
} from './azohra-vendors.ts';
import {
  KNOTS_TO_MPS,
  MPH_TO_MPS,
  isRecentObservation,
  optionalWindMps,
  windDirection,
} from './observation-values.ts';
import { defaultTimeZoneForPoint } from './region-hints.ts';
import { defineStationAdapter, resolveEnvironment } from './server.ts';
import type { DiscoverOptions, StationNetworkProvider } from './types.ts';

const coverage: Coverage = { kind: 'global' };
const HILLTOP_CACHE_TTL_SECONDS = 300;

export interface HilltopCouncilConfig {
  readonly slug: string;
  readonly name: string;
  readonly baseUrl: string;
  /** Regional council label owned by this host (not inferred from coordinates). */
  readonly region: string;
  readonly windSpeedMeasurement: string;
  readonly windGustMeasurement?: string;
  readonly windDirectionMeasurement?: string;
  /**
   * When false, discovery skips this host. As of 2026-10-27 every listed host
   * either failed SiteList from the crawl network or returned GetData with no
   * wind samples for the first 12 sites — Zephyr covers those council ports
   * (`gw`, `hbrc`, `tdc`, `envdata`). Re-probe before flipping any to true.
   */
  readonly enabled: boolean;
}

/**
 * Curated NZ Hilltop endpoints. Kept registered for seeds / future re-enable;
 * omitted from default discovery while all `enabled` flags are false.
 */
export const HILLTOP_COUNCILS: readonly HilltopCouncilConfig[] = [
  {
    slug: 'mb',
    name: 'Marlborough District Council',
    baseUrl: 'https://hydro.marlborough.govt.nz/data.hts',
    region: 'Marlborough',
    windSpeedMeasurement: 'Wind Speed',
    windGustMeasurement: 'Wind Gust',
    windDirectionMeasurement: 'Wind Direction',
    enabled: false,
  },
  {
    slug: 'tdc',
    name: 'Tasman District Council',
    baseUrl: 'https://envdata.tasman.govt.nz/data.hts',
    region: 'Tasman',
    windSpeedMeasurement: 'Wind Speed',
    windDirectionMeasurement: 'Wind Direction',
    enabled: false,
  },
  {
    slug: 'gw',
    name: 'Greater Wellington Regional Council',
    baseUrl: 'https://hilltop.gw.govt.nz/data.hts',
    region: 'Wellington',
    windSpeedMeasurement: 'Wind Speed',
    windDirectionMeasurement: 'Wind Direction',
    enabled: false,
  },
  {
    slug: 'trc',
    name: 'Taranaki Regional Council',
    baseUrl: 'https://extranet.trc.govt.nz/getdata/boo.hts',
    region: 'Taranaki',
    windSpeedMeasurement: 'Wind Speed',
    windDirectionMeasurement: 'Wind Direction',
    enabled: false,
  },
  {
    slug: 'es',
    name: 'Environment Southland',
    baseUrl: 'http://odp.es.govt.nz/data.hts',
    region: 'Southland',
    windSpeedMeasurement: 'Wind Speed',
    windDirectionMeasurement: 'Wind Direction',
    enabled: false,
  },
  {
    slug: 'wcrc',
    name: 'West Coast Regional Council',
    baseUrl: 'https://hilltop.wcrc.govt.nz/data.hts',
    region: 'West Coast',
    windSpeedMeasurement: 'Wind Speed',
    windDirectionMeasurement: 'Wind Direction',
    enabled: false,
  },
  {
    slug: 'orc',
    name: 'Otago Regional Council',
    baseUrl: 'https://gisdata.orc.govt.nz/Hilltop/data.hts',
    region: 'Otago',
    windSpeedMeasurement: 'Wind Speed [Wind Speed]',
    windDirectionMeasurement: 'Wind Direction [Wind Direction]',
    enabled: false,
  },
  {
    slug: 'hbrc',
    name: "Hawke's Bay Regional Council",
    baseUrl: 'https://data.hbrc.govt.nz/Envirodata/data.hts',
    region: "Hawke's Bay",
    windSpeedMeasurement: 'Wind Speed',
    windDirectionMeasurement: 'Wind Direction',
    enabled: false,
  },
  {
    slug: 'nrc',
    name: 'Northland Regional Council',
    baseUrl: 'https://hilltop.nrc.govt.nz/data.hts',
    region: 'Northland',
    windSpeedMeasurement: 'Wind Speed',
    enabled: false,
  },
  {
    slug: 'boprc',
    name: 'Bay of Plenty Regional Council',
    baseUrl: 'https://envdata.boprc.govt.nz/data.hts',
    region: 'Bay of Plenty',
    windSpeedMeasurement: 'Wind Speed',
    enabled: false,
  },
  {
    slug: 'wrc',
    name: 'Waikato Regional Council',
    baseUrl: 'https://envdata.waikatoregion.govt.nz/data.hts',
    region: 'Waikato',
    windSpeedMeasurement: 'Wind Speed',
    enabled: false,
  },
  {
    slug: 'ncc',
    name: 'Nelson City Council',
    baseUrl: 'https://envdata.nelson.govt.nz/data.hts',
    region: 'Nelson',
    windSpeedMeasurement: 'Wind Speed',
    enabled: false,
  },
  {
    slug: 'hrc',
    name: 'Horizons Regional Council',
    baseUrl: 'https://tsdata.horizons.govt.nz/boo.hts',
    region: 'Manawatū-Whanganui',
    windSpeedMeasurement: 'Wind Speed',
    enabled: false,
  },
];

export function hilltopCouncil(slug: string): HilltopCouncilConfig | undefined {
  return HILLTOP_COUNCILS.find(c => c.slug === slug);
}

function parseHilltopSiteList(text: string): { name: string; latitude: number; longitude: number }[] {
  const sites: { name: string; latitude: number; longitude: number }[] = [];
  const re =
    /<Site\s+Name="([^"]+)"[^>]*>\s*<Latitude>([^<]+)<\/Latitude>\s*<Longitude>([^<]+)<\/Longitude>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const name = match[1]!.trim();
    const latitude = Number(match[2]);
    const longitude = Number(match[3]);
    if (!name || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    if (!validPosition({ latitude, longitude })) continue;
    sites.push({ name, latitude, longitude });
  }
  return sites;
}

/** Convert Hilltop Units text to m/s. Returns null when units are missing or unknown. */
export function hilltopSpeedToMps(value: number, units: string | null | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  const u = (units ?? '').trim().toLowerCase();
  if (!u) return null;
  if (u === 'm/s' || u === 'mps' || u === 'metres per second' || u === 'meters per second') {
    return optionalWindMps(value);
  }
  if (u === 'km/h' || u === 'kmh' || u === 'kph' || u === 'kilometres per hour') {
    return optionalWindMps(kmhToMps(value));
  }
  if (u === 'kt' || u === 'kts' || u === 'knot' || u === 'knots') {
    return optionalWindMps(value * KNOTS_TO_MPS);
  }
  if (u === 'mph' || u === 'mi/h') {
    return optionalWindMps(value * MPH_TO_MPS);
  }
  return null;
}

function formatHilltopLocalDateTime(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find(part => part.type === type)?.value ?? '00';
  let year = Number(get('year'));
  let month = Number(get('month'));
  let day = Number(get('day'));
  let hour = get('hour');
  // Some engines report midnight as hour 24 on the previous calendar day.
  if (hour === '24') {
    hour = '00';
    const rolled = new Date(Date.UTC(year, month - 1, day));
    rolled.setUTCDate(rolled.getUTCDate() + 1);
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)} ${hour}:${get('minute')}:${get('second')}`;
}

/**
 * Parse a Hilltop GetData XML payload.
 * Naive `<T>` timestamps are interpreted in `timeZone` (council local), not UTC.
 */
export function parseHilltopGetData(
  text: string,
  options: { unitsHint?: string | null; timeZone?: string } = {},
): { observedAt: string; value: number; units: string | null } | null {
  if (/<Error>/i.test(text)) return null;
  const unitsMatch = text.match(/<Units>([^<]*)<\/Units>/i);
  const units = unitsMatch?.[1]?.trim() || options.unitsHint || null;
  const rows = [...text.matchAll(/<T>([^<]+)<\/T>\s*<I1>([^<]+)<\/I1>/g)];
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1]!;
  const rawTime = last[1]!.trim();
  const value = Number(last[2]);
  if (!Number.isFinite(value)) return null;

  let observedAt: string;
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(rawTime)) {
    const ms = Date.parse(rawTime);
    if (!Number.isFinite(ms)) return null;
    observedAt = new Date(ms).toISOString();
  } else {
    const normalized = rawTime.includes('T') ? rawTime : rawTime.replace(' ', 'T');
    const timeZone = options.timeZone ?? 'Pacific/Auckland';
    observedAt = naiveLocalToIso(normalized, timeZone);
  }
  return { observedAt, value, units };
}

function catalogueStationFromHilltop(
  council: HilltopCouncilConfig,
  site: { name: string; latitude: number; longitude: number },
): CatalogueStation {
  const nativeId = `${council.slug}:${site.name}`;
  const timeZone =
    defaultTimeZoneForPoint({ latitude: site.latitude, longitude: site.longitude }) ??
    'Pacific/Auckland';
  return {
    uid: formatStationUid('hilltop', nativeId),
    vendor: 'hilltop',
    nativeId,
    name: site.name,
    latitude: site.latitude,
    longitude: site.longitude,
    elevationM: null,
    country: 'NZ',
    region: council.region,
    timeZone,
    pageUrl: council.baseUrl,
    category: 'synoptic',
    capabilities: {
      gustLull: Boolean(council.windGustMeasurement),
      temperature: false,
      conditions: false,
      // Adapter returns current sample only; no history series yet.
      history: false,
    },
    samplingWindowSeconds: 600,
    recommendedPollSeconds: HILLTOP_CACHE_TTL_SECONDS,
    locator: {
      council: council.slug,
      siteName: site.name,
      baseUrl: council.baseUrl,
      windSpeedMeasurement: council.windSpeedMeasurement,
      timeZone,
      ...(council.windGustMeasurement ? { windGustMeasurement: council.windGustMeasurement } : {}),
      ...(council.windDirectionMeasurement
        ? { windDirectionMeasurement: council.windDirectionMeasurement }
        : {}),
    },
  };
}

export type HilltopStationConfig = { readonly station: CatalogueStation };
export type HilltopAdapterOptions = StationAdapterOptions;

export const loadHilltopStation = defineStationAdapter<HilltopStationConfig, HilltopAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'NZ Hilltop'),
  load: async ({ station }, { environment }) => {
    const baseUrl =
      typeof station.locator.baseUrl === 'string' ? station.locator.baseUrl : null;
    const siteName =
      typeof station.locator.siteName === 'string' ? station.locator.siteName : null;
    const speedMeas =
      typeof station.locator.windSpeedMeasurement === 'string'
        ? station.locator.windSpeedMeasurement
        : 'Wind Speed';
    const timeZone =
      typeof station.locator.timeZone === 'string'
        ? station.locator.timeZone
        : station.timeZone ?? 'Pacific/Auckland';
    if (!baseUrl || !siteName) {
      throw new Error(`Hilltop station ${station.nativeId} is missing baseUrl/siteName locator`);
    }

    const to = environment.now();
    const from = new Date(to.getTime() - 48 * 3_600_000);

    const fetchMeas = async (measurement: string) => {
      const url = new URL(baseUrl);
      url.searchParams.set('Service', 'Hilltop');
      url.searchParams.set('Request', 'GetData');
      url.searchParams.set('Site', siteName);
      url.searchParams.set('Measurement', measurement);
      // Hilltop From/To are server-local wall times, not UTC.
      url.searchParams.set('From', formatHilltopLocalDateTime(from, timeZone));
      url.searchParams.set('To', formatHilltopLocalDateTime(to, timeZone));
      const text = await fetchUpstreamText(environment, {
        url,
        cacheKey: `hilltop/${station.nativeId}/${measurement}`,
        cacheTtlSeconds: HILLTOP_CACHE_TTL_SECONDS,
        subject: `Hilltop ${station.nativeId} ${measurement}`,
        timeoutMs: 12_000,
      });
      return parseHilltopGetData(text, { timeZone });
    };

    const speed = await fetchMeas(speedMeas);
    if (!speed) {
      throw new Error(`Hilltop station ${station.nativeId} returned no wind speed data`);
    }
    const windAvgMps = hilltopSpeedToMps(speed.value, speed.units);
    if (windAvgMps === null) {
      throw new Error(
        `Hilltop station ${station.nativeId} has unsupported wind units: ${speed.units ?? 'unknown'}`,
      );
    }

    let windGustMps: number | null = null;
    const gustMeas =
      typeof station.locator.windGustMeasurement === 'string'
        ? station.locator.windGustMeasurement
        : null;
    if (gustMeas) {
      try {
        const gust = await fetchMeas(gustMeas);
        if (gust) windGustMps = hilltopSpeedToMps(gust.value, gust.units);
      } catch {
        // optional
      }
    }

    let windDirectionDeg: number | null = null;
    const dirMeas =
      typeof station.locator.windDirectionMeasurement === 'string'
        ? station.locator.windDirectionMeasurement
        : null;
    if (dirMeas) {
      try {
        const dir = await fetchMeas(dirMeas);
        if (dir) windDirectionDeg = windDirection(dir.value);
      } catch {
        // optional
      }
    }

    const reading: Reading = {
      observedAt: speed.observedAt,
      windAvgMps: plausibleWindMps(windAvgMps, 'Hilltop'),
      windDirectionDeg,
      windGustMps: windGustMps === null ? null : plausibleWindMps(windGustMps, 'Hilltop'),
      windLullMps: null,
      temperatureC: null,
      windChillC: null,
      conditions: null,
    };
    return { reading, history: null };
  },
});

export const hilltopProvider: StationNetworkProvider = {
  vendor: 'hilltop',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'hilltop');
    const batches: CatalogueStation[][] = [seeds];
    const regions = options.regions ?? INITIAL_SCOPE_REGIONS;

    if (options.includeRemoteDiscovery !== false && regions.includes('NZ')) {
      const environment = resolveEnvironment(options.environment);
      const nowMs = environment.now().getTime();
      const discovered: CatalogueStation[] = [];

      for (const council of HILLTOP_COUNCILS) {
        if (!council.enabled) continue;
        try {
          const url = new URL(council.baseUrl);
          url.searchParams.set('Service', 'Hilltop');
          url.searchParams.set('Request', 'SiteList');
          url.searchParams.set('Location', 'LatLong');
          url.searchParams.set('Measurement', council.windSpeedMeasurement);
          const text = await fetchUpstreamText(environment, {
            url,
            cacheKey: `hilltop/${council.slug}/sites/${encodeURIComponent(council.windSpeedMeasurement)}`,
            cacheTtlSeconds: 3_600,
            subject: `Hilltop ${council.slug} wind SiteList`,
            timeoutMs: 20_000,
            limitBytes: 4 * 1024 * 1024,
          });
          const sites = parseHilltopSiteList(text);
          const toVerify = sites.slice(0, 12);
          const concurrency = 4;
          let failures = 0;
          for (let index = 0; index < toVerify.length; index += concurrency) {
            if (index > 0 && failures === index) break;
            const slice = toVerify.slice(index, index + concurrency);
            const checked = await Promise.all(
              slice.map(async site => {
                const candidate = catalogueStationFromHilltop(council, site);
                try {
                  const loaded = await loadHilltopStation(
                    { station: candidate },
                    { environment, mode: 'current' },
                  );
                  if (
                    loaded.status === 'ok' &&
                    loaded.reading !== null &&
                    isRecentObservation(loaded.reading.observedAt, nowMs)
                  ) {
                    return candidate;
                  }
                } catch {
                  // skip
                }
                return null;
              }),
            );
            for (const station of checked) {
              if (station) discovered.push(station);
              else failures += 1;
            }
          }
        } catch (error) {
          logUpstreamFailure(environment, `Hilltop ${council.slug} discovery failed`, error);
        }
      }
      batches.push(discovered);
    }

    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadHilltopStation({ station }, { environment, historyHours, mode }),
    );
  },
};
