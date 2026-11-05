import { stationSchema, type CatalogueStation, type Station } from '@stations/contracts';
import type { ServerEnvironment } from '@azohra/meteo.station/server';
import { createRequestEnvironment } from './server.ts';

/** Cache age is measured since a successful load, independently from observation freshness. */
export interface StationCachePolicy {
  readonly freshSeconds?: number;
  readonly maxAgeSeconds?: number;
  readonly sonicFreshSeconds?: number;
  readonly sonicMaxAgeSeconds?: number;
  readonly cacheTimeoutMs?: number;
}

/** The host owns background work; Workers bind this to the current request's ctx.waitUntil. */
export interface StationRequestContext {
  readonly waitUntil?: (task: Promise<unknown>) => void;
}

interface Snapshot {
  readonly station: Station;
  readonly freshUntil: number;
  readonly staleUntil: number;
}

export interface StationCacheResult {
  readonly station: Station;
  readonly state: 'hit' | 'stale' | 'miss';
  readonly freshUntil: number;
}

/** Last-good station snapshots, bounded L1 storage and soft/hard expiry. No shared request I/O. */
export function createStationCache(environment?: ServerEnvironment, policy: StationCachePolicy = {}) {
  const fresh = seconds(policy.freshSeconds ?? 30);
  const maximum = seconds(policy.maxAgeSeconds ?? 300);
  const sonicFresh = seconds(policy.sonicFreshSeconds ?? Math.min(15, fresh));
  const sonicMaximum = seconds(policy.sonicMaxAgeSeconds ?? Math.min(120, maximum));
  if (fresh > maximum || sonicFresh > sonicMaximum) {
    throw new RangeError('Cache freshSeconds must not exceed maxAgeSeconds');
  }
  const cacheTimeoutMs = policy.cacheTimeoutMs ?? 100;
  const resolved = createRequestEnvironment(environment, cacheTimeoutMs);
  const now = () => resolved.now().getTime();
  const entries = new Map<string, { snapshot: Snapshot; bytes: number }>();
  const refreshing = new Map<string, number>();
  let bytes = 0;

  function remember(key: string, snapshot: Snapshot, size: number) {
    bytes -= entries.get(key)?.bytes ?? 0;
    entries.delete(key);
    if (size <= 2_097_152) {
      entries.set(key, { snapshot, bytes: size });
      bytes += size;
    }
    while (entries.size > 256 || bytes > 2_097_152) {
      const oldest = entries.keys().next().value!;
      bytes -= entries.get(oldest)!.bytes;
      entries.delete(oldest);
    }
  }

  async function cached(key: string): Promise<Snapshot | null> {
    const local = entries.get(key)?.snapshot;
    if (local && local.staleUntil > now()) return local;
    const text = await resolved.cache.get(key);
    if (!text) return null;
    try {
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object') return null;
      const record = value as Snapshot;
      if (!Number.isFinite(record.freshUntil) || !Number.isFinite(record.staleUntil)
        || record.freshUntil > record.staleUntil || record.staleUntil <= now()) return null;
      const station = stationSchema.safeParse(record.station);
      if (!station.success || station.data.status !== 'ok') return null;
      const snapshot = { ...record, station: station.data };
      remember(key, snapshot, text.length * 2);
      return snapshot;
    } catch {
      return null;
    }
  }

  async function read(
    key: string,
    meta: CatalogueStation,
    load: () => Promise<Station>,
    context: StationRequestContext = {},
  ): Promise<StationCacheResult> {
    const sonic = meta.recommendedPollSeconds <= 30;
    const freshSeconds = sonic ? sonicFresh : fresh;
    const maxAgeSeconds = sonic ? sonicMaximum : maximum;
    const previous = maxAgeSeconds > 0 ? await cached(key) : null;
    if (previous && previous.freshUntil > now()) {
      return { station: previous.station, state: 'hit', freshUntil: previous.freshUntil };
    }
    const retained = (): StationCacheResult | null => previous && previous.staleUntil > now()
      ? { station: previous.station, state: 'stale', freshUntil: previous.freshUntil }
      : null;

    async function refresh(): Promise<StationCacheResult> {
      let station: Station;
      try {
        station = await load();
      } catch (error) {
        const fallback = retained();
        if (fallback) return fallback;
        throw error;
      }
      if (station.status !== 'ok') return retained() ?? { station, state: 'miss', freshUntil: 0 };
      const at = now();
      const snapshot = { station, freshUntil: at + freshSeconds * 1000, staleUntil: at + maxAgeSeconds * 1000 };
      if (maxAgeSeconds > 0) {
        const text = JSON.stringify(snapshot);
        remember(key, snapshot, text.length * 2);
        const write = resolved.cache.put(key, text, maxAgeSeconds);
        if (context.waitUntil) context.waitUntil(write);
        else await write;
      }
      return { station, state: 'miss', freshUntil: maxAgeSeconds > 0 ? snapshot.freshUntil : 0 };
    }

    const stale = retained();
    if (stale && context.waitUntil) {
      // Keep a bounded lease, never another request's promise. Cancelled hosts cannot strand it.
      for (const [id, until] of refreshing) if (until <= now()) refreshing.delete(id);
      if (!refreshing.has(key) && refreshing.size < 256) {
        const lease = now() + 30_000;
        refreshing.set(key, lease);
        const finish = (failed: boolean) => {
          if (refreshing.get(key) !== lease) return;
          if (failed) refreshing.set(key, now() + Math.max(1, freshSeconds) * 1000);
          else refreshing.delete(key);
        };
        const task = refresh().then(result => finish(result.state === 'stale'), () => finish(true));
        context.waitUntil(task);
      }
      return stale;
    }
    return refresh();
  }

  return { read, cacheTimeoutMs };
}

function seconds(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Cache seconds must be non-negative');
  return value;
}
