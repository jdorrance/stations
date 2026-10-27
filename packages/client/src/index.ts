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
  defaultCategoryForVendor,
  feedToGeoJson,
  parseStationCatalogueJson,
  parseStationCurrentJson,
  parseStationFeedJson,
  type CatalogueStation,
  type StationCatalogueDocument,
  type StationCategory,
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
  readonly categories?: readonly StationCategory[];
  readonly launchSlug?: string;
  readonly maxLaunchDistanceKm?: number;
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

function hasActiveFilter(filter?: CatalogueQueryFilter): boolean {
  if (!filter) return false;
  return Boolean(
    filter.countries?.length ||
      filter.vendors?.length ||
      filter.categories?.length ||
      filter.launchSlug ||
      filter.maxLaunchDistanceKm !== undefined ||
      filter.limit !== undefined,
  );
}

function applyCatalogueFilter(
  stations: readonly CatalogueStation[],
  filter?: CatalogueQueryFilter,
): CatalogueStation[] {
  if (!hasActiveFilter(filter)) return [...stations];
  const activeFilter = filter!;
  const countrySet = activeFilter.countries?.length ? new Set(activeFilter.countries) : null;
  const vendorSet = activeFilter.vendors?.length ? new Set(activeFilter.vendors) : null;
  const categorySet = activeFilter.categories?.length ? new Set(activeFilter.categories) : null;
  let filtered = stations.filter(station => {
    if (countrySet && (station.country === null || !countrySet.has(station.country))) return false;
    if (vendorSet && !vendorSet.has(station.vendor)) return false;
    if (
      categorySet &&
      !categorySet.has(station.category ?? defaultCategoryForVendor(station.vendor))
    ) {
      return false;
    }
    if (
      activeFilter.launchSlug &&
      station.launchContext?.nearestLaunchSlug !== activeFilter.launchSlug
    ) {
      return false;
    }
    if (
      activeFilter.maxLaunchDistanceKm !== undefined &&
      (!station.launchContext ||
        station.launchContext.distanceKm > activeFilter.maxLaunchDistanceKm)
    ) {
      return false;
    }
    return true;
  });
  if (activeFilter.limit !== undefined) {
    filtered =
      Number.isFinite(activeFilter.limit) && activeFilter.limit > 0
        ? filtered.slice(0, Math.floor(activeFilter.limit))
        : [];
  }
  return filtered;
}

export function createCatalogueIndex(document: StationCatalogueDocument): CatalogueIndex {
  const spatial = createSpatialIndex(document.stations, 1);
  const byUidMap = new Map<string, CatalogueStation>();
  for (const station of document.stations) {
    byUidMap.set(station.uid, station);
  }
  // Canonical UIDs win collisions; aliases resolve to the same retained station.
  for (const station of document.stations) {
    for (const alias of station.aliases ?? []) {
      if (!byUidMap.has(alias)) byUidMap.set(alias, station);
    }
  }
  let cachedFullGeoJson: StationFeatureCollection | null = null;

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
      if (!hasActiveFilter(filter)) return rawMatches;
      const selected = new Set(applyCatalogueFilter(rawMatches.map(match => match.item), filter));
      return rawMatches.filter(match => selected.has(match.item));
    },
    toGeoJson(stations: readonly CatalogueStation[] = document.stations): StationFeatureCollection {
      if (stations === document.stations) {
        if (!cachedFullGeoJson) {
          cachedFullGeoJson = catalogueToGeoJson(document.stations, document.generatedAt);
        }
        return cachedFullGeoJson;
      }
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
  readonly categories?: readonly StationCategory[];
  readonly launch?: string;
  readonly limit?: number;
  readonly hours?: number;
}

export interface StationsRequestOptions {
  readonly signal?: AbortSignal;
  /** Milliseconds before cancelling the request. Set to 0 to disable the timeout. */
  readonly timeoutMs?: number;
}

export interface StationsClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  /** Default timeout for requests, including response bodies. Defaults to 15 seconds. */
  readonly timeoutMs?: number;
}

export interface StationsClientError {
  readonly kind: 'http' | 'network' | 'parse' | 'aborted' | 'timeout' | 'unknown';
  readonly message: string;
  readonly status?: number;
}

export type StationsClientResult<T> =
  | { readonly data: T; readonly error: null }
  | { readonly data: null; readonly error: StationsClientError };

