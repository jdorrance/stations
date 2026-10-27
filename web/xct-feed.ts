/** Nearby wind discovery, up to 90 candidates for 30 display slots. */
import type {
  StationsClientError,
  StationsClientResult,
  StationsHttpClient,
  StationsRequestOptions,
} from '@stations/client';
import {
  defaultCategoryForVendor,
  type Station,
  type StationCategory,
} from '@stations/contracts';
import { distanceKm, type Position } from '@stations/geography';

const DISPLAY_LIMIT = 30;
const CANDIDATE_LIMIT = 90;

export interface NearbyWindObservation {
  readonly station: Extract<Station, { status: 'ok' }>;
  readonly category: StationCategory;
  /** Vendor defaults apply only when the catalogue does not declare a category. */
  readonly categorySource: 'catalogue' | 'vendor-default';
  readonly servedAt: string;
  /** Monotonic performance.now() clock, never the device's calendar clock. */
  readonly receivedAtMs: number;
}

export interface NearbyWindResult {
  readonly observations: readonly NearbyWindObservation[];
  readonly candidateUids: readonly string[];
  readonly checkedUids: readonly string[];
  /** Missing, unavailable, or failed requests. Retained observations must remain marked unavailable. */
  readonly failedUids: readonly string[];
  readonly catalogueError: StationsClientError | null;
  readonly feedErrors: readonly StationsClientError[];
  /** The candidate budget was exhausted before finding 30 usable observations. */
  readonly coverageLimited: boolean;
  /** No discovery/request failures, unavailable candidates, or truncated search. */
  readonly complete: boolean;
}

export interface NearbyWindQuery {
  readonly position: Position;
  readonly radiusKm: number;
  readonly categories?: readonly StationCategory[];
  readonly maxAgeMs: number;
}

/** Age advances from the server timestamp even if the device clock changes. */
export function observationAgeMs(
  observation: NearbyWindObservation,
  nowMs = performance.now(),
): number {
  const serverAgeMs = Date.parse(observation.servedAt) - Date.parse(observation.station.reading.observedAt);
  if (!Number.isFinite(serverAgeMs)) return Infinity;
  return Math.max(0, serverAgeMs) + Math.max(0, nowMs - observation.receivedAtMs);
}

async function safeRequest<T>(request: () => Promise<StationsClientResult<T>>): Promise<StationsClientResult<T>> {
  try {
    return await request();
  } catch (error) {
    return {
      data: null,
      error: { kind: 'unknown', message: error instanceof Error ? error.message : 'Station request failed' },
    };
  }
}

/**
 * Catalogue metadata owns category; feeds own readings and server-time anchors.
 * Refills past unavailable/expired candidates in nearest-first batches. A positive
 * timeoutMs bounds the entire discovery cycle. Callers own retained observations.
 */
export async function loadNearbyWind(
  client: Pick<StationsHttpClient, 'loadCatalogueResult' | 'loadFeedResult'>,
  query: NearbyWindQuery,
  request: StationsRequestOptions = {},
): Promise<NearbyWindResult> {
  const deadline = request.timeoutMs !== undefined && request.timeoutMs > 0
    ? performance.now() + request.timeoutMs
    : Infinity;
  const catalogue = await safeRequest(() => client.loadCatalogueResult({
    near: { position: query.position, radiusKm: query.radiusKm },
    categories: query.categories,
    limit: CANDIDATE_LIMIT + 1,
  }, request));
  if (catalogue.error) {
    return {
      observations: [], candidateUids: [], checkedUids: [], failedUids: [],
      catalogueError: catalogue.error, feedErrors: [], coverageLimited: false, complete: false,
    };
  }

  const ordered = [...new Map(catalogue.data.stations.map(station => [station.uid, station])).values()]
    .sort((a, b) => distanceKm(query.position, a) - distanceKm(query.position, b));
  const candidates = ordered.slice(0, CANDIDATE_LIMIT);
  const observations: NearbyWindObservation[] = [];
  const checkedUids: string[] = [];
  const failedUids: string[] = [];
  const feedErrors: StationsClientError[] = [];
  const usableCount = (): number => observations.filter(observation =>
    observation.station.latitude !== null && observation.station.longitude !== null &&
    observationAgeMs(observation) <= query.maxAgeMs,
  ).length;

  for (let offset = 0; offset < candidates.length && usableCount() < DISPLAY_LIMIT; offset += DISPLAY_LIMIT) {
    const remainingMs = deadline - performance.now();
    if (request.signal?.aborted || remainingMs <= 0) {
      feedErrors.push({
        kind: request.signal?.aborted ? 'aborted' : 'timeout',
        message: request.signal?.aborted ? 'Station request was cancelled' : 'Nearby wind search timed out',
      });
      failedUids.push(...candidates.slice(offset).map(station => station.uid));
      break;
    }
    const batch = candidates.slice(offset, offset + DISPLAY_LIMIT);
    const ids = batch.map(station => station.uid);
    checkedUids.push(...ids);
    const result = await safeRequest(() => client.loadFeedResult({ ids, limit: DISPLAY_LIMIT }, {
      ...request,
      ...(Number.isFinite(remainingMs) ? { timeoutMs: remainingMs } : {}),
    }));
    const receivedAtMs = performance.now();
    if (result.error) {
      feedErrors.push(result.error);
      failedUids.push(...ids);
      continue;
    }
    const byUid = new Map(result.data.stations.map(station => [station.id, station]));
    for (const candidate of batch) {
      const station = byUid.get(candidate.uid);
      if (!station || station.status !== 'ok') {
        failedUids.push(candidate.uid);
        continue;
      }
      observations.push({
        station,
        category: candidate.category ?? defaultCategoryForVendor(candidate.vendor),
        categorySource: candidate.category == null ? 'vendor-default' : 'catalogue',
        servedAt: result.data.servedAt,
        receivedAtMs,
      });
    }
  }
  const coverageLimited = checkedUids.length === CANDIDATE_LIMIT &&
    ordered.length > CANDIDATE_LIMIT && usableCount() < DISPLAY_LIMIT;
  return {
    observations,
    candidateUids: candidates.map(station => station.uid),
    checkedUids,
    failedUids,
    catalogueError: null,
    feedErrors,
    coverageLimited,
    complete: failedUids.length === 0 && feedErrors.length === 0 && !coverageLimited,
  };
}
