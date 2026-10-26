import {
  FEET_TO_METERS,
  MPH_TO_MPS,
  fahrenheitToCelsius,
  finiteNumber,
  isRecord,
  observationTimeMs,
  optionalWindMps,
  validTemperatureC,
  windDirection,
} from './observation-values.ts';
import { plausibleWindMps } from '@azohra/meteo.core';
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

export const RAWS_FEATURESERVER_QUERY_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/PublicView_RAWS/FeatureServer/1/query';

const CACHE_TTL_SECONDS = 300;

export type RawsStationConfig = {
  readonly station: CatalogueStation;
};

export type RawsAdapterOptions = StationAdapterOptions & {
  readonly queryUrl?: string;
};

export interface RawsParsedFeature {
  readonly station: CatalogueStation;
  readonly reading: Reading | null;
}

// The public FeatureServer emits human-readable measurement strings such as
// "5 mph", "93 deg. F", and "21 %", even though coordinates are numeric.
function measurementNumber(value: unknown): number | null {
  const numeric = finiteNumber(value);
  if (numeric !== null || typeof value !== 'string') return numeric;
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*(?:mph|degrees?|deg\.?\s*F|%|inches?|w\/m2)$/i);
  return match ? Number(match[1]) : null;
}

function pickField(attrs: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (attrs[key] !== undefined && attrs[key] !== null && attrs[key] !== '') {
      return attrs[key];
    }
  }
  return null;
}

