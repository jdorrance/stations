import {
  createJsonPoller,
  createStationClimatologyStore,
  createStationCurrentStore,
  createStationFeedStore,
  createStationHistoryStore,
  createStationLiveStore,
  createStationStore,
  subscribeTicker,
  type JsonPoller,
  type JsonPollerOptions,
  type LiveStatus,
  type PollError,
  type PollSeed,
  type PollSnapshot,
  type StationClimatologySnapshot,
  type StationClimatologyStore,
  type StationHistoryQuery,
  type StationHistoryStore,
  type StationLiveSnapshot,
  type StationLiveStore,
  type StationSnapshot,
  type StationStore,
} from '@azohra/meteo.station/client';
import {
  catalogueToGeoJson,
  feedToGeoJson,
  parseStationCatalogueJson,
  parseStationCurrentJson,
  parseStationFeedJson,
  type CatalogueStation,
  type StationCatalogueDocument,
  type StationCurrent,
  type StationFeatureCollection,
  type StationFeed,
  type StationVendor,
} from '@stations/contracts';
import {
  createSpatialIndex,
  type Bounds,
  type NearbyMatch,
  type Position,
  type RegionCode,
} from '@stations/geography';

export {
  createJsonPoller,
  createStationClimatologyStore,
  createStationCurrentStore,
  createStationFeedStore,
  createStationHistoryStore,
  createStationLiveStore,
  createStationStore,
  subscribeTicker,
};

export type {
  JsonPoller,
  JsonPollerOptions,
  LiveStatus,
  PollError,
  PollSeed,
  PollSnapshot,
  StationClimatologySnapshot,
  StationClimatologyStore,
  StationHistoryQuery,
  StationHistoryStore,
  StationLiveSnapshot,
  StationLiveStore,
  StationSnapshot,
  StationStore,
};

export interface CatalogueQueryFilter {
  readonly countries?: readonly RegionCode[];
  readonly vendors?: readonly StationVendor[];
  readonly limit?: number;
}

export interface CatalogueIndex {
  readonly document: StationCatalogueDocument;
  readonly size: number;
  readonly byUidMap: ReadonlyMap<string, CatalogueStation>;
  all(filter?: CatalogueQueryFilter): CatalogueStation[];
  byUid(uid: string): CatalogueStation | undefined;
  inBounds(bounds: Bounds, filter?: CatalogueQueryFilter): CatalogueStation[];
  near(
    center: Position,
    radiusKm: number,
    filter?: CatalogueQueryFilter,
  ): NearbyMatch<CatalogueStation>[];
  toGeoJson(stations?: readonly CatalogueStation[]): StationFeatureCollection;
}

function applyCatalogueFilter(
  stations: readonly CatalogueStation[],
  filter?: CatalogueQueryFilter,
): CatalogueStation[] {
  if (!filter) return [...stations];
  const countrySet = filter.countries?.length ? new Set(filter.countries) : null;
  const vendorSet = filter.vendors?.length ? new Set(filter.vendors) : null;
  let filtered = stations.filter(station => {
    if (countrySet && (station.country === null || !countrySet.has(station.country))) return false;
    if (vendorSet && !vendorSet.has(station.vendor)) return false;
    return true;
  });
  if (filter.limit !== undefined && filter.limit > 0) {
    filtered = filtered.slice(0, Math.floor(filter.limit));
  }
  return filtered;
}

export function createCatalogueIndex(document: StationCatalogueDocument): CatalogueIndex {
  const spatial = createSpatialIndex(document.stations, 1);
  const byUidMap = new Map<string, CatalogueStation>(
    document.stations.map(station => [station.uid, station]),
  );

  return {
    document,
    size: document.stations.length,
    byUidMap,
    all(filter?: CatalogueQueryFilter): CatalogueStation[] {
      return applyCatalogueFilter(document.stations, filter);
    },
    byUid(uid: string): CatalogueStation | undefined {
      return byUidMap.get(uid);
    },
    inBounds(bounds: Bounds, filter?: CatalogueQueryFilter): CatalogueStation[] {
      return applyCatalogueFilter(spatial.queryBounds(bounds), filter);
    },
    near(
      center: Position,
      radiusKm: number,
      filter?: CatalogueQueryFilter,
    ): NearbyMatch<CatalogueStation>[] {
      const rawMatches = spatial.queryRadius(center, radiusKm);
      if (!filter) return rawMatches;
      const countrySet = filter.countries?.length ? new Set(filter.countries) : null;
      const vendorSet = filter.vendors?.length ? new Set(filter.vendors) : null;
      const filtered = rawMatches.filter(({ item }) => {
        if (countrySet && (item.country === null || !countrySet.has(item.country))) return false;
        if (vendorSet && !vendorSet.has(item.vendor)) return false;
        return true;
      });
      return filter.limit !== undefined && filter.limit > 0
        ? filtered.slice(0, Math.floor(filter.limit))
        : filtered;
    },
    toGeoJson(stations: readonly CatalogueStation[] = document.stations): StationFeatureCollection {
      return catalogueToGeoJson(stations, document.generatedAt);
    },
  };
}

export interface SpatialQueryParams {
  readonly ids?: readonly string[];
  readonly bounds?: Bounds;
  readonly near?: {
    readonly position: Position;
    readonly radiusKm: number;
  };
  readonly countries?: readonly RegionCode[];
  readonly vendors?: readonly StationVendor[];
  readonly limit?: number;
  readonly hours?: number;
}

