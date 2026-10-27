import { CATALOGUE_SCHEMA_VERSION, type StationCatalogueDocument } from '@stations/contracts';

/**
 * Catalogue objects published to the R2 bucket by `scripts/export-deploy-catalogue.mjs`.
 *
 * - `hydrated`: the full catalogue with private adapter locators. Loaded into
 *   memory for the API handler and never sent to clients.
 * - `json` / `geojson`: sanitized public documents, streamed verbatim for the
 *   unfiltered `/catalogue` route so the Worker never materialises them.
 */
export function catalogueKeys(prefix: string) {
  return {
    hydrated: `${prefix}.hydrated.json`,
    json: `${prefix}.public.json`,
    geojson: `${prefix}.public.geojson`,
  } as const;
}

export type PublicCatalogueKind = 'json' | 'geojson';

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
  return { etag: object.httpEtag, size: object.size, body: 'body' in object ? object.body : null };
}

export interface HydratedCatalogueLoaderOptions {
  readonly store: CatalogueObjectStore;
  readonly key: string;
  /** How long a loaded document is served before its etag is re-checked. Default: 5 minutes. */
  readonly revalidateMs?: number;
  readonly now?: () => number;
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
): () => Promise<StationCatalogueDocument> {
  const revalidateMs = options.revalidateMs ?? 300_000;
  const now = options.now ?? Date.now;
  let loaded: LoadedCatalogue | null = null;
  let inflight: Promise<StationCatalogueDocument> | null = null;

  async function refresh(): Promise<StationCatalogueDocument> {
    if (loaded) {
      const head = await options.store.head(options.key);
      if (head && head.httpEtag === loaded.etag) {
        loaded = { ...loaded, checkedAt: now() };
        return loaded.doc;
      }
    }
    const object = await options.store.get(options.key);
    if (!object || !('body' in object)) {
      throw new Error(`Hydrated catalogue object is missing: ${options.key}`);
    }
    const doc = parseHydratedCatalogue(await object.text());
    loaded = { doc, etag: object.httpEtag, checkedAt: now() };
    return doc;
  }

  return () => {
    if (loaded && now() - loaded.checkedAt < revalidateMs) return Promise.resolve(loaded.doc);
    inflight ??= refresh()
      .catch((error: unknown) => {
        if (!loaded) throw error;
        loaded = { ...loaded, checkedAt: now() };
        return loaded.doc;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
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
