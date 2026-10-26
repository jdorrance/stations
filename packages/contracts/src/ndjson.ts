import { parseCatalogueStation, type CatalogueStation } from './catalogue.ts';
import { toPublicCatalogueStation } from './public-catalogue.ts';

/**
 * Serializes a list of `CatalogueStation` items to public newline-delimited JSON (NDJSON),
 * stripping any private server locator credentials.
 */
export function serializeCatalogueNdjson(stations: readonly CatalogueStation[]): string {
  if (stations.length === 0) return '';
  return `${stations.map(station => JSON.stringify(toPublicCatalogueStation(station))).join('\n')}\n`;
}

/**
 * Parses newline-delimited JSON (NDJSON) into validated `CatalogueStation` records.
 * Blank lines and invalid rows are skipped safely.
 */
export function parseCatalogueNdjson(ndjson: string): CatalogueStation[] {
  const stations: CatalogueStation[] = [];
  const lines = ndjson.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parseCatalogueStation(JSON.parse(trimmed));
      if (parsed) stations.push(parsed);
    } catch {
      // Ignore malformed line
    }
  }
  return stations;
}
