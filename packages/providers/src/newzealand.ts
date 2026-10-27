/**
 * New Zealand provider barrel. Prefer importing from the owning module:
 * `wmo-nz.ts`, `hilltop.ts`, `ecan.ts`, `zephyr.ts`.
 */
export {
  NEW_ZEALAND_WMO_SYNOP_STATIONS,
  loadWmoNzStation,
  wmoNzProvider,
  type WmoNzStationMeta,
} from './wmo-nz.ts';

export {
  HILLTOP_COUNCILS,
  hilltopCouncil,
  hilltopProvider,
  hilltopSpeedToMps,
  loadHilltopStation,
  parseHilltopGetData,
  type HilltopAdapterOptions,
  type HilltopCouncilConfig,
  type HilltopStationConfig,
} from './hilltop.ts';

export {
  ECAN_WIND_LAYER_URL,
  ecanProvider,
  loadEcanStation,
  parseEcanObservation,
  parseEcanWindFeatures,
  type EcanAdapterOptions,
  type EcanStationConfig,
} from './ecan.ts';

export {
  ZEPHYR_DIRECT_TYPE_MAP,
  ZEPHYR_STATIONS_URL,
  loadZephyrStation,
  parseZephyrObservation,
  parseZephyrStations,
  zephyrProvider,
  type ZephyrAdapterOptions,
  type ZephyrStationConfig,
} from './zephyr.ts';
