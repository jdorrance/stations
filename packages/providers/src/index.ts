export {
  memoryCache,
  workersCache,
  type FeedCache,
  type ResolvedEnvironment,
  type ServerEnvironment,
  type StationAdapter,
  type StationAdapterContext,
  type StationAdapterDefinition,
  type StationAdapterMode,
  type StationAdapterOptions,
  type StationAdapterResult,
  type StationConfig,
  type StationConfigInput,
  type StationFeedHandler,
  type StationFeedHandlerOptions,
} from '@azohra/meteo.station/server';
export {
  createStationFeedHandler,
  defineStationAdapter,
  fetchUpstreamStream,
  fetchUpstreamText,
  loadStationClimatology,
  loadStationCurrent,
  loadStationFeed,
  loadStationHistory,
  openStationLive,
  resolveEnvironment,
} from './server.ts';

export type {
  DiscoverOptions,
  ProviderCredentials,
  StationNetworkProvider,
} from './types.ts';

export {
  WINDNERD_DIRECTORY_URL,
  WINDNERD_LIVE_BASE_URL,
  campbellConfigFromCatalogue,
  campbellProvider,
  ecowittConfigFromCatalogue,
  ecowittProvider,
  filterCatalogueStations,
  parseWindnerdDirectoryHtml,
  stationMetaFromCatalogue,
  tempestConfigFromCatalogue,
  tempestProvider,
  windnerdConfigFromCatalogue,
  windnerdProvider,
} from './azohra-vendors.ts';

export {
  OPENWINDMAP_ARCHIVE_URL,
  OPENWINDMAP_STATION_URL,
  loadOpenWindMapStation,
  openWindMapProvider,
  parseOpenWindMapArchive,
  parseOpenWindMapEntry,
  parseOpenWindMapSingle,
  type OpenWindMapAdapterOptions,
  type OpenWindMapParsedStation,
  type OpenWindMapStationConfig,
} from './openwindmap.ts';

export {
  HOLFUY_LIVE_URL,
  HOLFUY_PAGE_URL,
  HOLFUY_STATIONS_LIST_URL,
  HOLFUY_WIDGET_JSON_URL,
  holfuyProvider,
  loadHolfuyStation,
  parseHolfuyObservation,
  parseHolfuyStationsList,
  parseHolfuyWeatherPageHtml,
  parseHolfuyWidgetJson,
  type HolfuyAdapterOptions,
  type HolfuyObservation,
  type HolfuyStationConfig,
} from './holfuy.ts';

export {
  AWC_METAR_URL,
  awcProvider,
  loadAwcStation,
  parseAwcMetarEntry,
  parseAwcMetarList,
  type AwcAdapterOptions,
  type AwcParsedMetar,
  type AwcStationConfig,
} from './awc.ts';

export {
  WINDSMOBI_STATIONS_URL,
  loadWindsMobiStation,
  parseWindsMobiEntry,
  parseWindsMobiHistoric,
  parseWindsMobiList,
  parseWindsMobiMeasure,
  windsMobiProvider,
  type WindsMobiAdapterOptions,
  type WindsMobiParsedEntry,
  type WindsMobiStationConfig,
} from './windsmobi.ts';

export {
  WINDSPION_NEAR_URL,
  loadWindSpionStation,
  parseWindSpionEntry,
  parseWindSpionList,
  windSpionProvider,
  type WindSpionAdapterOptions,
  type WindSpionParsedEntry,
  type WindSpionStationConfig,
} from './windspion.ts';

export {
  WINDGURU_IAPI_URL,
  loadWindGuruStation,
  parseWindGuruCurrent,
  parseWindGuruStationsList,
  windGuruProvider,
  type WindGuruAdapterOptions,
  type WindGuruStationConfig,
} from './windguru.ts';

export {
  WEATHERLINK_BULLETIN_URL,
  loadRealtimeTxtStation,
  loadWeatherLinkStation,
  parseRealtimeTxt,
  parseWeatherLinkBulletin,
  realtimeTxtProvider,
  weatherLinkProvider,
  type RealtimeTxtStationConfig,
  type WeatherLinkAdapterOptions,
  type WeatherLinkStationConfig,
} from './windtalkers.ts';

export {
  RAWS_FEATURESERVER_QUERY_URL,
  loadRawsStation,
  parseRawsFeature,
  parseRawsFeatureCollection,
  rawsProvider,
  type RawsAdapterOptions,
  type RawsParsedFeature,
  type RawsStationConfig,
} from './raws.ts';