export function parseRawsFeature(raw: unknown): RawsParsedFeature | null {
  if (!isRecord(raw)) return null;
  const attrs = isRecord(raw.attributes)
    ? raw.attributes
    : isRecord(raw.properties)
      ? raw.properties
      : raw;
  const geom = isRecord(raw.geometry) ? raw.geometry : null;

  const idCandidate = pickField(attrs, [
    'NWSID',
    'NWS_ID',
    'NESDIS',
    'NESDIS_ID',
    'NESSID',
    'StationID',
    'STAID',
    'WIMS_ID',
    'OBJECTID',
  ]);
  if (typeof idCandidate !== 'string' && typeof idCandidate !== 'number') return null;
  const nativeId = String(idCandidate).trim().toUpperCase();
  if (!nativeId) return null;

  const geomCoords = geom && Array.isArray(geom.coordinates) ? geom.coordinates : null;
  const longitude =
    finiteNumber(geom?.x) ??
    (geomCoords ? finiteNumber(geomCoords[0]) : null) ??
    finiteNumber(pickField(attrs, ['Longitude', 'LONGITUDE', 'LON', 'Lon']));
  const latitude =
    finiteNumber(geom?.y) ??
    (geomCoords ? finiteNumber(geomCoords[1]) : null) ??
    finiteNumber(pickField(attrs, ['Latitude', 'LATITUDE', 'LAT', 'Lat']));
  if (latitude === null || longitude === null || !validPosition({ latitude, longitude })) {
    return null;
  }

  const country = inferRegionCode({ latitude, longitude });
  const stateRaw = pickField(attrs, ['State', 'STATE', 'StateCode']);
  const region = typeof stateRaw === 'string' && stateRaw.trim() ? stateRaw.trim() : null;
  const elevFeet = finiteNumber(pickField(attrs, ['Elevation', 'ELEVATION', 'Elev', 'ELEV']));
  const elevMetersDirect = finiteNumber(pickField(attrs, ['ElevationM', 'ELEV_M']));
  const elevationM =
    elevMetersDirect !== null
      ? Math.round(elevMetersDirect)
      : elevFeet !== null
        ? Math.round(elevFeet * FEET_TO_METERS)
        : null;

  const rawName = pickField(attrs, ['StationName', 'STANAME', 'Name', 'NAME', 'SiteName']);
  const name =
    typeof rawName === 'string' && rawName.trim() ? rawName.trim() : `RAWS ${nativeId}`;

  const nwsId = pickField(attrs, ['NWSID', 'NWS_ID']);
  const nesdisId = pickField(attrs, ['NESDIS', 'NESDIS_ID', 'NESSID']);

  const station: CatalogueStation = {
    uid: formatStationUid('raws', nativeId),
    vendor: 'raws',
    nativeId,
    name,
    latitude,
    longitude,
    elevationM,
    country,
    region,
    timeZone: null,
    pageUrl:
      typeof nwsId === 'string' && nwsId.trim()
        ? `https://mesowest.utah.edu/cgi-bin/droman/meso_base_dyn.cgi?stn=${encodeURIComponent(nwsId.trim())}`
        : null,
    category: 'mountain',
    capabilities: {
      gustLull: true,
      temperature: true,
      conditions: true,
      history: false,
    },
    samplingWindowSeconds: 600,
    recommendedPollSeconds: CACHE_TTL_SECONDS,
    locator: {
      rawsId: nativeId,
      ...(typeof nwsId === 'string' && nwsId.trim() ? { nwsId: nwsId.trim().toUpperCase() } : {}),
      ...(typeof nesdisId === 'string' && nesdisId.trim()
        ? { nesdisId: nesdisId.trim().toUpperCase() }
        : {}),
    },
  };

  const obsTimeRaw = pickField(attrs, [
    'ObservationTime',
    'ObservedDate',
    'ObsTime',
    'OBS_TIME',
    'DateTime',
    'DATE_TIME',
    'ValidTime',
  ]);
  const observedAtMs = observationTimeMs(obsTimeRaw);

  const windMph = measurementNumber(
    pickField(attrs, ['WindSpeedMPH', 'WindSpeed', 'WindSpeed_mph', 'WIND_SPEED', 'WSPD', 'FF']),
  );
  if (!Number.isFinite(observedAtMs) || windMph === null || optionalWindMps(windMph * MPH_TO_MPS) === null) {
    return { station, reading: null };
  }

  const windAvgMps = plausibleWindMps(windMph * MPH_TO_MPS, 'RAWS');
  const gustMph = measurementNumber(
    pickField(attrs, ['WindSpeedPeak', 'WindGust', 'WindGust_mph', 'WIND_GUST', 'WGST', 'GG']),
  );
  const windGustMps =
    gustMph === null || gustMph < 0
      ? null
      : optionalWindMps(gustMph * MPH_TO_MPS);
  const dirDeg = measurementNumber(
    pickField(attrs, ['WindDirDegrees', 'WindDirection', 'WindDir', 'WIND_DIR', 'WDIR', 'DD']),
  );

  const tempF = measurementNumber(
    pickField(attrs, ['AirTempStandPlace', 'AirTemp', 'AirTemperature', 'Temp_F', 'TEMP', 'TT']),
  );
  const dewF = measurementNumber(pickField(attrs, ['DewPoint', 'Dewpoint_F', 'DEWP', 'TD']));
  const rh = measurementNumber(
    pickField(attrs, ['RelativeHumidity', 'RelHum', 'REL_HUMIDITY', 'RH']),
  );
  const solar = measurementNumber(pickField(attrs, ['SolarRadiation', 'SOLAR_RAD', 'SRAD']));
  const precipIn = measurementNumber(pickField(attrs, ['RainAccumulation', 'PrecipAccum', 'PRECIP_ACCUM', 'PP']));

  const conditions: AirConditions = {
    ...emptyConditions(),
    dewPointC: validTemperatureC(dewF === null ? null : fahrenheitToCelsius(dewF)),
    relativeHumidityPercent: rh !== null && rh >= 0 && rh <= 100 ? rh : null,
    solarRadiationWm2: solar !== null && solar >= 0 ? solar : null,
    precipitationTodayMm:
      precipIn !== null && precipIn >= 0 ? Math.round(precipIn * 25.4 * 10) / 10 : null,
  };

  return {
    station,
    reading: {
      observedAt: new Date(observedAtMs).toISOString(),
      windAvgMps,
      windDirectionDeg: isCalm(windAvgMps) || dirDeg === null ? null : windDirection(dirDeg),
      windGustMps,
      windLullMps: null,
      temperatureC: validTemperatureC(tempF === null ? null : fahrenheitToCelsius(tempF)),
      windChillC: null,
      conditions,
    },
  };
}

