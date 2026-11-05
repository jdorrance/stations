import type { Station, StationCatalogueDocument } from '@stations/contracts';

/**
 * Cross-session cache of the last catalogue and readings, so a warm visit can
 * paint station markers before any network request resolves. The store is a
 * plain interface: IndexedDB in the browser, in-memory in tests. Timestamps are
 * wall-clock so they survive a reload; `data.ts` re-bases them onto the
 * session's monotonic clock on load.
 */
export type PersistedReadingStatus = 'ok' | 'unavailable' | 'refresh-failed';

export interface PersistedReading {
  readonly uid: string;
  readonly status: PersistedReadingStatus;
  readonly observation: Station | null;
  readonly unavailable: Station | null;
  readonly servedAt: string | null;
  /** Wall-clock ms when the observation was received. */
  readonly receivedAtWallMs: number;
  readonly checkedAtWallMs: number;
  /** Always `0`: failures are replayed as their retained reading, never as a pending retry. */
  readonly retryAtWallMs: number;
  readonly failures: number;
}

export interface PersistedWindySnapshot {
  readonly version: 1;
  readonly savedAtWallMs: number;
  readonly catalogue: StationCatalogueDocument;
  readonly readings: readonly PersistedReading[];
}

export interface WindySnapshotStore {
  load(): Promise<PersistedWindySnapshot | null> | PersistedWindySnapshot | null;
  save(snapshot: PersistedWindySnapshot): Promise<void> | void;
}

/** Deterministic store for tests and hosts without IndexedDB. */
export function createMemorySnapshotStore(
  initial: PersistedWindySnapshot | null = null,
): WindySnapshotStore {
  let value = initial;
  return {
    load: () => value,
    save: snapshot => {
      value = snapshot;
    },
  };
}

export interface IndexedDbSnapshotStoreOptions {
  /** Database name. Default `stations-windy`. */
  readonly databaseName?: string;
  /** Object store name. Default `snapshot`. */
  readonly storeName?: string;
}

/**
 * IndexedDB-backed store. Falls back to an in-memory store when IndexedDB is
 * unavailable or the database cannot be opened, so callers never handle errors.
 */
export function createIndexedDbSnapshotStore(
  options: IndexedDbSnapshotStoreOptions = {},
): WindySnapshotStore {
  const databaseName = options.databaseName ?? 'stations-windy';
  const storeName = options.storeName ?? 'snapshot';
  const fallback = createMemorySnapshotStore();
  if (typeof indexedDB === 'undefined') return fallback;

  let database: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('indexedDB open failed'));
    }).catch(error => {
      database = null;
      throw error;
    });
    return database;
  };

  const withStore = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = run(transaction.objectStore(storeName));
      let result: T | undefined;
      request.onsuccess = () => {
        result = request.result;
        // A read is durable on the request; a write must wait for the commit so
        // a quota abort surfaces as a failure instead of a phantom success.
        if (mode === 'readonly') resolve(result as T);
      };
      request.onerror = () => reject(request.error ?? new Error('indexedDB request failed'));
      transaction.oncomplete = () => resolve(result as T);
      transaction.onabort = () => reject(transaction.error ?? new Error('indexedDB transaction aborted'));
    });
  };

  return {
    async load() {
      try {
        const value = await withStore<PersistedWindySnapshot | undefined>('readonly', store => store.get('latest'));
        return value ?? null;
      } catch {
        return fallback.load();
      }
    },
    async save(snapshot) {
      try {
        await withStore('readwrite', store => store.put(snapshot, 'latest'));
      } catch {
        await fallback.save(snapshot);
      }
    },
  };
}
