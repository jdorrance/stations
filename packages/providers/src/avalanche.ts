import {
  FEET_TO_METERS,
  MPH_TO_MPS,
  fahrenheitToCelsius,
  finiteNumber,
  isRecentObservation,
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
  type History,
  type HistoryPoint,
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

export const AVALANCHE_CA_STATIONS_URL = 'https://weather.prod.avalanche.ca/stations';
export const SNOWOBS_CURRENT_URL = 'https://api.snowobs.com/wx/v1/station/data/current/';
export const SNOWOBS_TIMESERIES_URL = 'https://api.snowobs.com/wx/v1/station/data/timeseries/';
const CACHE_TTL_SECONDS = 300;

const NAC_SNOWOBS_TOKENS: Readonly<Record<string, string>> = {
  NWAC: '71ad26d7aaf410e39efe91bd414d32e1db5d',
  SAC: '6628942ac4c3ca89c9989584aa160cd9',
  ESAC: '2b44c45459b50fe80e57f92e49362268',
  UAC: 'a72b286878755151cdc6672753af773dc455',
  BTAC: 'b7ba06102b2990792a1187247b0fa8d027d3',
  SNFAC: '93ef846589a860e00c15de7fa5c0fd4b',
  FAC: 'aa82daf632a65ced52938584597861e0',
  PAC: '7c8dcfc08f633fe280a16525e8e5a6afd538',
  CNFAIC: '98be1be8c02d7a5b3bf257145e74d68ef933',
  CAAC: 'f2d5dc468e86b8a5d0c3b8c5019e4314dfbe',
  IPAC: '96a1fc41ca426a79af14df82e8ee10d00daf',
  WCMAC: '7b073b1a8b0f32c4c4547e8fcbedfaa49034',
  WAC: 'a96cdc8a177949cb551cc39459b1f7583aa8',
  COAA: '19bd34b0a1c0e76eb6d474f6e3d80f238d61',
  MSAC: '3cafafc1202aa2d56005eaa9d8ed8801bad2',
  MWAC: 'a92543a3397498d0adedbcf655aa4f3ddb9f',
  TAC: '4e730a3bb23becd609998a43be031ff9',
  EWYAIX: '10fcb5634d25e8733ab98c9fa792ff595caf',
  SOAIX: '8ae4997f9a96b7458c20b86311b39e34a223',
  NYSAC: '7882dd74ce815760a9179eb2c94d8560779f',
};

export type AvalancheStationConfig = {
  readonly station: CatalogueStation;
};

export type AvalancheAdapterOptions = StationAdapterOptions & {
  readonly stationsUrl?: string;
};

export function parseAvalancheCanadaStations(text: string): CatalogueStation[] {
  const data: unknown = JSON.parse(text);
  const list = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.stations)
      ? data.stations
      : [];
  const stations: CatalogueStation[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    const idRaw = row.stationId ?? row.id;
    if (typeof idRaw !== 'number' && typeof idRaw !== 'string') continue;
    const nativeId = String(idRaw).trim();
    if (!nativeId) continue;

    const latitude = finiteNumber(row.lat ?? row.latitude);
    const longitude = finiteNumber(row.lon ?? row.lng ?? row.longitude);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }

    const country = inferRegionCode({ latitude, longitude });
    const elevationM = finiteNumber(row.elevation ?? row.altitude);
    const name =
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : `Avalanche Station ${nativeId}`;

    stations.push({
      uid: formatStationUid('avalanche', nativeId),
      vendor: 'avalanche',
      nativeId,
      name,
      latitude,
      longitude,
      elevationM,
      country,
      region: null,
      timeZone:
        typeof row.timezone === 'string' && row.timezone.trim()
          ? row.timezone.trim()
          : null,
      pageUrl: 'https://www.avalanche.ca/weather/stations',
      category: 'mountain',
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: true,
        history: true,
      },
      samplingWindowSeconds: 3_600,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationId: nativeId,
      },
    });
  }
  return stations;
}