export interface StationsClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
}

export interface StationsClient {
  endpointUrl(route: 'catalogue' | 'feed' | 'current' | 'live' | 'history', query?: SpatialQueryParams): string;
  loadCatalogue(query?: SpatialQueryParams): Promise<StationCatalogueDocument | null>;
  loadCatalogueIndex(query?: SpatialQueryParams): Promise<CatalogueIndex | null>;
  loadFeed(query?: SpatialQueryParams): Promise<StationFeed | null>;
  loadGeoJsonFeed(
    query?: SpatialQueryParams,
    catalogueByUid?: ReadonlyMap<string, CatalogueStation>,
  ): Promise<StationFeatureCollection | null>;
  loadCurrent(uid: string): Promise<StationCurrent | null>;
}

function buildQueryString(query?: SpatialQueryParams): string {
  if (!query) return '';
  const params = new URLSearchParams();
  if (query.ids?.length) params.set('ids', query.ids.join(','));
  if (query.bounds) params.set('bbox', query.bounds.join(','));
  if (query.near) {
    params.set(
      'near',
      `${query.near.position.latitude},${query.near.position.longitude},${query.near.radiusKm}`,
    );
  }
  if (query.countries?.length) params.set('country', query.countries.join(','));
  if (query.vendors?.length) params.set('vendor', query.vendors.join(','));
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.hours !== undefined) params.set('hours', String(query.hours));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function createStationsClient(options: StationsClientOptions): StationsClient {
  const base = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);

  const endpointUrl = (
    route: 'catalogue' | 'feed' | 'current' | 'live' | 'history',
    query?: SpatialQueryParams,
  ): string => `${base}/${route}${buildQueryString(query)}`;

  async function getText(url: string): Promise<string | null> {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) return null;
      return await response.text();
    } catch {
      return null;
    }
  }

  return {
    endpointUrl,
    async loadCatalogue(query?: SpatialQueryParams): Promise<StationCatalogueDocument | null> {
      const text = await getText(endpointUrl('catalogue', query));
      return text === null ? null : parseStationCatalogueJson(text);
    },
    async loadCatalogueIndex(query?: SpatialQueryParams): Promise<CatalogueIndex | null> {
      const doc = await this.loadCatalogue(query);
      return doc === null ? null : createCatalogueIndex(doc);
    },
    async loadFeed(query?: SpatialQueryParams): Promise<StationFeed | null> {
      const text = await getText(endpointUrl('feed', query));
      return text === null ? null : parseStationFeedJson(text);
    },
    async loadGeoJsonFeed(
      query?: SpatialQueryParams,
      catalogueByUid?: ReadonlyMap<string, CatalogueStation>,
    ): Promise<StationFeatureCollection | null> {
      const feed = await this.loadFeed(query);
      return feed === null ? null : feedToGeoJson(feed, catalogueByUid);
    },
    async loadCurrent(uid: string): Promise<StationCurrent | null> {
      const url = `${base}/current?station=${encodeURIComponent(uid)}`;
      const text = await getText(url);
      return text === null ? null : parseStationCurrentJson(text);
    },
  };
}

export interface ViewportStationSnapshot {
  readonly bounds: Bounds | null;
  readonly feed: StationFeed | null;
  readonly geojson: StationFeatureCollection | null;
  readonly loading: boolean;
  readonly updatedAtMs: number | null;
}

export interface ViewportStationStoreOptions {
  readonly client: StationsClient;
  readonly initialBounds?: Bounds;
  readonly countries?: readonly RegionCode[];
  readonly vendors?: readonly StationVendor[];
  readonly limit?: number;
  readonly catalogueByUid?: ReadonlyMap<string, CatalogueStation>;
}

export interface ViewportStationStore {
  getSnapshot(): ViewportStationSnapshot;
  setViewport(bounds: Bounds): Promise<ViewportStationSnapshot>;
  refresh(): Promise<ViewportStationSnapshot>;
  subscribe(listener: () => void): () => void;
}

export function createViewportStationStore(
  options: ViewportStationStoreOptions,
): ViewportStationStore {
  const listeners = new Set<() => void>();
  let snapshot: ViewportStationSnapshot = {
    bounds: options.initialBounds ?? null,
    feed: null,
    geojson: null,
    loading: false,
    updatedAtMs: null,
  };

  const emit = (next: ViewportStationSnapshot): ViewportStationSnapshot => {
    snapshot = next;
    for (const listener of listeners) listener();
    return snapshot;
  };

  async function loadForBounds(bounds: Bounds | null): Promise<ViewportStationSnapshot> {
    if (!bounds) return snapshot;
    emit({ ...snapshot, bounds, loading: true });
    const feed = await options.client.loadFeed({
      bounds,
      countries: options.countries,
      vendors: options.vendors,
      limit: options.limit,
    });
    const geojson = feed ? feedToGeoJson(feed, options.catalogueByUid) : snapshot.geojson;
    return emit({
      bounds,
      feed: feed ?? snapshot.feed,
      geojson,
      loading: false,
      updatedAtMs: feed ? Date.now() : snapshot.updatedAtMs,
    });
  }

  return {
    getSnapshot: () => snapshot,
    setViewport(bounds: Bounds): Promise<ViewportStationSnapshot> {
      return loadForBounds(bounds);
    },
    refresh(): Promise<ViewportStationSnapshot> {
      return loadForBounds(snapshot.bounds);
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
