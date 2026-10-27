import {
  createOgimetSynopLoader,
  createOgimetSynopProvider,
  type OgimetWmoStationMeta,
} from './ogimet-synop.ts';

export type WmoNzStationMeta = OgimetWmoStationMeta;

/**
 * Live Ogimet block-93 WMO SYNOP stations for New Zealand (probed 2026-10-27).
 * Coordinates/elevations/names come from Ogimet `state=New Zealand` HTML.
 * `region` is left null — Ogimet does not publish NZ regional-council labels;
 * catalogue overrides own shortNames/regions when curated.
 */
export const NEW_ZEALAND_WMO_SYNOP_STATIONS: readonly WmoNzStationMeta[] = [
  { wmoId: '93004', name: 'Cape Reinga', region: null, latitude: -34.4292, longitude: 172.6817, elevationM: 214 },
  { wmoId: '93008', name: 'Kaitaia', region: null, latitude: -35.0678, longitude: 173.2872, elevationM: 80 },
  { wmoId: '93014', name: 'Kaitaia Airport', region: null, latitude: -35.0678, longitude: 173.2861, elevationM: 82 },
  { wmoId: '93021', name: 'Kerikeri Aero Aws', region: null, latitude: -35.2628, longitude: 173.9111, elevationM: 150 },
  { wmoId: '93057', name: 'Whangarei Aerodrome', region: null, latitude: -35.7706, longitude: 174.3628, elevationM: 38 },
  { wmoId: '93069', name: 'Mokohinau Aws', region: null, latitude: -35.9028, longitude: 175.1153, elevationM: 69 },
  { wmoId: '93110', name: 'Auckland Aerodrome Aws', region: null, latitude: -37.0089, longitude: 174.8069, elevationM: 7 },
  { wmoId: '93129', name: 'Whitianga Aerodrome Aws', region: null, latitude: -36.8319, longitude: 175.6753, elevationM: 4 },
  { wmoId: '93173', name: 'Hamilton Aws', region: null, latitude: -37.8606, longitude: 175.3317, elevationM: 52 },
  { wmoId: '93186', name: 'Tauranga Aerodrome Aws', region: null, latitude: -37.6706, longitude: 176.1964, elevationM: 4 },
  { wmoId: '93191', name: 'Whakatane Aws', region: null, latitude: -37.9244, longitude: 176.9181, elevationM: 6 },
  { wmoId: '93196', name: 'Hicks Bay Aws', region: null, latitude: -37.5608, longitude: 178.3142, elevationM: 45 },
  { wmoId: '93201', name: 'Port Taharoa', region: null, latitude: -38.1711, longitude: 174.7039, elevationM: 16 },
  { wmoId: '93245', name: 'Taupo Aws', region: null, latitude: -38.7422, longitude: 176.0806, elevationM: 407 },
  { wmoId: '93292', name: 'Gisborne Aerodrome Aws', region: null, latitude: -38.6583, longitude: 177.985, elevationM: 5 },
  { wmoId: '93309', name: 'New Plymouth Aws', region: null, latitude: -39.0078, longitude: 174.1833, elevationM: 30 },
  { wmoId: '93313', name: 'Hawera Aws', region: null, latitude: -39.6097, longitude: 174.2914, elevationM: 98 },
  { wmoId: '93327', name: 'Wanganui Aero Aws', region: null, latitude: -39.9611, longitude: 175.0258, elevationM: 13 },
  { wmoId: '93339', name: 'Waiouru Airstrip', region: null, latitude: -39.4458, longitude: 175.6578, elevationM: 819 },
  { wmoId: '93373', name: 'Napier Aerodrome Aws', region: null, latitude: -39.4703, longitude: 176.8642, elevationM: 2 },
  { wmoId: '93393', name: 'Mahia Aws', region: null, latitude: -39.1169, longitude: 177.9617, elevationM: 135 },
  { wmoId: '93404', name: 'Palmerston North Aws', region: null, latitude: -40.3183, longitude: 175.6144, elevationM: 39 },
  { wmoId: '93420', name: 'Paraparaumu Aws', region: null, latitude: -40.9042, longitude: 174.985, elevationM: 6 },
  { wmoId: '93439', name: 'Wellington Airport', region: null, latitude: -41.3311, longitude: 174.8056, elevationM: 4 },
  { wmoId: '93441', name: 'Takapau Plains Aws', region: null, latitude: -40.0417, longitude: 176.2681, elevationM: 346 },
  { wmoId: '93479', name: 'Ngawihi', region: null, latitude: -41.5881, longitude: 175.2333, elevationM: 6 },
  { wmoId: '93498', name: 'Castlepoint', region: null, latitude: -40.9042, longitude: 176.2117, elevationM: 118 },
  { wmoId: '93515', name: 'Westport Aerodrome', region: null, latitude: -41.7406, longitude: 171.5794, elevationM: 4 },
  { wmoId: '93527', name: 'Farewell Spit Aws', region: null, latitude: -40.5444, longitude: 173.0006, elevationM: 3 },
  { wmoId: '93546', name: 'Nelson Aerodrome Aws', region: null, latitude: -41.3006, longitude: 173.2156, elevationM: 5 },
  { wmoId: '93562', name: 'Stephens Island Aws', region: null, latitude: -40.665, longitude: 173.9994, elevationM: 186 },
  { wmoId: '93597', name: 'Cape Campbell Aws', region: null, latitude: -41.7264, longitude: 174.2758, elevationM: 5 },
  { wmoId: '93615', name: 'Hokitika Aerodrome Aws', region: null, latitude: -42.7128, longitude: 170.9842, elevationM: 47 },
  { wmoId: '93678', name: 'Kaikoura', region: null, latitude: -42.4203, longitude: 173.6958, elevationM: 107 },
  { wmoId: '93709', name: 'Haast Aws', region: null, latitude: -43.8597, longitude: 169.0064, elevationM: 3 },
  { wmoId: '93721', name: 'Milford Sound Aws', region: null, latitude: -44.6728, longitude: 167.9228, elevationM: 3 },
  { wmoId: '93738', name: 'Mt Cook Aero Aws', region: null, latitude: -43.765, longitude: 170.1314, elevationM: 656 },
  { wmoId: '93747', name: 'Tara Hills', region: null, latitude: -44.5258, longitude: 169.8892, elevationM: 484 },
  { wmoId: '93773', name: 'Timaru Aerodrome Aws', region: null, latitude: -44.3047, longitude: 171.2214, elevationM: 27 },
  { wmoId: '93781', name: 'Christchurch Aerodrome Aws', region: null, latitude: -43.4894, longitude: 172.5267, elevationM: 38 },
  { wmoId: '93791', name: 'Lincoln Broadfield', region: null, latitude: -43.6261, longitude: 172.4703, elevationM: 18 },
  { wmoId: '93792', name: 'Le Bon Bay Aws', region: null, latitude: -43.7456, longitude: 173.1217, elevationM: 236 },
  { wmoId: '93796', name: 'Oamaru Airport Aws', region: null, latitude: -44.9717, longitude: 171.0806, elevationM: 30 },
  { wmoId: '93800', name: 'Secretary Island Aws', region: null, latitude: -45.2206, longitude: 166.8844, elevationM: 18 },
  { wmoId: '93805', name: 'Puysegur Point Aws', region: null, latitude: -46.1558, longitude: 166.6128, elevationM: 44 },
  { wmoId: '93817', name: 'Lauder Upper Air', region: null, latitude: -45.0383, longitude: 169.6842, elevationM: 371 },
  { wmoId: '93831', name: 'Queenstown Aerodrome', region: null, latitude: -45.0172, longitude: 168.74, elevationM: 357 },
  { wmoId: '93845', name: 'Invercargill Airport Aws', region: null, latitude: -46.4106, longitude: 168.3178, elevationM: 2 },
  { wmoId: '93887', name: 'Nugget Point Aws', region: null, latitude: -46.4472, longitude: 169.8117, elevationM: 131 },
  { wmoId: '93891', name: 'Dunedin Aerodrome Aws', region: null, latitude: -45.9267, longitude: 170.1967, elevationM: 1 },
  { wmoId: '93909', name: 'South West Cape Aws', region: null, latitude: -47.2767, longitude: 167.4628, elevationM: 103 },
  { wmoId: '93929', name: 'Enderby Island Aws', region: null, latitude: -50.4931, longitude: 166.2956, elevationM: 39 },
  { wmoId: '93947', name: 'Campbell Island Aws', region: null, latitude: -52.5506, longitude: 169.1497, elevationM: 15 },
  {
    wmoId: '93985',
    name: 'Chatham Island Aero Aws',
    region: null,
    latitude: -43.8167,
    longitude: -176.475,
    elevationM: 13,
    timeZone: 'Pacific/Chatham',
  },
  {
    wmoId: '93988',
    name: 'Chatham Island',
    region: null,
    latitude: -43.8167,
    longitude: -176.4747,
    elevationM: 15,
    timeZone: 'Pacific/Chatham',
  },
  { wmoId: '93994', name: 'Raoul Island Kermadec Island', region: null, latitude: -29.2444, longitude: -177.9289, elevationM: 48 },
];

export const loadWmoNzStation = createOgimetSynopLoader({
  vendor: 'wmo_nz',
  sourceLabel: 'New Zealand WMO SYNOP (Ogimet)',
  cacheTtlSeconds: 900,
});

export const wmoNzProvider = createOgimetSynopProvider({
  vendor: 'wmo_nz',
  region: 'NZ',
  stateQuery: 'New Zealand',
  stations: NEW_ZEALAND_WMO_SYNOP_STATIONS,
  defaultTimeZone: 'Pacific/Auckland',
  sourceLabel: 'New Zealand WMO SYNOP (Ogimet)',
  nameSuffix: meta => ` (MetService WMO ${meta.wmoId})`,
  cacheTtlSeconds: 900,
});
