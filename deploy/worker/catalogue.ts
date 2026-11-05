import { CATALOGUE_SCHEMA_VERSION, type StationCatalogueDocument } from '@stations/contracts';
import { withDeadline } from './deadline.ts';

/**
 * Catalogue objects published to the R2 bucket by `scripts/export-deploy-catalogue.mjs`.
 *
 * - `hydrated`: the full catalogue with private adapter locators. Loaded into
 *   memory for the API handler and never sent to clients.
 * - `json` / `geojson`: sanitized public documents, streamed verbatim for the
 *   unfiltered `/catalogue` route so the Worker never materialises them.
 * - `live`: the lean wind-only catalogue, streamed pre-gzipped with
 *   `Content-Encoding: gzip`.
 */
export function catalogueKeys(prefix: string) {
  return {
    hydrated: `${prefix}.hydrated.json`,
    json: `${prefix}.public.json`,
    geojson: `${prefix}.public.geojson`,
    live: `${prefix}.live.json.gz`,
  } as const;
}

export type PublicCatalogueKind = 'json' | 'geojson' | 'live';

/** Content coding a stored object carries, so the Worker can echo it. */
function contentEncodingForKey(key: string): string | null {
  return key.endsWith('.gz') ? 'gzip' : null;
}

/** The subset of an R2 bucket this Worker uses; `R2Bucket` satisfies it structurally. */
export interface StoredObject {
  readonly httpEtag: string;
  readonly size: number;
}

export interface StoredObjectBody extends StoredObject {
  readonly body: ReadableStream<Uint8Array>;
  text(): Promise<string>;
}

export interface CatalogueObjectStore {
  head(key: string): Promise<StoredObject | null>;
  get(key: string, options?: { readonly onlyIf?: Headers }): Promise<StoredObject | StoredObjectBody | null>;
}

export interface PublicCatalogueObject {
  /** Quoted HTTP entity tag of the stored object. */
  readonly etag: string;
  readonly size: number;
  /** `null` when the caller's `If-None-Match` matched the stored object. */
  readonly body: ReadableStream<Uint8Array> | null;
  /** Stored content coding, `gzip` for pre-compressed objects. */
  readonly contentEncoding: string | null;
}

/** Reads a public catalogue object, honouring `If-None-Match` inside the store. */
export async function getPublicCatalogueObject(
  store: CatalogueObjectStore,
  key: string,
  ifNoneMatch: string | null,
): Promise<PublicCatalogueObject | null> {
  const object = await store.get(
    key,
    ifNoneMatch ? { onlyIf: new Headers({ 'If-None-Match': ifNoneMatch }) } : undefined,
  );
  if (!object) return null;
  return {
    etag: object.httpEtag,
    size: object.size,
    body: 'body' in object ? object.body : null,
    contentEncoding: contentEncodingForKey(key),
  };
}

export interface HydratedCatalogueLoaderOptions {
  readonly store: CatalogueObjectStore;
  readonly key: string;
  /** How long a loaded document is served before its etag is re-checked. Default: 5 minutes. */
  readonly revalidateMs?: number;
  /** Bound each store refresh, including the initial load. Default: 10 seconds. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

/** The request owns background work; a cached loader never retains its context. */
export interface BackgroundTasks {
  readonly waitUntil?: (task: Promise<unknown>) => void;
}

interface LoadedCatalogue {
  readonly doc: StationCatalogueDocument;
  readonly etag: string;
  readonly checkedAt: number;
}

/**
 * Loads the hydrated catalogue once per isolate and re-checks its etag every
 * `revalidateMs`, downloading again only when the object changed. Concurrent
 * callers share one in-flight load. After a successful load, a failing refresh
 * keeps serving the previous document; the first load propagates its error.
 */
export function createHydratedCatalogueLoader(
  options: HydratedCatalogueLoaderOptions,
): (context?: BackgroundTasks) => Promise<StationCatalogueDocument> {
  const revalidateMs = options.revalidateMs ?? 300_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(revalidateMs) || revalidateMs < 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Invalid catalogue cache timings');
  }
  const now = options.now ?? Date.now;
  let loaded: LoadedCatalogue | null = null;
  let pending: Promise<StationCatalogueDocument> | null = null;

  async function refresh(): Promise<LoadedCatalogue> {
    const previous = loaded;
    if (previous) {
      const head = await options.store.head(options.key);
      if (head && head.httpEtag === previous.etag) {
        return { ...previous, checkedAt: now() };
      }
    }
    const object = await options.store.get(options.key);
    if (!object || !('body' in object)) {
      throw new Error(`Hydrated catalogue object is missing: ${options.key}`);
    }
    const doc = parseHydratedCatalogue(await object.text());
    return { doc, etag: object.httpEtag, checkedAt: now() };
  }

  function begin(): Promise<StationCatalogueDocument> {
    const run = refresh().then(next => {
      loaded = next;
      return next.doc;
    }).catch((error: unknown) => {
      if (!loaded) throw error;
      loaded = { ...loaded, checkedAt: now() };
      return loaded.doc;
    });
    const tracked = run.finally(() => {
      if (pending === tracked) pending = null;
    });
    pending = tracked;
    return tracked;
  }

  return (context = {}) => {
    if (loaded && now() - loaded.checkedAt < revalidateMs) return Promise.resolve(loaded.doc);
    const current = pending ?? begin();
    if (context.waitUntil) {
      context.waitUntil(current);
      if (loaded) return Promise.resolve(loaded.doc);
    }
    return withDeadline(current, timeoutMs, 'Catalogue refresh timed out').catch((error: unknown) => {
      if (error instanceof Error && error.message === 'Catalogue refresh timed out') {
        if (pending === current) pending = null;
        if (loaded) return loaded.doc;
      }
      throw error;
    });
  };
}

/**
 * The artifact is produced from already-validated stations by the export
 * script, so only the document envelope is checked here; a full schema parse
 * of ~40k stations would cost CPU on every cold start.
 */
function parseHydratedCatalogue(text: string): StationCatalogueDocument {
  const parsed: unknown = JSON.parse(text);
  if (
    typeof parsed !== 'object' || parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== CATALOGUE_SCHEMA_VERSION ||
    typeof (parsed as { generatedAt?: unknown }).generatedAt !== 'string' ||
    !Array.isArray((parsed as { regions?: unknown }).regions) ||
    !Array.isArray((parsed as { stations?: unknown }).stations)
  ) {
    throw new Error('Hydrated catalogue object is not a station catalogue document');
  }
  return parsed as StationCatalogueDocument;
}