export function parseAvalancheCanadaMeasurements(
  text: string,
): { reading: Reading; history: History | null } {
  const data: unknown = JSON.parse(text);
  const snowObsStation =
    isRecord(data) && Array.isArray(data.STATION) && isRecord(data.STATION[0])
      ? data.STATION[0]
      : null;
  const snowObsUnits = isRecord(data) && isRecord(data.UNITS) ? data.UNITS : null;
  const isMph = snowObsUnits?.wind_speed === 'mph';
  const isFahrenheit = snowObsUnits?.air_temp === 'fahrenheit';

  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.measurements)
      ? data.measurements
      : snowObsStation && Array.isArray(snowObsStation.observations)
        ? snowObsStation.observations
        : [];
  if (rows.length === 0) {
    throw new Error('Avalanche station returned no measurements');
  }

  const points: HistoryPoint[] = [];
  let latestReading: Reading | null = null;
  let latestMs = -Infinity;

  const toMps = (val: number): number => (isMph ? val * MPH_TO_MPS : kmhToMps(val));
  const toTempC = (val: number | null): number | null =>
    val === null ? null : isFahrenheit ? fahrenheitToCelsius(val) : val;

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const dtRaw =
      typeof row.measurementDateTime === 'string'
        ? row.measurementDateTime
        : typeof row.dateTime === 'string'
          ? row.dateTime
          : typeof row.date_time === 'string'
            ? row.date_time
            : null;
    const observedAtMs = observationTimeMs(dtRaw);
    if (!Number.isFinite(observedAtMs)) continue;

    const avgRaw = finiteNumber(row.windSpeedAvg ?? row.wind_speed);
    if (avgRaw === null || optionalWindMps(toMps(avgRaw)) === null) continue;
    const windAvgMps = plausibleWindMps(toMps(avgRaw), 'Avalanche');

    const gustRaw = finiteNumber(row.windSpeedGust ?? row.wind_gust);
    const windGustMps =
      gustRaw === null || gustRaw < 0
        ? null
        : optionalWindMps(toMps(gustRaw));
    const lullRaw = finiteNumber(row.wind_speed_min);
    const windLullMps =
      lullRaw === null || lullRaw < 0
        ? null
        : optionalWindMps(toMps(lullRaw));
    const dirDeg = finiteNumber(row.windDirAvg ?? row.wind_direction);
    const temperatureC = toTempC(finiteNumber(row.airTempAvg ?? row.temperature ?? row.air_temp));
    const rh = finiteNumber(row.relativeHumidityAvg ?? row.relativeHumidity ?? row.relative_humidity ?? row.rh);
    const solar = finiteNumber(row.solar_radiation);

    const windDirectionDeg =
      isCalm(windAvgMps) || dirDeg === null ? null : windDirection(dirDeg);
    const observedAt = new Date(observedAtMs).toISOString();

    points.push({
      observedAt,
      windAvgMps,
      windGustMps,
      windLullMps,
      windDirectionDeg,
      temperatureC: validTemperatureC(temperatureC),
    });

    if (observedAtMs > latestMs) {
      latestMs = observedAtMs;
      const hasCond = (rh !== null && rh >= 0 && rh <= 100) || (solar !== null && solar >= 0);
      const conditions: AirConditions | null = hasCond
        ? {
            ...emptyConditions(),
            relativeHumidityPercent: rh !== null && rh >= 0 && rh <= 100 ? rh : null,
            solarRadiationWm2: solar !== null && solar >= 0 ? solar : null,
          }
        : null;
      latestReading = {
        observedAt,
        windAvgMps,
        windDirectionDeg,
        windGustMps,
        windLullMps,
        temperatureC: validTemperatureC(temperatureC),
        windChillC: null,
        conditions,
      };
    }
  }

  if (!latestReading) {
    throw new Error('Avalanche station had no valid wind readings');
  }
  points.sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  return {
    reading: latestReading,
    history: points.length > 1 ? { periodMinutes: 60, points } : null,
  };
}