export interface StationsClient {
  endpointUrl(route: 'catalogue' | 'feed' | 'current' | 'live' | 'history', query?: SpatialQueryParams): string;
  loadCatalogue(query?: SpatialQueryParams, request?: StationsRequestOptions): Promise<StationCatalogueDocument | null>;
  loadCatalogueIndex(query?: SpatialQueryParams, request?: StationsRequestOptions): Promise<CatalogueIndex | null>;
  loadFeed(query?: SpatialQueryParams, request?: StationsRequestOptions): Promise<StationFeed | null>;
  loadGeoJsonFeed(
    query?: SpatialQueryParams,
    catalogueByUid?: ReadonlyMap<string, CatalogueStation>,
    request?: StationsRequestOptions,
  ): Promise<StationFeatureCollection | null>;
  loadCurrent(uid: string, request?: StationsRequestOptions): Promise<StationCurrent | null>;
  /** Optional for compatibility with custom clients implementing the nullable API. */
  loadCatalogueResult?(query?: SpatialQueryParams, request?: StationsRequestOptions): Promise<StationsClientResult<StationCatalogueDocument>>;
  loadFeedResult?(query?: SpatialQueryParams, request?: StationsRequestOptions): Promise<StationsClientResult<StationFeed>>;
  loadCurrentResult?(uid: string, request?: StationsRequestOptions): Promise<StationsClientResult<StationCurrent>>;
}

/** Clients created by createStationsClient always expose detailed request results. */
export interface StationsHttpClient extends StationsClient {
  loadCatalogueResult(query?: SpatialQueryParams, request?: StationsRequestOptions): Promise<StationsClientResult<StationCatalogueDocument>>;
  loadFeedResult(query?: SpatialQueryParams, request?: StationsRequestOptions): Promise<StationsClientResult<StationFeed>>;
  loadCurrentResult(uid: string, request?: StationsRequestOptions): Promise<StationsClientResult<StationCurrent>>;
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
  if (query.categories?.length) params.set('category', query.categories.join(','));
  if (query.launch) params.set('launch', query.launch);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  if (query.hours !== undefined) params.set('hours', String(query.hours));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function createStationsClient(options: StationsClientOptions): StationsHttpClient {
  const base = options.baseUrl.endsWith('/') ? options.baseUrl.slice(0, -1) : options.baseUrl;
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const defaultTimeoutMs = options.timeoutMs ?? 15_000;
  const validateTimeout = (timeoutMs: number): void => {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('timeoutMs must be a finite, non-negative number');
    }
  };
  validateTimeout(defaultTimeoutMs);

  const endpointUrl = (
    route: 'catalogue' | 'feed' | 'current' | 'live' | 'history',
    query?: SpatialQueryParams,
  ): string => `${base}/${route}${buildQueryString(query)}`;

