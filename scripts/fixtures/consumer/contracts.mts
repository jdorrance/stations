// Compile-time checks against installed package declarations.
import type { Bounds, Position, RegionCode } from '@stations/geography';
import { INITIAL_SCOPE_REGIONS, createSpatialIndex } from '@stations/geography';
import {
  formatStationUid,
  type CatalogueStation,
  type StationFeatureCollection,
  type StationFeed,
  type StationVendor,
} from '@stations/contracts';
import {
  createCatalogueIndex,
  createStationsClient,
  createViewportStationStore,
} from '@stations/client';
import {
  INITIAL_SEED_STATIONS,
  createStationsApiHandler,
  discoverStations,
} from '@stations/providers';

const pos: Position = { latitude: 40.2727, longitude: 44.7074 };
const bounds: Bounds = [43.44, 38.84, 46.63, 41.30];
const region: RegionCode = INITIAL_SCOPE_REGIONS[3]!;
const vendor: StationVendor = 'holfuy';
const uid: string = formatStationUid(vendor, 1652);
const spatial = createSpatialIndex(INITIAL_SEED_STATIONS);
const matches: CatalogueStation[] = spatial.queryBounds(bounds);

const catalogueDoc = await discoverStations({ regions: [region], includeRemoteDiscovery: false });
const index = createCatalogueIndex(catalogueDoc);
const geo: StationFeatureCollection = index.toGeoJson();

const handler = createStationsApiHandler({ catalogue: catalogueDoc });
const client = createStationsClient({ baseUrl: 'https://stations.example/api' });
const feedPromise: Promise<StationFeed | null> = client.loadFeed({ bounds });
const viewportStore = createViewportStationStore({ client, initialBounds: bounds });

// @ts-expect-error Position requires latitude and longitude, not lat/lon.
const badPos: Position = { lat: 40.2, lon: 44.7 };
// @ts-expect-error RegionCode only accepts supported ISO codes.
const badRegion: RegionCode = 'FR';
// @ts-expect-error Internal dist paths are not public exports.
await import('@stations/geography/dist/regions.js');

void [pos, matches, uid, geo, handler, feedPromise, viewportStore, badPos, badRegion];
