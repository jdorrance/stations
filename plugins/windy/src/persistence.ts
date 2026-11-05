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

interface StoredReadings {
  readonly savedAtWallMs: number;
  readonly readings: readonly PersistedReading[];
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

  const readStore = async (): Promise<PersistedWindySnapshot | null> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const catalogueRequest = store.get('catalogue');
      const readingsRequest = store.get('readings');
      const legacyRequest = store.get('latest');
      let catalogue: StationCatalogueDocument | undefined;
      let readings: StoredReadings | undefined;
      let legacy: PersistedWindySnapshot | undefined;
      catalogueRequest.onsuccess = () => { catalogue = catalogueRequest.result; };
      readingsRequest.onsuccess = () => { readings = readingsRequest.result; };
      legacyRequest.onsuccess = () => { legacy = legacyRequest.result; };
      transaction.oncomplete = () => {
        if (catalogue && readings) {
          storedCatalogueAt = catalogue.generatedAt;
          resolve({
            version: 1,
            savedAtWallMs: readings.savedAtWallMs,
            catalogue,
            readings: readings.readings,
          });
          return;
        }
        resolve(legacy?.version === 1 && legacy.catalogue ? legacy : null);
      };
      transaction.onabort = () => reject(transaction.error ?? new Error('indexedDB transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('indexedDB request failed'));
    });
  };

  // A write waits for commit so a quota abort surfaces as a failure.
  const writeRecords = async (records: readonly (readonly [IDBValidKey, unknown])[]): Promise<void> => {
    const db = await open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      for (const [key, value] of records) store.put(value, key);
      store.delete('latest');
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error('indexedDB transaction aborted'));
      transaction.onerror = () => reject(transaction.error ?? new Error('indexedDB request failed'));
    });
  };

  let storedCatalogueAt: string | null = null;

  return {
    async load() {
      try {
        return await readStore();
      } catch {
        return fallback.load();
      }
    },
    async save(snapshot) {
      try {
        const writeCatalogue = storedCatalogueAt !== snapshot.catalogue.generatedAt;
        const records: (readonly [IDBValidKey, unknown])[] = [];
        if (writeCatalogue) records.push(['catalogue', snapshot.catalogue]);
        records.push(['readings', {
          savedAtWallMs: snapshot.savedAtWallMs,
          readings: snapshot.readings,
        } satisfies StoredReadings]);
        await writeRecords(records);
        if (writeCatalogue) storedCatalogueAt = snapshot.catalogue.generatedAt;
      } catch {
        await fallback.save(snapshot);
      }
    },
  };
}