export {
  AWDB_DATA_URL,
  AWDB_STATIONS_URL,
  loadSnotelStation,
  parseSnotelDataResponse,
  parseSnotelStationsList,
  snotelProvider,
  type SnotelAdapterOptions,
  type SnotelStationConfig,
} from './snotel.ts';

export {
  AVALANCHE_CA_STATIONS_URL,
  SNOWOBS_CURRENT_URL,
  SNOWOBS_TIMESERIES_URL,
  avalancheProvider,
  loadAvalancheStation,
  parseAvalancheCanadaMeasurements,
  parseAvalancheCanadaStations,
  parseSnowObsCurrentGeoJson,
  type AvalancheAdapterOptions,
  type AvalancheStationConfig,
} from './avalanche.ts';

export {
  CA_PROVINCE_CODES,
  IEM_CURRENTS_URL,
  IEM_NETWORK_GEOJSON_BASE_URL,
  US_STATE_CODES,
  iemNetworksForRegions,
  iemProvider,
  loadIemStation,
  parseIemCurrentRow,
  parseIemCurrentsResponse,
  parseIemNetworkGeoJson,
  type IemAdapterOptions,
  type IemStationConfig,
} from './iem.ts';

export {
  NWS_STATIONS_URL,
  loadNwsStation,
  nwsProvider,
  parseNwsLatestObservation,
  parseNwsStationsCollection,
  type NwsAdapterOptions,
  type NwsStationConfig,
} from './nws.ts';

export {
  ECCC_SWOB_REALTIME_URL,
  ECCC_SWOB_STATIONS_URL,
  ecccProvider,
  loadEcccStation,
  parseEcccSwobRealtime,
  parseEcccSwobStations,
  type EcccAdapterOptions,
  type EcccStationConfig,
} from './eccc.ts';

export {
  NDBC_LATEST_OBS_URL,
  NDBC_REALTIME2_BASE_URL,
  loadNdbcStation,
  ndbcProvider,
  parseNdbcLatestObs,
  parseNdbcRealtime2,
  type NdbcAdapterOptions,
  type NdbcParsedRow,
  type NdbcStationConfig,
} from './ndbc.ts';

export {
  CONAGUA_EMAS_CAPAS_URL,
  conaguaProvider,
  loadConaguaStation,
  parseConaguaEmaObservation,
  parseConaguaEmasCatalogue,
  type ConaguaAdapterOptions,
  type ConaguaStationConfig,
} from './conagua.ts';

export {
  AMBIENT_DEVICES_URL,
  FINDU_RAW_WX_URL,
  SYNOPTIC_LATEST_URL,
  WINDY_PWS_URL,
  WU_PWS_CURRENT_URL,
  ambientProvider,
  cwopProvider,
  loadAmbientStation,
  loadCwopStation,
  loadSynopticStation,
  loadWindyStation,
  loadWuPwsStation,
  parseAmbientDeviceObservation,
  parseAprsWxPacket,
  parseSynopticLatest,
  parseWindyPwsResponse,
  parseWuPwsCurrent,
  synopticProvider,
  windyProvider,
  wundergroundProvider,
} from './cwop.ts';

export {
  ARMENIA_WMO_SYNOP_STATIONS,
  CLIMATENET_DEVICE_BASE_URL,
  CLIMATENET_LIST_URL,
  OGIMET_GETSYNOP_URL,
  climatenetProvider,
  hydrometAmProvider,
  loadClimateNetStation,
  loadHydrometAmStation,
  parseClimateNetDeviceList,
  parseClimateNetGraph,
  parseClimateNetLatest,
  parseOgimetSynopBatch,
  parseOgimetSynopLine,
  type ClimateNetAdapterOptions,
  type ClimateNetStationConfig,
  type HydrometAmAdapterOptions,
  type HydrometAmStationConfig,
  type HydrometAmStationMeta,
} from './armenia.ts';

export { INITIAL_SEED_STATIONS } from './seeds.ts';

export {
  DEFAULT_DISCOVERY_VENDORS,
  PROVIDERS,
  discoverStations,
  providerForVendor,
  toStationConfig,
  toStationConfigs,
  unwrapAggregatorStation,
  mergeDiscoveredStations,
  type AggregateCatalogueOptions,
} from './registry.ts';

export {
  DEFAULT_MAX_FEED_STATIONS,
  createStationsApiHandler,
  type StationsApiHandlerOptions,
} from './handler.ts';

export {
  MAX_OBSERVATION_AGE_DAYS,
  MAX_OBSERVATION_AGE_MS,
  MAX_OBSERVATION_AGE_SECONDS,
  isRecentObservation,
} from './observation-values.ts';

export { createProviderFetch, type ProviderFetchOptions, type ProviderRateLimit } from './transport.ts';