  async function requestJson<T>(
    url: string,
    parse: (text: string) => T | null,
    request: StationsRequestOptions = {},
  ): Promise<StationsClientResult<T>> {
    const timeoutMs = request.timeoutMs ?? defaultTimeoutMs;
    validateTimeout(timeoutMs);
    const controller = new AbortController();
    let cancellation: StationsClientError | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = (kind: 'aborted' | 'timeout'): void => {
      if (controller.signal.aborted) return;
      cancellation = {
        kind,
        message: kind === 'timeout' ? 'Station request timed out' : 'Station request was cancelled',
      };
      controller.abort();
    };
    const onExternalAbort = (): void => abort('aborted');
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error('Station request cancelled'));
      controller.signal.addEventListener('abort', onAbort, { once: true });
    });
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (request.signal?.aborted) onExternalAbort();
    if (timeoutMs > 0) timeout = setTimeout(() => abort('timeout'), timeoutMs);

    const performRequest = async (): Promise<StationsClientResult<T>> => {
      if (controller.signal.aborted) throw new Error('Station request cancelled');
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        return {
          data: null,
          error: { kind: 'http', message: `Station request failed with HTTP ${response.status}`, status: response.status },
        };
      }
      const text = await response.text();
      try {
        const data = parse(text);
        return data === null
          ? { data: null, error: { kind: 'parse', message: 'Station response is not a valid document' } }
          : { data, error: null };
      } catch {
        return { data: null, error: { kind: 'parse', message: 'Station response is not a valid document' } };
      }
    };

    try {
      // Racing cancellation also bounds injected fetch implementations that ignore AbortSignal.
      return await Promise.race([performRequest(), cancelled]);
    } catch (error) {
      return {
        data: null,
        error: cancellation ?? {
          kind: 'network',
          message: error instanceof Error ? error.message : 'Station request failed',
        },
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      request.signal?.removeEventListener('abort', onExternalAbort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  }

  const loadCatalogueResult = (
    query?: SpatialQueryParams,
    request?: StationsRequestOptions,
  ): Promise<StationsClientResult<StationCatalogueDocument>> =>
    requestJson(endpointUrl('catalogue', query), parseStationCatalogueJson, request);
  const loadFeedResult = (
    query?: SpatialQueryParams,
    request?: StationsRequestOptions,
  ): Promise<StationsClientResult<StationFeed>> =>
    requestJson(endpointUrl('feed', query), parseStationFeedJson, request);
  const loadCurrentResult = (
    uid: string,
    request?: StationsRequestOptions,
  ): Promise<StationsClientResult<StationCurrent>> =>
    requestJson(`${base}/current?station=${encodeURIComponent(uid)}`, parseStationCurrentJson, request);

  return {
    endpointUrl,
    loadCatalogueResult,
    loadFeedResult,
    loadCurrentResult,
    async loadCatalogue(query, request) {
      return (await loadCatalogueResult(query, request)).data;
    },
    async loadCatalogueIndex(query, request) {
      const { data } = await loadCatalogueResult(query, request);
      return data === null ? null : createCatalogueIndex(data);
    },
    async loadFeed(query, request) {
      return (await loadFeedResult(query, request)).data;
    },
    async loadGeoJsonFeed(query, catalogueByUid, request) {
      const { data } = await loadFeedResult(query, request);
      return data === null ? null : feedToGeoJson(data, catalogueByUid);
    },
    async loadCurrent(uid, request) {
      return (await loadCurrentResult(uid, request)).data;
    },
  };
}

export interface ViewportStationSnapshot {
  /** Most recently requested viewport. */
  readonly bounds: Bounds | null;
  /** Viewport belonging to the retained feed and GeoJSON. */
  readonly dataBounds: Bounds | null;
  readonly stale: boolean;
  readonly error: StationsClientError | null;
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
  readonly categories?: readonly StationCategory[];
  readonly launch?: string;
  readonly limit?: number;
  readonly catalogueByUid?: ReadonlyMap<string, CatalogueStation>;
  readonly timeoutMs?: number;
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
    bounds: options.initialBounds ? [...options.initialBounds] : null,
    dataBounds: null,
    stale: false,
    error: null,
    feed: null,
    geojson: null,
    loading: false,
    updatedAtMs: null,
  };
  let generation = 0;
  let active: {
    bounds: Bounds;
    controller: AbortController;
    promise: Promise<ViewportStationSnapshot>;
  } | null = null;

  const emit = (next: ViewportStationSnapshot): ViewportStationSnapshot => {
    snapshot = next;
    for (const listener of listeners) listener();
    return snapshot;
  };

  function loadForBounds(requestedBounds: Bounds | null): Promise<ViewportStationSnapshot> {
    if (!requestedBounds) return Promise.resolve(snapshot);
    if (active && requestedBounds.every((coordinate, index) => coordinate === active?.bounds[index])) {
      return active.promise;
    }
    const bounds: Bounds = [...requestedBounds];
    const requestGeneration = ++generation;
    active?.controller.abort();
    const controller = new AbortController();
    const promise = Promise.resolve().then(async (): Promise<ViewportStationSnapshot> => {
      if (requestGeneration !== generation) return snapshot;
      const query = {
        bounds,
        countries: options.countries,
        vendors: options.vendors,
        categories: options.categories,
        launch: options.launch,
        limit: options.limit,
      };
      const request = { signal: controller.signal, timeoutMs: options.timeoutMs };
      let result: StationsClientResult<StationFeed>;
      try {
        if (options.client.loadFeedResult) {
          result = await options.client.loadFeedResult(query, request);
        } else {
          const data = await options.client.loadFeed(query, request);
          result = data === null
            ? { data: null, error: { kind: 'unknown', message: 'Station client returned no feed' } }
            : { data, error: null };
        }
      } catch (error) {
        result = {
          data: null,
          error: { kind: 'unknown', message: error instanceof Error ? error.message : 'Station client failed' },
        };
      }
      if (requestGeneration !== generation) return snapshot;
      active = null;
      if (result.error) {
        return emit({ ...snapshot, bounds, loading: false, stale: snapshot.feed !== null, error: result.error });
      }
      return emit({
        bounds,
        dataBounds: bounds,
        stale: false,
        error: null,
        feed: result.data,
        geojson: feedToGeoJson(result.data, options.catalogueByUid),
        loading: false,
        updatedAtMs: Date.now(),
      });
    });
    active = { bounds, controller, promise };
    emit({ ...snapshot, bounds, loading: true, stale: snapshot.feed !== null, error: null });
    return promise;
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