export function parseSnowObsCurrentGeoJson(
  text: string,
  centerId: string,
  token: string,
  nowMs = Date.now(),
  expectedNativeId?: string,
): { station: CatalogueStation; reading: Reading }[] {
  const root: unknown = JSON.parse(text);
  const features = isRecord(root) && Array.isArray(root.features) ? root.features : [];
  const results: { station: CatalogueStation; reading: Reading }[] = [];

  for (const feature of features) {
    if (!isRecord(feature) || !isRecord(feature.properties)) continue;
    const props = feature.properties;
    const source = typeof props.source === 'string' ? props.source.trim().toLowerCase() : '';
    if (!source || source === 'snotel') continue;

    const stid =
      typeof props.stid === 'string' || typeof props.stid === 'number'
        ? String(props.stid).trim()
        : '';
    if (!stid) continue;
    const nativeId = `${source}-${stid}`;
    if (expectedNativeId && nativeId !== expectedNativeId) continue;

    const latitude = finiteNumber(props.latitude);
    const longitude = finiteNumber(props.longitude);
    if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
      continue;
    }

    const data = isRecord(props.data) ? props.data : null;
    if (!data) continue;
    const dtRaw = typeof data.date_time === 'string' ? data.date_time : null;
    if (!dtRaw || !isRecentObservation(dtRaw, nowMs)) continue;

    const wspdMph = finiteNumber(data.wind_speed);
    if (wspdMph === null || optionalWindMps(wspdMph * MPH_TO_MPS) === null) continue;
    const windAvgMps = plausibleWindMps(wspdMph * MPH_TO_MPS, 'Avalanche/SnowObs');

    const wgstMph = finiteNumber(data.wind_gust);
    const windGustMps =
      wgstMph === null || wgstMph < 0 ? null : optionalWindMps(wgstMph * MPH_TO_MPS);
    const wlullMph = finiteNumber(data.wind_speed_min);
    const windLullMps =
      wlullMph === null || wlullMph < 0 ? null : optionalWindMps(wlullMph * MPH_TO_MPS);
    const dirDeg = finiteNumber(data.wind_direction);
    const tempF = finiteNumber(data.air_temp);
    const rh = finiteNumber(data.relative_humidity);
    const solar = finiteNumber(data.solar_radiation);

    const elevFt = finiteNumber(props.elevation);
    const elevationM = elevFt !== null ? Math.round(elevFt * FEET_TO_METERS) : null;
    const meta = isRecord(props.meta) ? props.meta : null;
    const region = typeof meta?.state === 'string' && meta.state.trim() ? meta.state.trim() : null;
    const country = inferRegionCode({ latitude, longitude }, 'US');
    const name =
      typeof props.name === 'string' && props.name.trim()
        ? props.name.trim()
        : `${centerId} ${stid}`;

    const station: CatalogueStation = {
      uid: formatStationUid('avalanche', nativeId),
      vendor: 'avalanche',
      nativeId,
      name,
      latitude,
      longitude,
      elevationM,
      country,
      region,
      timeZone: typeof props.timezone === 'string' && props.timezone.trim() ? props.timezone.trim() : null,
      pageUrl: 'https://avalanche.org/',
      category: 'mountain',
      capabilities: {
        gustLull: true,
        temperature: true,
        conditions: true,
        history: true,
      },
      samplingWindowSeconds: 3_600,
      recommendedPollSeconds: CACHE_TTL_SECONDS,
      locator: {
        stationId: nativeId,
        snowobsStid: stid,
        snowobsSource: source,
        snowobsToken: token,
        centerId,
      },
    };

    const reading: Reading = {
      observedAt: new Date(observationTimeMs(dtRaw)).toISOString(),
      windAvgMps,
      windDirectionDeg: isCalm(windAvgMps) || dirDeg === null ? null : windDirection(dirDeg),
      windGustMps,
      windLullMps,
      temperatureC: validTemperatureC(tempF === null ? null : fahrenheitToCelsius(tempF)),
      windChillC: null,
      conditions:
        (rh !== null && rh >= 0 && rh <= 100) || (solar !== null && solar >= 0)
          ? {
              ...emptyConditions(),
              relativeHumidityPercent: rh !== null && rh >= 0 && rh <= 100 ? rh : null,
              solarRadiationWm2: solar !== null && solar >= 0 ? solar : null,
            }
          : null,
    };

    results.push({ station, reading });
  }

  return results;
}

