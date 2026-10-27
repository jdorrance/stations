import {
  NZ_CHATHAMS_BOUNDS,
  REGIONS,
  containsPoint,
  coversPoint,
  type Position,
  type RegionCode,
} from '@stations/geography';

/**
 * Coarse coverage-based country hint for discovery when an upstream feed
 * does not declare a country. Not a political boundary proof — callers must
 * still pass the result through `inferRegionCode`.
 *
 * Armenia uses `REGIONS.AM`, minus the NE corner that overlaps Azerbaijan/Georgia
 * WeatherLink/WU noise (lon>45.4 && lat>40.55). Geography does not own that
 * carve-out; it is discovery-only.
 */
export function coverageCountryHint(point: Position): RegionCode | null {
  const { latitude, longitude } = point;
  // NE corner of the Armenia envelope overlaps Azerbaijan/Georgia
  // WeatherLink/WU noise. Geography does not own that carve-out.
  if (
    containsPoint(REGIONS.AM.envelope, point) &&
    !(longitude > 45.4 && latitude > 40.55)
  ) {
    return 'AM';
  }
  if (coversPoint(REGIONS.NZ.coverage, point)) return 'NZ';
  return null;
}

/** Region display default TZ — not every station's zone (see {@link defaultTimeZoneForPoint}). */
export function defaultTimeZoneForRegion(code: RegionCode | null | undefined): string | null {
  if (!code) return null;
  return REGIONS[code]?.defaultTimeZone ?? null;
}

/**
 * Station-level TZ hint when the feed omits one.
 * Chatham Islands use Pacific/Chatham; other NZ coverage uses Pacific/Auckland.
 * Returns null when the point is outside known coverage (do not invent).
 */
export function defaultTimeZoneForPoint(point: Position): string | null {
  const country = coverageCountryHint(point);
  if (country === 'AM') return 'Asia/Yerevan';
  if (country !== 'NZ') return null;
  if (containsPoint(NZ_CHATHAMS_BOUNDS, point)) return 'Pacific/Chatham';
  return 'Pacific/Auckland';
}

/** WindGuru (and similar) TZ / name strings → region code. */
export function countryHintFromTimeZoneOrName(
  timeZone: string | null | undefined,
  name: string,
): RegionCode | null {
  const tz = timeZone?.trim() ?? '';
  if (tz === 'Asia/Yerevan' || /\barmenia\b/i.test(name)) return 'AM';
  if (
    tz === 'Pacific/Auckland' ||
    tz === 'Pacific/Chatham' ||
    /\bnew zealand\b|\baotearoa\b/i.test(name)
  ) {
    return 'NZ';
  }
  if (
    tz &&
    /^America\/(?:Mexico_City|Cancun|Mazatlan|Hermosillo|Merida|Monterrey|Chihuahua|Tijuana|Bahia_Banderas)$/i.test(
      tz,
    )
  ) {
    return 'MX';
  }
  return null;
}
