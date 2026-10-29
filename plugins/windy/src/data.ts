import { createCatalogueIndex, type CatalogueIndex, type StationsClientError, type StationsHttpClient } from '@stations/client';
import { stationSchema, type CatalogueStation, type Station, type StationCategory } from '@stations/contracts';
import { distanceKm, normalizeLongitude, type Bounds } from '@stations/geography';

export interface WindyBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export interface WindyDataEntry {
  readonly station: CatalogueStation;
  readonly status: 'catalogue' | 'loading' | 'ok' | 'unavailable' | 'refresh-failed';
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
}

export function selectWindyStations(index: CatalogueIndex, bounds: WindyBounds, category?: StationCategory | null): { stations: CatalogueStation[]; visibleTotal: number } {
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
  const stations = [...unique.values()].map(station => ({ station, distance: distanceKm(center, station) }));
  stations.sort((a, b) => a.distance - b.distance || (a.station.uid < b.station.uid ? -1 : a.station.uid > b.station.uid ? 1 : 0));
  return { stations: stations.slice(0, 100).map(item => item.station), visibleTotal: stations.length };
}

type Retained = Omit<WindyDataEntry, 'station'> & { checkedAt: number; retryAt: number };
type Timer = ReturnType<typeof setTimeout>;

export function createWindyData(options: WindyDataOptions) {
  const now = options.now ?? (() => performance.now());
  const random = options.random ?? Math.random;
  const later = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimer = options.clearTimeout ?? globalThis.clearTimeout;
  const cache = new Map<string, Retained>();
  let index: CatalogueIndex | null = null;
  let catalogueDueAt = 0;
  let catalogueStatus: WindyDataSnapshot['catalogueStatus'] = 'idle';
  let catalogueError: StationsClientError | null = null;
  let catalogueController: AbortController | null = null;
  let catalogueFailures = 0;
  let catalogueTimer: Timer | undefined;
  let timer: Timer | undefined;
  let bounds: WindyBounds | null = null;
  let category: StationCategory | null = null;
  let selected: CatalogueStation[] = [];
  let visibleTotal = 0;
  let suspended = true;
  let destroyed = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let queue: string[][] = [];
  let pending = new Set<string>();
  let running = 0;
  let cycleRemaining = 0;
  let failures = 0;
  let cycleFailed = false;
  let cycleActive = false;

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
      return {
        station,
        status: pending.has(station.uid) ? 'loading' : value?.status ?? 'catalogue',
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
  const invalidate = () => {
    generation += 1;
    controller?.abort();
    controller = null;
    queue = [];
    pending = new Set();
    cycleRemaining = 0;
    cycleActive = false;
    clearCycleTimer();
  };
  const updateSelection = () => {
    const result = index && bounds ? selectWindyStations(index, bounds, category) : { stations: [], visibleTotal: 0 };
    selected = result.stations;
    visibleTotal = result.visibleTotal;
    for (const station of selected) {
      const value = cache.get(station.uid);
      if (value) touch(station.uid, value);
    }
  };

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
      result = await options.client.loadCatalogueResult(undefined, { signal: request.signal, timeoutMs: 15_000 });
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
    index = nextIndex;
    catalogueStatus = 'ready';
    catalogueError = null;
    catalogueFailures = 0;
    scheduleCatalogue(now() + 86_400_000);
    invalidate();
    updateSelection();
    emit();
    startCycle();
  }

  function finishCycle() {
    if (!cycleActive || cycleRemaining !== 0) return;
    cycleActive = false;
    controller = null;
    if (cycleFailed) failures += 1;
    else if (!selected.some(station => cache.get(station.uid)?.status === 'refresh-failed')) failures = 0;
    const settledAt = now();
    const wait = Math.max(60_000, selected.length ? selected.reduce((delay, station) => {
      const value = cache.get(station.uid);
      const due = value?.status === 'refresh-failed' ? value.retryAt - settledAt : 60_000;
      return Math.min(delay, due);
    }, Infinity) : 60_000);
    clearCycleTimer();
    if (!suspended && !destroyed) timer = later(() => { timer = undefined; startCycle(); }, wait);
    emit();
  }

  function pump() {
    while (!suspended && !destroyed && running < 2 && queue.length && controller) {
      const ids = queue.shift()!;
      const requestGeneration = generation;
      const signal = controller.signal;
      running += 1;
      void (async () => {
        let result;
        try {
          result = await options.client.loadFeedResult({ ids, limit: 25, history: false }, { signal, timeoutMs: 15_000 });
        } catch (error) {
          result = { data: null, error: errorFrom(error) };
        }
        running -= 1;
        if (requestGeneration === generation && !suspended && !destroyed) {
          const feed = result.data;
          const validFeed = feed && Array.isArray(feed.stations) && typeof feed.servedAt === 'string' && Number.isFinite(Date.parse(feed.servedAt));
          const error = result.error ?? (!validFeed ? { kind: 'parse' as const, message: 'Invalid station feed' } : null);
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
            if (failure) cycleFailed = true;
            const status = failure ? 'refresh-failed' : !station || station.status === 'unavailable' ? 'unavailable' : 'ok';
            touch(uid, {
              status,
              observation: status === 'ok' ? station! : previous?.observation ?? null,
              unavailable: station?.status === 'unavailable' ? station : failure ? previous?.unavailable ?? null : null,
              error: failure,
              servedAt: status === 'ok' ? feed!.servedAt : previous?.servedAt ?? null,
              receivedAtMs: status === 'ok' ? receivedAtMs : previous?.receivedAtMs ?? null,
              checkedAt: receivedAtMs,
              retryAt: failure ? receivedAtMs + retryDelay(failures + 1) : 0,
            });
            pending.delete(uid);
          }
          cycleRemaining -= 1;
          emit();
          finishCycle();
        }
        pump();
      })();
    }
  }

  function startCycle() {
    if (suspended || destroyed || !index || !bounds || cycleActive) return;
    clearCycleTimer();
    const time = now();
    const ids = selected.filter(station => {
      const value = cache.get(station.uid);
      if (!value) return true;
      if (value.status === 'refresh-failed') return time >= value.retryAt;
      return time - value.checkedAt >= 60_000;
    }).map(station => station.uid);
    queue = [];
    for (let i = 0; i < ids.length; i += 25) queue.push(ids.slice(i, i + 25));
    pending = new Set(ids);
    controller = new AbortController();
    cycleRemaining = queue.length;
    cycleFailed = false;
    cycleActive = true;
    emit();
    if (!cycleRemaining) {
      cycleActive = false;
      controller = null;
      const next = selected.reduce((delay, station) => {
        const value = cache.get(station.uid);
        if (!value) return delay;
        const due = value.status === 'refresh-failed' ? value.retryAt : value.checkedAt + 60_000;
        return Math.min(delay, Math.max(1, due - time));
      }, 60_000);
      timer = later(() => { timer = undefined; startCycle(); }, next);
      return;
    }
    pump();
  }

  return {
    getSnapshot: snapshot,
    setViewport(next: WindyBounds, nextCategory: StationCategory | null = null) {
      if (destroyed) return;
      bounds = { ...next };
      category = nextCategory;
      invalidate();
      updateSelection();
      emit();
      if (!suspended && index) timer = later(() => { timer = undefined; startCycle(); }, 300);
    },
    refresh() {
      if (suspended || destroyed) return;
      if (!index) { void loadCatalogue(); return; }
      if (cycleActive) return;
      startCycle();
    },
    suspend() {
      if (suspended || destroyed) return;
      suspended = true;
      invalidate();
      clearCatalogueTimer();
      catalogueController?.abort();
      catalogueController = null;
      if (!index && catalogueStatus === 'loading') catalogueStatus = 'idle';
      emit();
    },
    resume() {
      if (!suspended || destroyed) return;
      suspended = false;
      if (!index) { void loadCatalogue(); return; }
      if (now() >= catalogueDueAt) void loadCatalogue();
      else scheduleCatalogue(catalogueDueAt);
      updateSelection();
      emit();
      startCycle();
    },
    destroy() {
      if (destroyed) return;
      suspended = true;
      invalidate();
      clearCatalogueTimer();
      catalogueController?.abort();
      catalogueController = null;
      destroyed = true;
      cache.clear();
      selected = [];
    },
  };
}
