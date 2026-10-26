export {
  createStationFeedHandler,
  defineStationAdapter,
  fetchUpstreamStream,
  fetchUpstreamText,
  loadStationClimatology,
  loadStationCurrent,
  loadStationFeed,
  loadStationHistory,
  memoryCache,
  openStationLive,
  resolveEnvironment,
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

export type {
  DiscoverOptions,
  ProviderCredentials,
  StationNetworkProvider,
} from './types.ts';

export {
  campbellConfigFromCatalogue,
  campbellProvider,
  ecowittConfigFromCatalogue,
  ecowittProvider,
  filterCatalogueStations,
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
  holfuyProvider,
  loadHolfuyStation,
  parseHolfuyObservation,
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

export { INITIAL_SEED_STATIONS } from './seeds.ts';

export {
  PROVIDERS,
  discoverStations,
  providerForVendor,
  toStationConfig,
  toStationConfigs,
  type AggregateCatalogueOptions,
} from './registry.ts';

export {
  DEFAULT_MAX_FEED_STATIONS,
  createStationsApiHandler,
  type StationsApiHandlerOptions,
} from './handler.ts';