export function parseRawsFeatureCollection(text: string): RawsParsedFeature[] {
  const data: unknown = JSON.parse(text);
  if (!isRecord(data) || !Array.isArray(data.features)) {
    throw new Error('RAWS FeatureServer response is missing features array');
  }
  const results: RawsParsedFeature[] = [];
  for (const feature of data.features) {
    const parsed = parseRawsFeature(feature);
    if (parsed) results.push(parsed);
  }
  return results;
}

export const loadRawsStation = defineStationAdapter<RawsStationConfig, RawsAdapterOptions>({
  meta: ({ station }) => stationMetaFromCatalogue(station, 'NIFC RAWS'),
  load: async ({ station }, { environment, options }) => {
    const url = new URL(options.queryUrl ?? RAWS_FEATURESERVER_QUERY_URL);
    const pad = 0.02;
    const envelope = `${station.longitude - pad},${station.latitude - pad},${station.longitude + pad},${station.latitude + pad}`;
    url.searchParams.set('f', 'json');
    url.searchParams.set('where', '1=1');
    url.searchParams.set('geometry', envelope);
    url.searchParams.set('geometryType', 'esriGeometryEnvelope');
    url.searchParams.set('inSR', '4326');
    url.searchParams.set('outSR', '4326');
    url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
    url.searchParams.set('outFields', '*');
    url.searchParams.set('resultRecordCount', '10');

    const text = await fetchUpstreamText(environment, {
      url,
      cacheKey: `raws/station/${station.nativeId}`,
      cacheTtlSeconds: CACHE_TTL_SECONDS,
      subject: `RAWS station ${station.nativeId}`,
    });

    const features = parseRawsFeatureCollection(text);
    const match =
      features.find(f => f.station.nativeId === station.nativeId.toUpperCase());
    if (!match || !match.reading) {
      throw new Error(`RAWS returned no active observation for ${station.nativeId}`);
    }
    return {
      reading: match.reading,
      history: null,
    };
  },
});

const coverage: Coverage = { kind: 'global' };

export const rawsProvider: StationNetworkProvider = {
  vendor: 'raws',
  coverage,
  async discover(options: DiscoverOptions = {}): Promise<CatalogueStation[]> {
    const seeds = (options.seeds ?? []).filter(station => station.vendor === 'raws');
    const batches: CatalogueStation[][] = [seeds];

    if (options.includeRemoteDiscovery !== false) {
      const environment = resolveEnvironment(options.environment);
      const pageSize = 2_000;
      for (let offset = 0; offset < 6_000; offset += pageSize) {
        try {
          const url = new URL(RAWS_FEATURESERVER_QUERY_URL);
          url.searchParams.set('f', 'json');
          url.searchParams.set('where', '1=1');
          url.searchParams.set('outFields', '*');
          url.searchParams.set('outSR', '4326');
          url.searchParams.set('orderByFields', 'OBJECTID');
          url.searchParams.set('resultOffset', String(offset));
          url.searchParams.set('resultRecordCount', String(pageSize));
          if (options.bounds) {
            url.searchParams.set('geometry', options.bounds.join(','));
            url.searchParams.set('geometryType', 'esriGeometryEnvelope');
            url.searchParams.set('inSR', '4326');
            url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
          }

          const text = await fetchUpstreamText(environment, {
            url,
            cacheKey: `raws/page/${offset}/${options.bounds?.join(',') ?? 'all'}`,
            cacheTtlSeconds: 900,
            subject: `NIFC RAWS catalogue page ${offset}`,
            timeoutMs: 12_000,
            limitBytes: 8 * 1024 * 1024,
          });
          const parsed = parseRawsFeatureCollection(text);
          batches.push(parsed.map(entry => entry.station));
          const page: unknown = JSON.parse(text);
          if (isRecord(page) && Array.isArray(page.features) && page.features.length < pageSize && page.exceededTransferLimit !== true) break;
        } catch (error) {
          logUpstreamFailure(environment, 'RAWS discovery failed', error);
          break;
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
      loadRawsStation({ station }, { environment, historyHours, mode }),
    );
  },
};