function formatUtcCompactMinute(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

export const loadAvalancheStation = defineStationAdapter<
  AvalancheStationConfig,
  AvalancheAdapterOptions
>({
  meta: ({ station }) =>
    stationMetaFromCatalogue(
      station,
      typeof station.locator.centerId === 'string'
        ? `${station.locator.centerId} Avalanche Center`
        : 'Avalanche Canada',
    ),
  load: async ({ station }, { environment, mode, historyHours, options }) => {
    const snowobsToken =
      typeof station.locator.snowobsToken === 'string' ? station.locator.snowobsToken : null;
    const snowobsStid =
      typeof station.locator.snowobsStid === 'string' ? station.locator.snowobsStid : null;
    const snowobsSource =
      typeof station.locator.snowobsSource === 'string' ? station.locator.snowobsSource : null;

    if (snowobsToken && snowobsStid && snowobsSource) {
      const nowMs = environment.now().getTime();
      if (mode === 'full') {
        const tsUrl = new URL(SNOWOBS_TIMESERIES_URL);
        tsUrl.searchParams.set('token', snowobsToken);
        tsUrl.searchParams.set('stid', snowobsStid);
        tsUrl.searchParams.set('source', snowobsSource === 'synoptic-data' ? 'mesowest' : snowobsSource);
        tsUrl.searchParams.set('start_date', formatUtcCompactMinute(nowMs - Math.max(1, historyHours) * 3_600_000));
        tsUrl.searchParams.set('end_date', formatUtcCompactMinute(nowMs));
        tsUrl.searchParams.set('output', 'records');
        tsUrl.searchParams.set('units', 'default');
        tsUrl.searchParams.set('calc_diff', 'true');
        const tsText = await fetchUpstreamText(environment, {
          url: tsUrl,
          cacheKey: `avalanche/snowobs/ts/${station.nativeId}/${historyHours}`,
          cacheTtlSeconds: CACHE_TTL_SECONDS,
          subject: `Avalanche SnowObs timeseries ${station.nativeId}`,
        });
        const { reading, history } = parseAvalancheCanadaMeasurements(tsText);
        return { reading, history };
      }

      const curUrl = new URL(SNOWOBS_CURRENT_URL);
      curUrl.searchParams.set('token', snowobsToken);
      curUrl.searchParams.set('calc_diff', 'true');
      curUrl.searchParams.set('units', 'default');
      const curText = await fetchUpstreamText(environment, {
        url: curUrl,
        accept: 'application/vnd.geo+json',
        cacheKey: `avalanche/snowobs/current/${snowobsToken}`,
        cacheTtlSeconds: CACHE_TTL_SECONDS,
        subject: `Avalanche SnowObs current ${station.locator.centerId ?? ''}`,
        limitBytes: 4 * 1024 * 1024,
      });
      const parsed = parseSnowObsCurrentGeoJson(
        curText,
        typeof station.locator.centerId === 'string' ? station.locator.centerId : 'NAC',
        snowobsToken,
        nowMs,
        station.nativeId,
      )[0];
      if (!parsed) {
        throw new Error(`SnowObs returned no active reading for ${station.nativeId}`);
      }
      return {
        reading: parsed.reading,
        history: null,
      };
    }

    const base = (options.stationsUrl ?? AVALANCHE_CA_STATIONS_URL).replace(/\/$/, '');
    const primaryUrl = options.stationsUrl
      ? `${base}/${encodeURIComponent(station.nativeId)}`
      : `${base}/${encodeURIComponent(station.nativeId)}/measurements`;
    const text = await fetchUpstreamText(environment, {
      url: primaryUrl,
      cacheKey: `avalanche/station/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `Avalanche station ${station.nativeId}`,
    });
    const { reading, history } = parseAvalancheCanadaMeasurements(text);
    return {
      reading,
      history,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const avalancheProvider: StationNetworkProvider = {
  vendor: 'avalanche',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'avalanche');
    const batches: CatalogueStation[][] = [seeds];
    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      const nowMs = environment.now().getTime();
      const regions = options.regions ?? INITIAL_SCOPE_REGIONS;

      if (regions.includes('CA')) {
        try {
          const text = await fetchUpstreamText(environment, {
            url: AVALANCHE_CA_STATIONS_URL,
            cacheKey: 'avalanche/stations/all',
            cacheTtlSeconds: 3_600,
            subject: 'Avalanche Canada weather stations',
          });
          const candidates = parseAvalancheCanadaStations(text);
          if (candidates.length > 5) {
            const activeCa: CatalogueStation[] = [];
            const concurrency = 20;
            for (let index = 0; index < candidates.length; index += concurrency) {
              const slice = candidates.slice(index, index + concurrency);
              const checked = await Promise.all(
                slice.map(async candidate => {
                  try {
                    const mText = await fetchUpstreamText(environment, {
                      url: `${AVALANCHE_CA_STATIONS_URL}/${encodeURIComponent(candidate.nativeId)}/measurements`,
                      cacheKey: `avalanche/station/${candidate.nativeId}`,
                      cacheTtlSeconds: CACHE_TTL_SECONDS,
                      subject: `Avalanche station ${candidate.nativeId}`,
                      timeoutMs: 5_000,
                    });
                    const { reading } = parseAvalancheCanadaMeasurements(mText);
                    return isRecentObservation(reading.observedAt, nowMs) ? candidate : null;
                  } catch {
                    return null;
                  }
                }),
              );
              for (const st of checked) {
                if (st) activeCa.push(st);
              }
            }
            batches.push(activeCa);
          } else {
            batches.push(candidates);
          }
        } catch (error) {
          logUpstreamFailure(environment, 'AVALANCHE discovery failed', error);
        }
      }

      if (regions.includes('US')) {
        try {
          // Probe first token via environment.fetch so offline unit tests fail closed without external calls
          const firstEntry = Object.entries(NAC_SNOWOBS_TOKENS)[0]!;
          const probeUrl = new URL(SNOWOBS_CURRENT_URL);
          probeUrl.searchParams.set('token', firstEntry[1]);
          probeUrl.searchParams.set('calc_diff', 'true');
          probeUrl.searchParams.set('units', 'default');
          const probeText = await fetchUpstreamText(environment, {
            url: probeUrl,
            accept: 'application/vnd.geo+json',
            cacheKey: `avalanche/snowobs/current/${firstEntry[1]}`,
            cacheTtlSeconds: 900,
            subject: `NAC SnowObs ${firstEntry[0]}`,
            limitBytes: 4 * 1024 * 1024,
          });
          batches.push(
            parseSnowObsCurrentGeoJson(probeText, firstEntry[0], firstEntry[1], nowMs).map(
              entry => entry.station,
            ),
          );

          const remaining = Object.entries(NAC_SNOWOBS_TOKENS).slice(1);
          const centerBatches = await Promise.all(
            remaining.map(async ([centerId, token]) => {
              try {
                const url = new URL(SNOWOBS_CURRENT_URL);
                url.searchParams.set('token', token);
                url.searchParams.set('calc_diff', 'true');
                url.searchParams.set('units', 'default');
                const text = await fetchUpstreamText(environment, {
                  url,
                  accept: 'application/vnd.geo+json',
                  cacheKey: `avalanche/snowobs/current/${token}`,
                  cacheTtlSeconds: 900,
                  subject: `NAC SnowObs ${centerId}`,
                  limitBytes: 4 * 1024 * 1024,
                });
                return parseSnowObsCurrentGeoJson(text, centerId, token, nowMs).map(
                  entry => entry.station,
                );
              } catch {
                return [];
              }
            }),
          );
          for (const batch of centerBatches) batches.push(batch);
        } catch {
          // Offline or unmocked environment
        }
      }
    }
    return filterCatalogueStations(mergeCatalogueStations(batches), {
      ...options,
      regions: options.regions ?? INITIAL_SCOPE_REGIONS,
    });
  },
  toStationConfig(station: CatalogueStation): StationConfigInput {
    return customStationConfig(station, ({ environment, historyHours, mode }) =>
      loadAvalancheStation({ station }, { environment, historyHours, mode }),
    );
  },
};
