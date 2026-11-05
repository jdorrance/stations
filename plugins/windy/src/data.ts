import { createCatalogueIndex, type CatalogueIndex, type StationsClientError, type StationsHttpClient } from '@stations/client';
import { stationSchema, type CatalogueStation, type Station, type StationCategory } from '@stations/contracts';
import { distanceKm, normalizeLongitude, type Bounds } from '@stations/geography';
import type { PersistedReading, PersistedWindySnapshot, WindySnapshotStore } from './persistence.ts';

export interface WindyBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface WindyDataEntry {
  readonly station: CatalogueStation;
  readonly status: 'catalogue' | 'loading' | 'ok' | 'unavailable' | 'refresh-failed';
  readonly refreshing: boolean;
  readonly observation: Station | null;
  readonly unavailable: Station | null;
  readonly error: StationsClientError | null;
  readonly servedAt: string | null;
  readonly receivedAtMs: number | null;
}

export interface WindyDataSnapshot {
  readonly entries: readonly WindyDataEntry[];
  readonly visibleTotal: number;
  readonly selectedCount: number;
  readonly capped: boolean;
  readonly catalogueStatus: 'idle' | 'loading' | 'ready' | 'error';
  readonly catalogueError: StationsClientError | null;
  readonly degraded: boolean;
}

export interface WindyDataOptions {
  readonly client: Pick<StationsHttpClient, 'loadCatalogueResult' | 'loadFeedResult'>;
  readonly onChange: (snapshot: WindyDataSnapshot) => void;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
  /** Nearest visible stations to load observations for. Default 100. */
  readonly maxStations?: number;
  /** Concurrent `/feed` batches. Default 4. */
  readonly maxConcurrentRequests?: number;
  /** Stations per `/feed` batch. Default 25. */
  readonly feedBatchSize?: number;
  /** Optional cross-session cache so the last catalogue and readings paint first. */
  readonly snapshotStore?: WindySnapshotStore;
  /** Catalogue profile to request, e.g. `live` for the lean wind-only document. */
  readonly catalogueProfile?: string;
}

/** Nearest visible stations selected for observation loading. Default 100. */
export const DEFAULT_MAX_STATIONS = 100;

/** Concurrent `/feed` batches the plugin runs. Default 4. */
export const DEFAULT_MAX_CONCURRENT_REQUESTS = 4;

/** Stations per `/feed` request; matches the server's `maxFeedStations`. */
export const DEFAULT_FEED_BATCH_SIZE = 25;

export function selectWindyStations(
  index: CatalogueIndex,
  bounds: WindyBounds,
  category?: StationCategory | null,
  maxStations: number = DEFAULT_MAX_STATIONS,
): { stations: CatalogueStation[]; visibleTotal: number } {
  const cap = Number.isFinite(maxStations) && maxStations >= 1 ? Math.floor(maxStations) : DEFAULT_MAX_STATIONS;
  const { west, east } = bounds;
  const south = Math.max(-90, bounds.south);
  const north = Math.min(90, bounds.north);
  if (![west, east, south, north].every(Number.isFinite) || south > north) return { stations: [], visibleTotal: 0 };
  const span = east - west;
  const world = Math.abs(span) >= 360;
  const width = world ? 360 : ((span % 360) + 360) % 360;
  const start = normalizeLongitude(west);
  const end = normalizeLongitude(west + width);
  const queries: Bounds[] = world ? [[-180, south, 180, north]] : start <= end
    ? [[start, south, end, north]]
    : [[start, south, 180, north], [-180, south, end, north]];
  const filter = category ? { categories: [category] } : undefined;
  const unique = new Map<string, CatalogueStation>();
  for (const query of queries) {
    for (const station of index.inBounds(query, filter)) if (!unique.has(station.uid)) unique.set(station.uid, station);
  }
  const center = { latitude: (south + north) / 2, longitude: normalizeLongitude(west + width / 2) };
  const stations: { station: CatalogueStation; distance: number }[] = [];
  const compare = (a: typeof stations[number], b: typeof stations[number]) => a.distance - b.distance || (a.station.uid < b.station.uid ? -1 : a.station.uid > b.station.uid ? 1 : 0);
  for (const station of unique.values()) {
    const item = { station, distance: distanceKm(center, station) };
    if (stations.length < cap) {
      let child = stations.length;
      stations.push(item);
      while (child > 0) {
        const parent = Math.floor((child - 1) / 2);
        if (compare(stations[parent], item) >= 0) break;
        stations[child] = stations[parent];
        child = parent;
      }
      stations[child] = item;
    } else if (compare(item, stations[0]) < 0) {
      let parent = 0;
      while (true) {
        const left = parent * 2 + 1;
        if (left >= stations.length) break;
        const right = left + 1;
        const child = right < stations.length && compare(stations[right], stations[left]) > 0 ? right : left;
        if (compare(stations[child], item) <= 0) break;
        stations[parent] = stations[child];
        parent = child;
      }
      stations[parent] = item;
    }
  }
  stations.sort(compare);
  return { stations: stations.slice(0, cap).map(item => item.station), visibleTotal: unique.size };
}

