export const KNOTS_TO_MPS = 0.5144444444444445;
export const MPH_TO_MPS = 0.44704;
export const FEET_TO_METERS = 0.3048;
export const INHG_TO_HPA = 33.863886666667;

/**
 * 30-day catalogue activity window used during discovery and crawling to exclude
 * decommissioned or offline stations. Tactical flying freshness (`live` / `aging` / `stale`)
 * is evaluated on much shorter minute-scale windows via `pilotFreshness`.
 */
export const MAX_OBSERVATION_AGE_DAYS = 30;
export const MAX_OBSERVATION_AGE_SECONDS = MAX_OBSERVATION_AGE_DAYS * 86_400;
export const MAX_OBSERVATION_AGE_MS = MAX_OBSERVATION_AGE_SECONDS * 1_000;

export function isRecentObservation(
  observedAt: string | number | null | undefined,
  nowMs = Date.now(),
  maxAgeMs = MAX_OBSERVATION_AGE_MS,
): boolean {
  const obsMs = typeof observedAt === 'number' ? observedAt : observationTimeMs(observedAt);
  if (!Number.isFinite(obsMs) || !Number.isFinite(nowMs)) return false;
  const ageMs = nowMs - obsMs;
  return ageMs <= maxAgeMs && ageMs >= -86_400_000;
}

/** Magnus approximation for relative humidity (%) from temperature and dew point (°C). */
export function relativeHumidityFromDewPoint(
  tempC: number | null,
  dewPointC: number | null,
): number | null {
  if (tempC === null || dewPointC === null) return null;
  const a = 17.625;
  const b = 243.04;
  const gammaT = (a * tempC) / (b + tempC);
  const gammaD = (a * dewPointC) / (b + dewPointC);
  const rh = 100 * Math.exp(gammaD - gammaT);
  return Math.min(100, Math.max(0, Math.round(rh)));
}

/** External JSON stays unknown until an adapter checks its required fields. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Finite numeric value when the upstream field must be a JSON number. */
export function strictNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Finite numeric value when the upstream sends either numbers or numeric strings. */
export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function fahrenheitToCelsius(f: number): number {
  return Math.round((((f - 32) * 5) / 9) * 10) / 10;
}

/** Parse an observation instant without depending on the host's local timezone. */
export function observationTimeMs(value: unknown): number {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) {
    const epoch = Number(value);
    const ms = epoch < 1e11 ? epoch * 1_000 : epoch;
    return ms > 0 && Number.isFinite(new Date(ms).getTime()) ? ms : NaN;
  }
  if (typeof value !== 'string') return NaN;
  const normalized = value.trim().replace(' ', 'T');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized)) return NaN;
  const parts = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/)!;
  const [, y, m, d, h, min, sec] = parts;
  if (!Number.isFinite(utcPartsMs(Number(y), Number(m), Number(d), Number(h), Number(min), Number(sec ?? 0)))) return NaN;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : NaN;
}

/** Use only when the upstream contract explicitly defines a zone-less field as UTC. */
export function utcObservationTimeMs(value: unknown): number {
  if (typeof value !== 'string') return observationTimeMs(value);
  return observationTimeMs(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : `${value}Z`);
}

export function utcPartsMs(year: number, month: number, day: number, hour: number, minute: number, second = 0): number {
  if (![year, month, day, hour, minute, second].every(Number.isInteger) || year < 1000
    || month < 1 || month > 12 || day < 1 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return NaN;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? ms : NaN;
}

export function windDirection(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 360 ? value % 360 : null;
}

export function optionalWindMps(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 140 ? value : null;
}

export function pressureHpa(value: number | null): number | null {
  return value !== null && value >= 300 && value <= 1100 ? value : null;
}

export function validTemperatureC(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= -100 && value <= 70 ? value : null;
}
