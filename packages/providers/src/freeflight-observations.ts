import { observationTimeMs } from './observation-values.ts';
import {
  type FeedCache,
  type ResolvedEnvironment,
  type ServerEnvironment,
} from '@azohra/meteo.station/server';
import {
  resolveEnvironment,
} from './server.ts';

/** Preserve source time; fetch time must never make an old sensor reading fresh. */
export function observationTimeIso(value: unknown): string | null {
  const milliseconds = observationTimeMs(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

/** Separate authorization scopes without storing a credential in cache keys. */
export async function credentialCacheScope(secret?: string): Promise<string> {
  if (!secret) return 'public';
  return `authenticated-${await cacheIdentity(secret)}`;
}

/** Identify a URL or credential without putting its potentially sensitive text in a key. */
export async function cacheIdentity(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

const credentialCaches = new WeakMap<FeedCache, Map<string, FeedCache>>();

/** Scope adapters whose own cache keys omit their authorization context. */
export async function credentialScopedEnvironment(
  environment: ServerEnvironment | undefined,
  credentials: readonly string[],
): Promise<ResolvedEnvironment> {
  const resolved = resolveEnvironment(environment);
  const scope = await credentialCacheScope(JSON.stringify(credentials));
  let scopes = credentialCaches.get(resolved.cache);
  if (!scopes) {
    scopes = new Map();
    credentialCaches.set(resolved.cache, scopes);
  }
  let cache = scopes.get(scope);
  if (!cache) {
    const underlying = resolved.cache;
    cache = {
      get: key => underlying.get(`${scope}/${key}`),
      put: (key, value, ttlSeconds) => underlying.put(`${scope}/${key}`, value, ttlSeconds),
    };
    scopes.set(scope, cache);
  }
  return { ...resolved, cache };
}