const OBSERVATION_REFRESH_MS = 120_000;

function retainedStation(value: Station | null): Station | null {
  if (!value) return null;
  const parsed = stationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type Retained = Omit<WindyDataEntry, 'station' | 'refreshing'> & { checkedAt: number; retryAt: number; failures: number };
type Timer = ReturnType<typeof setTimeout>;

export function createWindyData(options: WindyDataOptions) {
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? Math.random;
  const later = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimer = options.clearTimeout ?? globalThis.clearTimeout;
  const wallNow = () => Date.now();
  const maxStations = Number.isFinite(options.maxStations) && (options.maxStations ?? 0) >= 1
    ? Math.floor(options.maxStations!)
    : DEFAULT_MAX_STATIONS;
  const maxConcurrentRequests = Number.isFinite(options.maxConcurrentRequests) && (options.maxConcurrentRequests ?? 0) >= 1
    ? Math.floor(options.maxConcurrentRequests!)
    : DEFAULT_MAX_CONCURRENT_REQUESTS;
  const feedBatchSize = Number.isFinite(options.feedBatchSize) && (options.feedBatchSize ?? 0) >= 1
    ? Math.floor(options.feedBatchSize!)
    : DEFAULT_FEED_BATCH_SIZE;
  const snapshotStore = options.snapshotStore;
  const cache = new Map<string, Retained>();
  let effectiveConcurrency = maxConcurrentRequests;
  // Siblings of one wave are in flight together; a single failure must not be
  // undone by a sibling that succeeds before the next wave. Tracked per cycle.
  let waveFailures = 0;
  let hydrating = false;
  let lastSavedAtWallMs = 0;
  let index: CatalogueIndex | null = null;
  let catalogueDueAt = 0;
  let catalogueStatus: WindyDataSnapshot['catalogueStatus'] = 'idle';
  let catalogueError: StationsClientError | null = null;
  let catalogueController: AbortController | null = null;
  let catalogueFailures = 0;
  let catalogueTimer: Timer | undefined;
  let timer: Timer | undefined;
  let selectionTimer: Timer | undefined;
  let bounds: WindyBounds | null = null;
  let category: StationCategory | null = null;
  let selected: CatalogueStation[] = [];
  let visibleTotal = 0;
  let suspended = true;
  let destroyed = false;
  let generation = 0;
  const queue = new Map<string, readonly string[] | null>();
  const inFlight = new Map<string, AbortController>();
  const active = new Set<AbortController>();

  const errorFrom = (error: unknown): StationsClientError => ({ kind: 'unknown', message: error instanceof Error ? error.message : 'Station request failed' });
  const retryDelay = (count: number) => Math.min(300_000, 60_000 * 2 ** Math.min(count - 1, 3) * (1 + Math.max(0, Math.min(1, random())) * 0.2));
  const touch = (uid: string, value: Retained) => {
    cache.delete(uid);
    cache.set(uid, value);
    while (cache.size > 500) cache.delete(cache.keys().next().value!);
  };
  const snapshot = (): WindyDataSnapshot => ({
    entries: selected.map(station => {
      const value = cache.get(station.uid);
      const refreshing = queue.has(station.uid) || inFlight.has(station.uid);
      return {
        station,
        status: value?.status ?? (refreshing ? 'loading' : 'catalogue'),
        refreshing,
        observation: value?.observation ?? null,
        unavailable: value?.unavailable ?? null,
        error: value?.error ?? null,
        servedAt: value?.servedAt ?? null,
        receivedAtMs: value?.receivedAtMs ?? null,
      };
    }),
    visibleTotal,
    selectedCount: selected.length,
    capped: visibleTotal > selected.length,
    catalogueStatus,
    catalogueError,
    degraded: catalogueError !== null || selected.some(station => cache.get(station.uid)?.status === 'refresh-failed'),
  });
  const emit = () => { if (!destroyed) options.onChange(snapshot()); };
  const clearCycleTimer = () => { if (timer !== undefined) cancelTimer(timer); timer = undefined; };
  const clearCatalogueTimer = () => { if (catalogueTimer !== undefined) cancelTimer(catalogueTimer); catalogueTimer = undefined; };
  const clearSelectionTimer = () => { if (selectionTimer !== undefined) cancelTimer(selectionTimer); selectionTimer = undefined; };
  const invalidate = () => {
    generation += 1;
    for (const request of active) request.abort();
    queue.clear();
    inFlight.clear();
    clearCycleTimer();
  };
  const updateSelection = () => {
    const result = index && bounds ? selectWindyStations(index, bounds, category, maxStations) : { stations: [], visibleTotal: 0 };
    selected = result.stations;
    visibleTotal = result.visibleTotal;
    for (const station of selected) {
      const value = cache.get(station.uid);
      if (value) touch(station.uid, value);
    }
  };
  const dueAt = (value: Retained | undefined) => !value ? 0 : value.status === 'refresh-failed' ? value.retryAt : value.checkedAt + OBSERVATION_REFRESH_MS;

  /** Persists the catalogue and cached readings, throttled so a poll does not thrash IndexedDB. */
  function persist(force = false) {
    if (!snapshotStore || destroyed || !index) return;
    const wall = wallNow();
    if (!force && wall - lastSavedAtWallMs < 15_000) return;
    lastSavedAtWallMs = wall;
    const readings: PersistedReading[] = [];
    const base = now();
    for (const [uid, value] of cache) {
      if (value.status !== 'ok' && value.status !== 'unavailable' && value.status !== 'refresh-failed') continue;
      const receivedAtMs = value.receivedAtMs;
      if (receivedAtMs === null) continue;
      // A retained observation is painted as its last good reading, not as a
      // failure: replaying `refresh-failed` would flash a stale error alert on
      // a warm start and erase the backoff deadline.
      const retained = value.status !== 'refresh-failed';
      readings.push({
        uid,
        status: retained ? value.status : 'ok',
        observation: value.observation,
        unavailable: value.unavailable,
        servedAt: value.servedAt,
        receivedAtWallMs: wall - (base - receivedAtMs),
        checkedAtWallMs: wall - (base - value.checkedAt),
        retryAtWallMs: 0,
        failures: retained ? 0 : value.failures,
      });
    }
    const document: PersistedWindySnapshot = {
      version: 1,
      savedAtWallMs: wall,
      catalogue: index.document,
      readings,
    };
    void Promise.resolve().then(() => snapshotStore.save(document)).catch(() => {});
  }

  /**
   * Installs a persisted catalogue and readings so markers paint before the
   * network resolves, then revalidates the catalogue in the background.
   */
  async function hydrateFromStore() {
    if (!snapshotStore) {
      void loadCatalogue();
      return;
    }
    if (hydrating || index) return;
    hydrating = true;
    let persisted: PersistedWindySnapshot | null = null;
    try {
      persisted = (await snapshotStore.load()) ?? null;
    } catch {
      persisted = null;
    }
    hydrating = false;
    if (suspended || destroyed) return;
    if (!index && persisted && persisted.version === 1) {
      let nextIndex: CatalogueIndex | undefined;
      try {
        nextIndex = createCatalogueIndex(persisted.catalogue);
      } catch {
        nextIndex = undefined;
      }
      if (nextIndex) {
        index = nextIndex;
        catalogueStatus = 'ready';
        catalogueError = null;
        const wall = wallNow();
        const base = now();
        for (const reading of persisted.readings) {
          if (!index.byUidMap.has(reading.uid)) continue;
          const observation = retainedStation(reading.observation);
          const unavailable = retainedStation(reading.unavailable);
          if (reading.observation && !observation) continue;
          if (reading.unavailable && !unavailable) continue;
          cache.set(reading.uid, {
            status: reading.status === 'refresh-failed' ? 'ok' : reading.status,
            observation,
            unavailable,
            error: null,
            servedAt: reading.servedAt,
            receivedAtMs: base - Math.max(0, wall - reading.receivedAtWallMs),
            checkedAt: base - Math.max(0, wall - reading.checkedAtWallMs),
            retryAt: reading.retryAtWallMs ? base - Math.max(0, wall - reading.retryAtWallMs) : 0,
            failures: reading.failures,
          });
        }
        updateSelection();
        emit();
        reconcile();
      }
    }
    // Always revalidate: the persisted document may be a day old.
    void loadCatalogue();
  }

  const scheduleObservations = () => {
    clearCycleTimer();
    if (suspended || destroyed) return;
    let next = Infinity;
    for (const station of selected) {
      if (!queue.has(station.uid) && !inFlight.has(station.uid)) next = Math.min(next, dueAt(cache.get(station.uid)));
    }
    if (Number.isFinite(next)) timer = later(() => { timer = undefined; reconcile(); }, Math.max(0, next - now()));
  };

  function reconcile() {
    if (suspended || destroyed || !index) return;
    if (!queue.size && !inFlight.size) waveFailures = 0;
    const wanted = new Set(selected.map(station => station.uid));
    for (const [uid, group] of queue) if (!wanted.has(uid) || (!group && dueAt(cache.get(uid)) > now()) || inFlight.has(uid)) queue.delete(uid);
    for (const station of selected) {
      if (!queue.has(station.uid) && !inFlight.has(station.uid) && dueAt(cache.get(station.uid)) <= now()) queue.set(station.uid, null);
    }
    pump();
    scheduleObservations();
    emit();
  }

  function scheduleCatalogue(at: number) {
    clearCatalogueTimer();
    catalogueDueAt = at;
    if (!suspended && !destroyed) catalogueTimer = later(() => { catalogueTimer = undefined; void loadCatalogue(); }, Math.max(0, at - now()));
  }

  async function loadCatalogue() {
    if (suspended || destroyed || catalogueController) return;
    const request = new AbortController();
    catalogueController = request;
    if (!index) catalogueStatus = 'loading';
    emit();
    let result;
    try {
      result = await options.client.loadCatalogueResult(
        options.catalogueProfile ? { profile: options.catalogueProfile } : undefined,
        { signal: request.signal, timeoutMs: 15_000 },
      );
    } catch (error) {
      result = { data: null, error: errorFrom(error) };
    }
    if (catalogueController !== request || suspended || destroyed) return;
    catalogueController = null;
    let nextIndex: CatalogueIndex | undefined;
    let error = result.error;
    try {
      if (!error && result.data) nextIndex = createCatalogueIndex(result.data);
    } catch (caught) {
      error = errorFrom(caught);
    }
    if (!nextIndex) {
      catalogueError = error ?? errorFrom('Invalid catalogue');
      catalogueStatus = index ? 'ready' : 'error';
      catalogueFailures += 1;
      if (index) scheduleCatalogue(now() + retryDelay(catalogueFailures));
      emit();
      return;
    }
    if (index) {
      let replaced = false;
      for (const uid of new Set([...cache.keys(), ...inFlight.keys()])) {
        const oldStation = index.byUidMap.get(uid);
        const newStation = nextIndex.byUidMap.get(uid);
        if (!newStation || newStation.uid !== uid || !oldStation || oldStation.vendor !== newStation.vendor || oldStation.nativeId !== newStation.nativeId) {
          cache.delete(uid);
          queue.delete(uid);
          if (inFlight.has(uid)) replaced = true;
        }
      }
      if (replaced) invalidate();
    }
    index = nextIndex;
    catalogueStatus = 'ready';
    catalogueError = null;
    catalogueFailures = 0;
    scheduleCatalogue(now() + 86_400_000);
    clearSelectionTimer();
    updateSelection();
    reconcile();
    persist(true);
  }

  function pump() {
    while (!suspended && !destroyed && selectionTimer === undefined && active.size < maxConcurrentRequests && queue.size) {
      const ids: string[] = [];
      const wanted = new Set(selected.map(station => station.uid));
      let group: readonly string[] | null = null;
      for (const pending of queue.values()) if (pending) { group = pending; break; }
      // Split recovery keeps the physical cap while normal batches respect throttling.
      if (!group && active.size >= effectiveConcurrency) break;
      const candidates = group ?? queue.keys();
      for (const uid of candidates) {
        if (!queue.has(uid) || queue.get(uid) !== group) continue;
        queue.delete(uid);
        if (wanted.has(uid) && !inFlight.has(uid) && (group || dueAt(cache.get(uid)) <= now())) ids.push(uid);
        if (ids.length === feedBatchSize) break;
      }
      if (!ids.length) continue;
      const requestGeneration = generation;
      const request = new AbortController();
      active.add(request);
      for (const uid of ids) inFlight.set(uid, request);
      void (async () => {
        let result;
        try {
          result = await options.client.loadFeedResult({ ids, limit: feedBatchSize, history: false }, { signal: request.signal, timeoutMs: 15_000 });
        } catch (error) {
          result = { data: null, error: errorFrom(error) };
        }
        active.delete(request);
        if (requestGeneration === generation && !suspended && !destroyed) {
          const feed = result.data;
          const validFeed = feed && Array.isArray(feed.stations) && typeof feed.servedAt === 'string' && Number.isFinite(Date.parse(feed.servedAt));
          const error = result.error ?? (!validFeed ? { kind: 'parse' as const, message: 'Invalid station feed' } : null);
          // Rate limits and upstream 5xx shrink the wave. Recovery waits
          // for a whole wave with no sibling failure, so one 429 in a wave is not
          // undone by a sibling that answered before the next wave starts.
          if (error) {
            if (error.status === 429 || (error.status !== undefined && error.status >= 500)) {
              effectiveConcurrency = Math.max(1, effectiveConcurrency - 1);
              waveFailures += 1;
            }
          } else if (waveFailures === 0) {
            effectiveConcurrency = Math.min(maxConcurrentRequests, effectiveConcurrency + 1);
          }
          const receivedAtMs = now();
          const byId = new Map<string, Station | null>();
          if (validFeed) {
            for (const station of feed.stations) {
              if (!station || typeof station.id !== 'string') continue;
              const parsed = stationSchema.safeParse(station);
              byId.set(station.id, parsed.success ? parsed.data : null);
            }
          }
          for (const uid of ids) {
            const previous = cache.get(uid);
            const station = byId.get(uid);
            const invalidStation = byId.has(uid) && !station;
            const failure = error ?? (invalidStation ? { kind: 'parse' as const, message: 'Invalid station result' } : null);
            const status = failure ? 'refresh-failed' : !station || station.status === 'unavailable' ? 'unavailable' : 'ok';
            const failures = failure ? group ? Math.max(1, previous?.failures ?? 0) : (previous?.failures ?? 0) + 1 : 0;
            touch(uid, {
              status,
              observation: status === 'ok' ? station! : previous?.observation ?? null,
              unavailable: station?.status === 'unavailable' ? station : failure ? previous?.unavailable ?? null : null,
              error: failure,
              servedAt: status === 'ok' ? feed!.servedAt : previous?.servedAt ?? null,
              receivedAtMs: status === 'ok' ? receivedAtMs : previous?.receivedAtMs ?? null,
              checkedAt: receivedAtMs,
              retryAt: failure ? receivedAtMs + retryDelay(failures) : 0,
              failures,
            });
            if (inFlight.get(uid) === request) inFlight.delete(uid);
          }
          if (!group && ids.length > 1 && result.error?.kind === 'timeout') {
            const wanted = selectionTimer === undefined ? new Set(selected.map(station => station.uid)) : null;
            const middle = Math.ceil(ids.length / 2);
            for (const half of [ids.slice(0, middle), ids.slice(middle)]) {
              for (const uid of half) if ((!wanted || wanted.has(uid)) && !inFlight.has(uid) && !queue.has(uid)) queue.set(uid, half);
            }
          }
        }
        persist();
        reconcile();
      })();
    }
  }

  return {
    getSnapshot: snapshot,
    setViewport(next: WindyBounds, nextCategory: StationCategory | null = null) {
      if (destroyed) return;
      if (bounds && bounds.west === next.west && bounds.south === next.south && bounds.east === next.east && bounds.north === next.north && category === nextCategory) return;
      bounds = { ...next };
      category = nextCategory;
      if (!suspended && index && selectionTimer === undefined) selectionTimer = later(() => {
        selectionTimer = undefined;
        updateSelection();
        reconcile();
      }, 300);
    },
    refresh() {
      if (suspended || destroyed) return;
      if (!index) { void hydrateFromStore(); return; }
      const at = now();
      for (const station of selected) {
        if (inFlight.has(station.uid)) continue;
        const value = cache.get(station.uid);
        if (!value) continue;
        touch(station.uid, { ...value, checkedAt: at - OBSERVATION_REFRESH_MS, retryAt: at });
      }
      if (catalogueError) {
        catalogueFailures = 0;
        void loadCatalogue();
      }
      reconcile();
    },
    suspend() {
      if (suspended || destroyed) return;
      persist(true);
      suspended = true;
      invalidate();
      clearSelectionTimer();
      clearCatalogueTimer();
      catalogueController?.abort();
      catalogueController = null;
      if (!index && catalogueStatus === 'loading') catalogueStatus = 'idle';
      emit();
    },
    resume() {
      if (!suspended || destroyed) return;
      suspended = false;
      if (!index) { void hydrateFromStore(); return; }
      if (now() >= catalogueDueAt) void loadCatalogue();
      else scheduleCatalogue(catalogueDueAt);
      updateSelection();
      reconcile();
    },
    destroy() {
      if (destroyed) return;
      suspended = true;
      invalidate();
      clearSelectionTimer();
      clearCatalogueTimer();
      catalogueController?.abort();
      catalogueController = null;
      destroyed = true;
      cache.clear();
      selected = [];
    },
  };
}
