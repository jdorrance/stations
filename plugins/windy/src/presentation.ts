import { defaultCategoryForVendor, pilotFreshness } from '@stations/contracts';
import type { WindyDataEntry } from './data.ts';

export interface WindMetric {
  convertValue(value: number): string;
}

export function safeSourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function windDirectionRotation(direction: number | null): number | null {
  return direction === null || !Number.isFinite(direction) ? null : ((direction % 360) + 360) % 360;
}

export function presentStation(entry: WindyDataEntry, metric: WindMetric, nowMs: number) {
  const observation = entry.observation?.status === 'ok' ? entry.observation : null;
  const reading = observation?.reading ?? null;
  const ageMs = reading && entry.servedAt !== null && entry.receivedAtMs !== null
    ? Math.max(0, Date.parse(entry.servedAt) - Date.parse(reading.observedAt)) + Math.max(0, nowMs - entry.receivedAtMs)
    : null;
  const age = ageMs !== null && Number.isFinite(ageMs) ? Math.floor(ageMs / 60_000) : null;
  const freshness = reading && observation && entry.servedAt !== null && entry.receivedAtMs !== null
    ? pilotFreshness(
      { observedAt: reading.observedAt, servedAt: entry.servedAt, receivedAtMs: entry.receivedAtMs, nowMs },
      observation,
      entry.station.category ?? defaultCategoryForVendor(entry.station.vendor),
    )
    : null;
  const status = entry.status === 'catalogue' ? 'Not yet loaded'
    : entry.status === 'loading' ? 'Loading'
    : entry.status === 'unavailable' ? 'Unavailable'
    : entry.status === 'refresh-failed' ? 'Refresh failed'
    : 'Available';
  const speed = (value: number | null | undefined) => value == null ? 'Not reported' : metric.convertValue(value);

  return {
    status,
    freshness,
    age: age === null ? 'Unknown age' : age === 0 ? 'Less than 1 min ago' : `${age} min ago`,
    observedAt: reading?.observedAt ?? null,
    average: speed(reading?.windAvgMps),
    gust: speed(reading?.windGustMps),
    direction: reading?.windDirectionDeg == null ? 'Not reported' : `${reading.windDirectionDeg}° from`,
    rotation: windDirectionRotation(reading?.windDirectionDeg ?? null),
    temperature: reading?.temperatureC == null ? 'Not reported' : `${reading.temperatureC} °C`,
    elevation: (observation?.elevationM ?? entry.station.elevationM) == null
      ? 'Not reported' : `${observation?.elevationM ?? entry.station.elevationM} m`,
    source: observation?.sourceLabel ?? entry.unavailable?.sourceLabel ?? entry.station.vendor,
    sourceUrl: safeSourceUrl((observation ?? entry.unavailable)?.pageUrl ?? entry.station.pageUrl),
  };
}
