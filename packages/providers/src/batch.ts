import { fetchUpstreamText, resolveEnvironment } from './server.ts';
import type { ServerEnvironment } from '@azohra/meteo.station/server';
import type { CatalogueStation } from '@stations/contracts';
import { resolveSynopticToken } from './cwop.ts';
import { credentialCacheScope } from './freeflight-observations.ts';
import { isRecord } from './observation-values.ts';
import type { ProviderCredentials } from './types.ts';

/** Warm one vendor group; unrelated provider loads can proceed independently. */
export async function prewarmBatchFeedCache(
  stations: readonly CatalogueStation[],
  credentials: ProviderCredentials | undefined,
  rawEnv: ServerEnvironment | undefined,
): Promise<void> {
  if (stations.length < 2) return;
  const environment = resolveEnvironment(rawEnv);

  const awcStations = stations.filter(s => s.vendor === 'awc');
  const synopticStations = stations.filter(s => s.vendor === 'synoptic');
  const tasks: Promise<void>[] = [];

  if (awcStations.length >= 2) {
    tasks.push(
      (async () => {
        const missingIds: string[] = [];
        await Promise.all(awcStations.map(async s => {
          if (!await environment.cache.get(`awc/metar/${s.nativeId}`)) missingIds.push(s.nativeId);
        }));
        missingIds.sort();
        if (missingIds.length < 2) return;
        try {
          const url = new URL('https://aviationweather.gov/api/data/metar');
          url.searchParams.set('ids', missingIds.join(','));
          url.searchParams.set('format', 'json');
          url.searchParams.set('hours', '3');
          const text = await fetchUpstreamText(environment, {
            url,
            cacheKey: `awc/metar/batch/${missingIds.join(',')}`,
            cacheTtlSeconds: 60,
            subject: `AWC batch METAR (${missingIds.length} stations)`,
            timeoutMs: 8_000,
          });
          const parsed: unknown = JSON.parse(text);
          if (!Array.isArray(parsed)) return;
          const byIcao = new Map<string, unknown[]>();
          for (const row of parsed) {
            if (!isRecord(row) || typeof row.icaoId !== 'string') continue;
            const id = row.icaoId.trim().toUpperCase();
            let list = byIcao.get(id);
            if (!list) {
              list = [];
              byIcao.set(id, list);
            }
            list.push(row);
          }
          await Promise.all(
            [...byIcao.entries()].map(([id, rows]) =>
              environment.cache.put(`awc/metar/${id}`, JSON.stringify(rows), 60),
            ),
          );
        } catch {
          // Fall back to individual station fetches on error
        }
      })(),
    );
  }

  const rawSynopticCred =
    credentials?.synopticToken?.trim() || credentials?.synopticApiKey?.trim();
  if (synopticStations.length >= 2 && rawSynopticCred) {
    tasks.push(
      (async () => {
        try {
          const scope = await credentialCacheScope(rawSynopticCred);
          const missingIds: string[] = [];
          await Promise.all(synopticStations.map(async s => {
            if (!await environment.cache.get(`synoptic/latest/${scope}/${s.nativeId}`)) missingIds.push(s.nativeId);
          }));
          missingIds.sort();
          if (missingIds.length < 2) return;
          const token = await resolveSynopticToken(rawSynopticCred, environment);
          const url = new URL('https://api.synopticdata.com/v2/stations/latest');
          url.searchParams.set('stid', missingIds.join(','));
          url.searchParams.set('units', 'metric');
          url.searchParams.set('token', token);
          const text = await fetchUpstreamText(environment, {
            url,
            cacheKey: `synoptic/latest/batch/${scope}/${missingIds.join(',')}`,
            cacheTtlSeconds: 60,
            subject: `Synoptic batch latest (${missingIds.length} stations)`,
            timeoutMs: 8_000,
          });
          const parsed: unknown = JSON.parse(text);
          const rows: unknown[] =
            isRecord(parsed) && Array.isArray(parsed.STATION) ? parsed.STATION : [];
          await Promise.all(
            rows.map(async (row: unknown) => {
              if (!isRecord(row) || typeof row.STID !== 'string') return;
              const stid = row.STID.trim().toUpperCase();
              await environment.cache.put(
                `synoptic/latest/${scope}/${stid}`,
                JSON.stringify({ STATION: [row] }),
                60,
              );
            }),
          );
        } catch {
          // Fall back to individual station fetches on error
        }
      })(),
    );
  }

  if (tasks.length > 0) {
    await Promise.all(tasks);
  }
}
