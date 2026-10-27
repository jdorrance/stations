/**
 * XCTrack nearest-wind widget (`/xct`).
 *
 * One tile per station, nearest first. Each tile answers six questions at a
 * glance: wind strength + gust (dial centre), wind direction (rim arrow,
 * flying with the wind), where the station is from me (a solid arc on the
 * faint circle outside the rose, and the distance in the footer), which
 * station (name), how fresh the reading is, and how high it is. Height is a
 * rail on the left. The stations on screen are the top and bottom, the bead
 * is this station, and the tick is your altitude. The footer holds the
 * metres on the left and the distance on the right, under the rose. With no
 * altitude yet, the metres are the station's own and the tick is absent.
 * With no station height, the distance stays centered. The window is
 * at least 400 m, so a flat screen stays flat. Past either end the tick is
 * an arrow and the bar stops. The altitude slider is shown only when this
 * screen has a station height and a pilot altitude (a fix or `alt`). The
 * feed name is the curated short label when the catalogue has one (at most
 * 11 characters). No chip means live. After that the chip uses one of three
 * fixed pairs — amber, dark brown, then
 * black — so the digits stay readable. The tile fades with age. Stale
 * readings draw an outline arrow. A station with no reading is omitted.
 *
 * URL parameters (all optional):
 *
 * | Param        | Values                                   | Default          |
 * |--------------|------------------------------------------|------------------|
 * | `units`      | `metric` · `imperial` · `kts` · `ms`     | `metric`         |
 * | `size`       | 2…100 → tiles scale by `1 + size/100`    | 0 (80 px tiles)  |
 * | `mode`       | `dark`                                   | light            |
 * | `lat`,`lng`  | fixed position (`lon` accepted)          | XCTrack / GPS    |
 * | `alt`        | pilot altitude m MSL; the rail tick      | XCTrack / GPS    |
 * | `maxage`     | hide readings older than N minutes       | 120              |
 * | `category`   | csv of station categories                | all wind-capable |
 * | `debug`      | any value → Mt Hatis fix, drifts slowly  | off              |
 *
 * The same list is what a pilot pastes from `/xct-use`. Keep that page in step
 * with this table.
 */
import { createStationsClient } from '@stations/client';
import {
  compassDirection,
  declaredFavorableDirections,
  isCalm,
  isStationCategory,
  pilotFreshness,
  pilotFreshnessThresholds,
  speedFromMps,
  type FreshnessStatus,
  type SpeedUnit,
  type Station,
  type StationCategory,
} from '@stations/contracts';
import { bearingDeg, distanceKm, type Position } from '@stations/geography';
import { loadNearbyWind, observationAgeMs, type NearbyWindObservation } from './xct-feed.ts';

declare global {
  interface Window {
    XCTrack?: {
      getLocation?: () => string;
    };
  }
}

/** Mt Hatis summit area (Armenia) — default debug fix. */
const DEBUG_HATIS: Position = { latitude: 40.3347, longitude: 44.73241 };

/** Server `/feed?near=` radius — nearest stations within this distance. */
const NEAR_RADIUS_KM = 300;
const MAX_TILES = 30;
const FEED_INTERVAL_MS = 60_000;
const FEED_RETRY_MS = 10_000;
const FEED_TIMEOUT_MS = 45_000;
/** A lost/stalled fix must not keep driving station distance and bearing. */
const FIX_MAX_AGE_MS = 30_000;
/** Age chips, fix expiry, and tile fade — 10s is enough in flight. */
const VIEW_INTERVAL_MS = 10_000;
const DEFAULT_MAX_AGE_MIN = 120;
const KM_PER_MILE = 1.609344;

/**
 * Absolute elevation (m MSL) at/above which a station is treated as a peak
 * when the pilot altitude is unknown.
 */
const PEAK_ELEVATION_M = 1000;
/** Station this many metres above the pilot counts as peak terrain. */
const PEAK_ABOVE_PILOT_M = 80;
/**
 * Shortest height window for the rails, metres. A screen tighter than this
 * is widened around its midpoint so small differences do not fill the tile.
 */
const ELEV_WINDOW_M = 400;
/** Within this many metres of you, the height number reads level. */
const ELEV_LEVEL_M = 15;
/** Room past the station window so the slider can sit above or below it. */
const ELEV_SLIDER_PAD_M = 400;

/**
 * Wind colour in km/h, on the rounded average the tile shows.
 * A gust in a higher band steps the colour up one.
 * Average or gust at 40 km/h is past trim and is always red.
 *
 * | Band   | km/h    | Meaning    |
 * |--------|---------|------------|
 * | light  | under 5 | light air  |
 * | easy   | 5–9     | easy       |
 * | active | 10–14   | active     |
 * | fresh  | 15–24   | fresh      |
 * | strong | 25–39   | strong     |
 * | trim   | 40+     | past trim  |
 */
const WIND_BANDS = ['light', 'easy', 'active', 'fresh', 'strong', 'trim'] as const;
const TRIM_KMH = 40;

/** Dial geometry in SVG user units (viewBox 0 0 48 48). The ring fills the tile. */
const DIAL_C = 24;
const DIAL_R = 20;
/** Head on the rim, pointing in, in the gap between the digits and the ring. */
const DIAL_ARROW_TIP_IN = 8.5;
const DIAL_ARROW_BASE_OUT = 1.2;
const DIAL_ARROW_HALF_WIDTH = 7.4;
const DIAL_TICK_LEN = 3.2;

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Place ring in the 80×84 tile, centred on the rose (name 13, footer 16). */
const ORBIT_CX = 40;
const ORBIT_CY = 40.5;
const ORBIT_R = 28;
/** Solid arc, degrees, centred on the bearing to the station. */
const ORBIT_SPAN = 34;

type DistanceUnit = 'km' | 'mi';
type WindBand = (typeof WIND_BANDS)[number];
type TerrainKind = 'peak' | 'valley';
type DirectionArc = NonNullable<ReturnType<typeof declaredFavorableDirections>>[number];

interface DisplayUnits {
  readonly speed: SpeedUnit;
  readonly distance: DistanceUnit;
}

interface TileModel {
  readonly uid: string;
  readonly name: string;
  readonly category: StationCategory;
  readonly terrain: TerrainKind;
  readonly windAvgMps: number;
  readonly windGustMps: number | null;
  readonly windDirectionDeg: number | null;
  readonly calm: boolean;
  readonly favorable: readonly DirectionArc[] | null;
  readonly distanceKm: number;
  /** Bearing from the pilot to the station, degrees true. */
  readonly bearingDeg: number;
  readonly freshness: FreshnessStatus;
  /**
   * 0 the instant a reading leaves live, 1 once it is stale. The chip colour
   * walks amber → black across this. Stays 1 until the tile is dropped.
   */
  readonly ageFade: number;
  readonly windBand: WindBand;
  readonly ageMinutes: number;
  readonly ageMs: number;
  /** Age at which this station's category calls the reading stale. */
  readonly staleAfterMs: number;
  readonly elevationM: number | null;
  readonly refreshFailed: boolean;
}

const params = new URLSearchParams(location.search);
const client = createStationsClient({ baseUrl: '/api/stations' });

const listEl = document.getElementById('station-list') as HTMLElement;
const emptyEl = document.getElementById('empty-state') as HTMLElement;
const altBarEl = document.getElementById('alt-bar') as HTMLElement;
const altSliderEl = document.getElementById('alt-slider') as HTMLInputElement;
const altReadoutEl = document.getElementById('alt-readout') as HTMLElement;

let myPosition: Position | null = null;
/** Pilot altitude MSL metres when known (XCTrack / ?alt=). */
let myAltitudeM: number | null = null;
/**
 * Altitude chosen on the slider. It wins over the fix for this page load.
 * Absent until the slider moves, so a missing fix is not invented.
 */
let altOverrideM: number | null = null;
/** True while a pointer is down on the slider, so a fix cannot move the thumb. */
let altDragging = false;
/** True while the slider's min, max, or value are being written from code. */
let altSyncing = false;
let debugPosition: Position | null = null;
type RetainedObservation = NearbyWindObservation & { refreshFailed: boolean };
const liveByUid = new Map<string, RetainedObservation>();
let feedOnline: boolean | null = null;
let geoError: string | null = null;
let feedRetryTimer: number | null = null;
let viewTimer: number | null = null;
let feedTimer: number | null = null;
let geoWatchId: number | null = null;
let pollInFlight = false;
let partialFailureCount = 0;
let coverageLimited = false;
let requestController: AbortController | null = null;
/** Raw bridge identity (`lat,lon,time`); resets the fix clock only when this changes. */
let nativePayloadKey: string | null = null;
let fixReceivedAtMs = 0;
let fixAgeAtReceiptMs = 0;
let browserFixActive = false;
const tileMarkup = new WeakMap<HTMLElement, string>();

function getParam(name: string): string | null {
  const value = params.get(name);
  return value === null || value === '' ? null : value;
}

function parseCategories(): StationCategory[] | undefined {
  const raw = getParam('category');
  if (!raw) return undefined;
  const parsed = raw
    .split(',')
    .map(part => part.trim())
    .filter(isStationCategory);
  return parsed.length > 0 ? parsed : undefined;
}

function parseMaxAgeMs(): number {
  const raw = getParam('maxage');
  if (raw === null) return DEFAULT_MAX_AGE_MIN * 60_000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_MAX_AGE_MIN * 60_000;
  return minutes * 60_000;
}

/**
 * `?units=`: `metric` (km/h + km, default) or `imperial` (mph + mi).
 * Speed-only aliases keep km distances: `kts|kt|knots`, `ms|mps|m/s`;
 * `kmh` = metric, `mph` = imperial.
 */
function parseDisplayUnits(): DisplayUnits {
  const raw = (getParam('units') ?? 'metric').toLowerCase();
  if (raw === 'imperial' || raw === 'mph') return { speed: 'mph', distance: 'mi' };
  if (raw === 'kts' || raw === 'kt' || raw === 'knots') return { speed: 'knots', distance: 'km' };
  if (raw === 'ms' || raw === 'mps' || raw === 'm/s') return { speed: 'mps', distance: 'km' };
  return { speed: 'kmh', distance: 'km' };
}

function speedUnitLabel(unit: SpeedUnit): string {
  switch (unit) {
    case 'kmh':
      return 'km/h';
    case 'knots':
      return 'kt';
    case 'mph':
      return 'mph';
    case 'mps':
      return 'm/s';
  }
}

function parseAltitudeM(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function applySizeFactor(): void {
  const size = Number(getParam('size') ?? '0');
  if (Number.isFinite(size) && size > 1 && size <= 100) {
    document.documentElement.style.setProperty('--size-factor', String(1 + size / 100));
  }
}

function applyDarkMode(): void {
  if (getParam('mode') === 'dark') {
    document.body.classList.add('dark');
  }
}

function setOnlineState(ok: boolean | null): void {
  feedOnline = ok;
  document.body.dataset.feed = ok === null ? 'loading' : ok ? 'online' : 'offline';
}

function setEmpty(message: string | null): void {
  if (message === null) {
    emptyEl.hidden = true;
    emptyEl.textContent = '';
    return;
  }
  emptyEl.hidden = false;
  emptyEl.textContent = message;
}

function coerceCoordinate(raw: unknown): number | null {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

function validCoordinates(lat: unknown, lon: unknown): lat is number {
  const latitude = coerceCoordinate(lat);
  const longitude = coerceCoordinate(lon);
  return latitude !== null && longitude !== null &&
    latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

/**
 * Explicit invalid only. Missing flags and truthy bridge quirks (`1`, `"true"`)
 * still count as a fix when coordinates are in range.
 */
function isExplicitlyInvalidFix(flag: unknown): boolean {
  return flag === false || flag === 0 || flag === 'false' || flag === '0';
}

/**
 * Epoch milliseconds when `raw` is unix seconds/ms or an ISO date.
 * Small time-of-day numbers become 1970 dates — callers must not treat those
 * as wall-clock proof of a live fix.
 */
function fixTimestampMs(raw: unknown): number | null {
  let value: number;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && raw.trim() !== '') {
    const asNumber = Number(raw);
    value = Number.isFinite(asNumber) ? asNumber : Date.parse(raw);
  } else {
    return null;
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value < 100_000_000_000) value *= 1_000;
  return value;
}

/**
 * Wall-clock age for a bridge/browser timestamp that is near `Date.now()`.
 * Returns null when the field is missing, unusable, or skewed too far to trust
 * (time-of-day, multi-hour clock error). A plausible recent unix time older
 * than {@link FIX_MAX_AGE_MS} returns that age so the caller can reject it.
 */
const PLAUSIBLE_FIX_SKEW_MS = 15 * 60_000;

function wallClockAgeMs(raw: unknown): number | null {
  const timeMs = fixTimestampMs(raw);
  if (timeMs === null) return null;
  const ageMs = Date.now() - timeMs;
  if (Math.abs(ageMs) <= FIX_MAX_AGE_MS) return Math.max(0, ageMs);
  // Recent past beyond the live window — treat as a real but stale GPS time.
  if (ageMs > FIX_MAX_AGE_MS && ageMs <= PLAUSIBLE_FIX_SKEW_MS) return ageMs;
  return null;
}

/** Browser GeolocationPosition.timestamp is unix ms when the engine follows the spec. */
function isUsableUnixTimestampMs(timestamp: number): boolean {
  return Number.isFinite(timestamp) && timestamp >= 1_000_000_000_000;
}

function invalidatePosition(message: string): void {
  myPosition = null;
  myAltitudeM = null;
  browserFixActive = false;
  nativePayloadKey = null;
  geoError = message;
}

function currentFixAgeMs(): number {
  return fixAgeAtReceiptMs + Math.max(0, performance.now() - fixReceivedAtMs);
}

type XcTrackRead =
  | { kind: 'absent' }
  | { kind: 'unavailable' }
  | { kind: 'stale' }
  | { kind: 'ok'; position: Position };

function readXcTrackPosition(): XcTrackRead {
  if (typeof window.XCTrack === 'undefined' || typeof window.XCTrack.getLocation !== 'function') {
    return { kind: 'absent' };
  }
  try {
    const data: unknown = JSON.parse(window.XCTrack.getLocation());
    if (!data || typeof data !== 'object') return { kind: 'unavailable' };
    const fix = data as Record<string, unknown>;
    if (isExplicitlyInvalidFix(fix.isValid)) return { kind: 'unavailable' };
    const latitude = coerceCoordinate(fix.lat);
    const longitude = coerceCoordinate(fix.lon);
    if (latitude === null || longitude === null ||
        latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return { kind: 'unavailable' };
    }

    const ageFromWall = wallClockAgeMs(fix.time);
    if (ageFromWall !== null && ageFromWall > FIX_MAX_AGE_MS) return { kind: 'stale' };

    // Re-reading a frozen native payload must not reset its expiration clock.
    const payloadKey = `${latitude},${longitude},${String(fix.time)}`;
    if (payloadKey !== nativePayloadKey) {
      nativePayloadKey = payloadKey;
      fixReceivedAtMs = performance.now();
      fixAgeAtReceiptMs = ageFromWall ?? 0;
    }
    if (currentFixAgeMs() > FIX_MAX_AGE_MS) return { kind: 'stale' };

    myAltitudeM = parseAltitudeM(getParam('alt')) ??
      parseAltitudeM(fix.altGps) ?? parseAltitudeM(fix.alt) ??
      parseAltitudeM(fix.altitude) ?? parseAltitudeM(fix.elevation);
    return { kind: 'ok', position: { latitude, longitude } };
  } catch {
    return { kind: 'unavailable' };
  }
}

function readUrlPosition(): Position | null {
  const latRaw = getParam('lat');
  const lonRaw = getParam('lng') ?? getParam('lon');
  if (latRaw === null || lonRaw === null) return null;
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  myAltitudeM = parseAltitudeM(getParam('alt'));
  return { latitude: lat, longitude: lon };
}

function advanceDebugPosition(): Position {
  if (!debugPosition) {
    debugPosition = readUrlPosition() ?? { ...DEBUG_HATIS };
    // Optional ?alt= for relative peak/valley; do not invent an altitude.
    if (myAltitudeM === null) myAltitudeM = parseAltitudeM(getParam('alt'));
  } else {
    debugPosition = {
      latitude: debugPosition.latitude + 0.01,
      longitude: debugPosition.longitude + 0.01,
    };
  }
  return debugPosition;
}

function refreshPosition(advanceDebug = false): void {
  if (getParam('debug') !== null) {
    myPosition = advanceDebug || debugPosition === null ? advanceDebugPosition() : debugPosition;
    geoError = null;
    return;
  }

  const url = readUrlPosition();
  if (url) {
    myPosition = url;
    geoError = null;
    return;
  }

  const xc = readXcTrackPosition();
  if (xc.kind !== 'absent') {
    if (xc.kind === 'ok') {
      myPosition = xc.position;
      geoError = null;
    } else {
      invalidatePosition(xc.kind === 'stale' ? 'GPS fix stale' : 'GPS fix unavailable');
    }
    return;
  }

  if (browserFixActive && currentFixAgeMs() > FIX_MAX_AGE_MS) {
    invalidatePosition('GPS fix stale');
  }
  if (myPosition === null && geoError === null) {
    geoError = 'wait for position';
  }
}

function startGeolocationFallback(): void {
  if (getParam('debug') !== null) return;
  if (readUrlPosition()) return;
  if (readXcTrackPosition().kind !== 'absent') return;
  if (geoWatchId !== null) return;
  if (!navigator.geolocation) {
    geoError = 'geolocation unavailable';
    return;
  }
  geoWatchId = navigator.geolocation.watchPosition(
    pos => {
      const hadFix = myPosition !== null;
      if (!validCoordinates(pos.coords.latitude, pos.coords.longitude)) {
        invalidatePosition('GPS fix unavailable');
        updateView();
        return;
      }
      const usableUnix = isUsableUnixTimestampMs(pos.timestamp);
      if (usableUnix && Math.abs(Date.now() - pos.timestamp) > FIX_MAX_AGE_MS) {
        invalidatePosition('GPS fix stale');
        updateView();
        return;
      }
      fixReceivedAtMs = performance.now();
      fixAgeAtReceiptMs = usableUnix && Math.abs(Date.now() - pos.timestamp) <= FIX_MAX_AGE_MS
        ? Math.max(0, Date.now() - pos.timestamp)
        : 0;
      browserFixActive = true;
      myPosition = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      };
      myAltitudeM = parseAltitudeM(getParam('alt')) ?? parseAltitudeM(pos.coords.altitude);
      geoError = null;
      updateView();
      if (!hadFix) void pollFeed();
    },
    err => {
      invalidatePosition(err.code === err.PERMISSION_DENIED
        ? 'location permission denied' : 'GPS fix unavailable');
      updateView();
    },
    { enableHighAccuracy: true, maximumAge: 15_000, timeout: 15_000 },
  );
}

function clearFeedRetry(): void {
  if (feedRetryTimer === null) return;
  window.clearTimeout(feedRetryTimer);
  feedRetryTimer = null;
}

function stopBrowserGeolocation(): void {
  if (geoWatchId === null) return;
  navigator.geolocation.clearWatch(geoWatchId);
  geoWatchId = null;
}

function clearIntervalTimer(id: number | null): null {
  if (id !== null) window.clearInterval(id);
  return null;
}

/** Stop periodic bridge reads, feed polls, retries, and browser GPS. */
function stopPolling(): void {
  viewTimer = clearIntervalTimer(viewTimer);
  feedTimer = clearIntervalTimer(feedTimer);
  clearFeedRetry();
  stopBrowserGeolocation();
}

/** Resume periodic work. No-op when already running. */
function startPolling(): void {
  if (viewTimer !== null) return;
  // Fix expiry and observation age must advance even while a feed request hangs.
  viewTimer = window.setInterval(() => {
    const hadFix = myPosition !== null;
    refreshPosition();
    updateView();
    if (!hadFix && myPosition !== null) void pollFeed();
  }, VIEW_INTERVAL_MS);
  feedTimer = window.setInterval(() => {
    void pollFeed();
  }, FEED_INTERVAL_MS);
}

function pageIsVisible(): boolean {
  return document.visibilityState === 'visible';
}

function formatDistance(km: number, unit: DistanceUnit): string {
  const value = unit === 'mi' ? km / KM_PER_MILE : km;
  const text = value < 10 ? (Math.round(value * 10) / 10).toFixed(1) : String(Math.round(value));
  return `${text} ${unit}`;
}

/** 8-point compass letters — coarse on purpose; this is "which way is it", not navigation. */
function compass8(deg: number): string {
  return COMPASS_8[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

function roundSpeed(mps: number, unit: SpeedUnit): number {
  return Math.round(speedFromMps(mps, unit));
}

/** A reported gust of 0 is a feed glitch, not a calm gust. Treat it as absent. */
function displayedGust(gustMps: number | null, unit: SpeedUnit): number | null {
  if (gustMps === null || gustMps <= 0) return null;
  return roundSpeed(gustMps, unit);
}

/** Point on the dial at radius `r` and compass bearing `deg` (0° = up). */
function dialPoint(r: number, deg: number): { x: number; y: number } {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: DIAL_C + r * Math.cos(a), y: DIAL_C + r * Math.sin(a) };
}

function svgNum(n: number): string {
  return n.toFixed(1);
}

/** Clockwise ring arc from `fromDeg` to `toDeg`; empty for a single bearing. */
function ringArcPath(arc: DirectionArc): string {
  const span = (((arc.toDeg - arc.fromDeg) % 360) + 360) % 360;
  if (span === 0) return '';
  const a = dialPoint(DIAL_R, arc.fromDeg);
  const b = dialPoint(DIAL_R, arc.toDeg);
  const large = span > 180 ? 1 : 0;
  return `M${svgNum(a.x)} ${svgNum(a.y)} A${DIAL_R} ${DIAL_R} 0 ${large} 1 ${svgNum(b.x)} ${svgNum(b.y)}`;
}

/**
 * Compass dial: ring with cardinal ticks, optional favourable-direction band,
 * an arrow on the rim at the FROM bearing pointing inward (it flies with the
 * wind), and the average speed in the centre with the gust beneath it.
 * Colour comes from the tile's wind band via `currentColor`.
 */
function windDialSvg(tile: TileModel, units: DisplayUnits): string {
  const parts: string[] = [];

  if (tile.favorable) {
    for (const arc of tile.favorable) {
      const d = ringArcPath(arc);
      if (d) parts.push(`<path class="dialFav" d="${d}"/>`);
    }
  }

  parts.push(`<circle class="dialRing" cx="${DIAL_C}" cy="${DIAL_C}" r="${DIAL_R}"/>`);
  for (const deg of [0, 90, 180, 270]) {
    const outer = dialPoint(DIAL_R, deg);
    const inner = dialPoint(DIAL_R - DIAL_TICK_LEN, deg);
    parts.push(
      `<line class="dialTick" x1="${svgNum(outer.x)}" y1="${svgNum(outer.y)}" x2="${svgNum(inner.x)}" y2="${svgNum(inner.y)}"/>`,
    );
  }

  if (!tile.calm && tile.windDirectionDeg !== null) {
    const from = tile.windDirectionDeg;
    const tip = dialPoint(DIAL_R - DIAL_ARROW_TIP_IN, from);
    const base = dialPoint(DIAL_R + DIAL_ARROW_BASE_OUT, from);
    const a = ((from - 90) * Math.PI) / 180;
    // Perpendicular to the radial direction.
    const px = -Math.sin(a) * DIAL_ARROW_HALF_WIDTH;
    const py = Math.cos(a) * DIAL_ARROW_HALF_WIDTH;
    parts.push(
      `<polygon class="dialArrow" points="${svgNum(tip.x)},${svgNum(tip.y)} ${svgNum(base.x + px)},${svgNum(base.y + py)} ${svgNum(base.x - px)},${svgNum(base.y - py)}"/>`,
    );
  }

  const avg = roundSpeed(tile.windAvgMps, units.speed);
  const gust = displayedGust(tile.windGustMps, units.speed);
  if (gust === null) {
    parts.push(`<text class="dialAvg" font-size="14" x="${DIAL_C}" y="28">${avg}</text>`);
  } else {
    parts.push(`<text class="dialAvg" font-size="14" x="${DIAL_C}" y="23">${avg}</text>`);
    parts.push(`<text class="dialGust" font-size="9.8" x="${DIAL_C}" y="35">${gust}</text>`);
  }

  return `<svg class="dial" viewBox="0 0 48 48" aria-hidden="true">${parts.join('')}</svg>`;
}

function windStep(kmh: number): number {
  if (kmh < 5) return 0;
  if (kmh < 10) return 1;
  if (kmh < 15) return 2;
  if (kmh < 25) return 3;
  if (kmh < TRIM_KMH) return 4;
  return 5;
}

function windBand(avgMps: number, gustMps: number | null): WindBand {
  const avg = Math.round(speedFromMps(avgMps, 'kmh'));
  const gust = displayedGust(gustMps, 'kmh');
  if (avg >= TRIM_KMH || (gust !== null && gust >= TRIM_KMH)) return 'trim';
  let step = windStep(avg);
  if (gust !== null && windStep(gust) > step) step += 1;
  return WIND_BANDS[step];
}

/**
 * Peak vs valley/ground silhouette.
 * Prefer elevation vs pilot altitude; else absolute elevation; else a weak
 * category hint. Unknown elev defaults to valley — most PWS (WU etc.) omit
 * elevation and are valley/city sites, not ridges.
 */
function terrainForStation(station: Station, category: StationCategory): TerrainKind {
  const elev = station.elevationM;
  if (elev !== null && myAltitudeM !== null) {
    return elev > myAltitudeM + PEAK_ABOVE_PILOT_M ? 'peak' : 'valley';
  }
  if (elev !== null) {
    return elev >= PEAK_ELEVATION_M ? 'peak' : 'valley';
  }
  // No elevation in the feed: only freeflight windtalkers / mountain networks
  // are assumed ridge-like; PWS, synoptic, marine → ground.
  return category === 'freeflight' || category === 'mountain' ? 'peak' : 'valley';
}

function buildTileModels(center: Position, nowMs: number): TileModel[] {
  const maxAgeMs = parseMaxAgeMs();
  const tiles: TileModel[] = [];

  for (const entry of liveByUid.values()) {
    const { station, category, servedAt, receivedAtMs } = entry;
    const { reading } = station;
    const ageMs = observationAgeMs(entry, nowMs);
    if (ageMs > maxAgeMs) continue;

    const lat = station.latitude;
    const lon = station.longitude;
    if (lat === null || lon === null) continue;
    const here: Position = { latitude: lat, longitude: lon };
    const km = distanceKm(center, here);
    if (km > NEAR_RADIUS_KM) continue;

    const thresholds = pilotFreshnessThresholds(station, category);
    const freshness = pilotFreshness(
      {
        observedAt: reading.observedAt,
        servedAt,
        receivedAtMs,
        nowMs,
      },
      station,
      category,
    );
    const agingSpan = Math.max(1, thresholds.staleAfterMs - thresholds.currentForMs);
    const ageFade =
      ageMs <= thresholds.currentForMs
        ? 0
        : Math.min(1, (ageMs - thresholds.currentForMs) / agingSpan);

    tiles.push({
      uid: station.id,
      name: station.name,
      category,
      terrain: terrainForStation(station, category),
      windAvgMps: reading.windAvgMps,
      windGustMps: reading.windGustMps,
      windDirectionDeg: reading.windDirectionDeg,
      calm: isCalm(reading.windAvgMps),
      favorable: declaredFavorableDirections(station),
      distanceKm: km,
      bearingDeg: bearingDeg(center, here),
      freshness,
      ageFade,
      windBand: windBand(reading.windAvgMps, reading.windGustMps),
      ageMinutes: Math.round(ageMs / 60_000),
      ageMs,
      staleAfterMs: thresholds.staleAfterMs,
      elevationM: station.elevationM,
      refreshFailed: entry.refreshFailed,
    });
  }

  tiles.sort((a, b) => a.distanceKm - b.distanceKm);
  return tiles.slice(0, MAX_TILES);
}

function ensureTileNode(uid: string): HTMLElement {
  const existing = document.getElementById(uid);
  if (existing instanceof HTMLElement) return existing;
  const node = document.createElement('div');
  node.id = uid;
  node.className = 'stationDetail';
  node.setAttribute('role', 'listitem');
  return node;
}

/**
 * Three fixed pairs, each above 8:1. A blended brown (the old 22 min chip)
 * sat between them and the digits disappeared.
 * early = first half of aging, late = second half, stale = past the category cutoff.
 */
function ageChipStep(tile: TileModel): 'early' | 'late' | 'stale' {
  if (tile.freshness === 'stale') return 'stale';
  return tile.ageFade < 0.5 ? 'early' : 'late';
}

function orbitPoint(deg: number): { x: number; y: number } {
  const a = ((((deg % 360) + 360) % 360 - 90) * Math.PI) / 180;
  return {
    x: ORBIT_CX + ORBIT_R * Math.cos(a),
    y: ORBIT_CY + ORBIT_R * Math.sin(a),
  };
}

/**
 * Faint dashed circle around the rose, with a short solid arc where the
 * station sits. The arc is not an arrow, so it is not the wind.
 */
function placeOrbitSvg(bearingDeg: number): string {
  const start = orbitPoint(bearingDeg - ORBIT_SPAN / 2);
  const end = orbitPoint(bearingDeg + ORBIT_SPAN / 2);
  return (
    `<svg class="orbit" viewBox="0 0 80 84" preserveAspectRatio="xMidYMid meet" aria-hidden="true">` +
    `<circle class="orbitDash" cx="${ORBIT_CX}" cy="${ORBIT_CY}" r="${ORBIT_R}"/>` +
    `<path class="orbitMark" d="M${svgNum(start.x)} ${svgNum(start.y)} A${ORBIT_R} ${ORBIT_R} 0 0 1 ${svgNum(end.x)} ${svgNum(end.y)}"/>` +
    `</svg>`
  );
}

/** Altitude the rails use: the slider once it has moved, otherwise the fix. */
function railAltitudeM(): number | null {
  return altOverrideM ?? myAltitudeM;
}

interface ElevWindow {
  readonly lo: number;
  readonly hi: number;
}

/**
 * Lowest and highest station on screen. Fewer than {@link ELEV_WINDOW_M}
 * metres between them is widened around the midpoint.
 */
function elevationWindow(tiles: readonly TileModel[]): ElevWindow | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const tile of tiles) {
    if (tile.elevationM === null) continue;
    lo = Math.min(lo, tile.elevationM);
    hi = Math.max(hi, tile.elevationM);
  }
  if (!Number.isFinite(lo)) return null;
  if (hi - lo < ELEV_WINDOW_M) {
    const mid = (lo + hi) / 2;
    lo = mid - ELEV_WINDOW_M / 2;
    hi = mid + ELEV_WINDOW_M / 2;
  }
  return { lo, hi };
}

/** One decimal percent, so a 1 m GPS wobble does not rebuild the tile. */
function elevPct(t: number): string {
  return (Math.round(t * 1000) / 10).toFixed(1);
}

function elevShare(bounds: ElevWindow, metres: number): number {
  return (metres - bounds.lo) / (bounds.hi - bounds.lo);
}

interface ElevFace {
  readonly text: string;
  /** Empty when altitude is unknown and the number is absolute metres. */
  readonly caret: '' | 'up' | 'down' | 'level';
  /** Words for the tile title. Empty when altitude is unknown. */
  readonly phrase: string;
}

function elevFace(elevM: number, youM: number | null): ElevFace {
  if (youM === null) return { text: `${Math.round(elevM)}m`, caret: '', phrase: '' };
  const delta = Math.round(elevM - youM);
  if (Math.abs(delta) < ELEV_LEVEL_M) {
    return { text: '0m', caret: 'level', phrase: 'level with you' };
  }
  if (delta > 0) {
    return { text: `+${delta}m`, caret: 'up', phrase: `${delta} m above you` };
  }
  const below = Math.abs(delta);
  return { text: `\u2212${below}m`, caret: 'down', phrase: `${below} m below you` };
}

/**
 * Rail for one station. Bottom of the track is the low end of `bounds`,
 * top is the high end. The bead is this station. The tick is you, and the
 * fill is the gap. Outside the window the tick is an arrow and the fill
 * is omitted. No elevation: nothing.
 */
function elevRailHtml(elevM: number | null, bounds: ElevWindow | null, youM: number | null): string {
  if (elevM === null || bounds === null) return '';
  const stationT = Math.min(1, Math.max(0, elevShare(bounds, elevM)));
  let youMark = '';
  let fill = '';
  if (youM !== null) {
    if (youM > bounds.hi) {
      youMark = '<div class="elevYou off-high"></div>';
    } else if (youM < bounds.lo) {
      youMark = '<div class="elevYou off-low"></div>';
    } else {
      const youT = elevShare(bounds, youM);
      youMark = `<div class="elevYou" style="bottom:${elevPct(youT)}%"></div>`;
      const gap = Math.abs(elevM - youM);
      if (gap >= ELEV_LEVEL_M) {
        const lo = Math.min(stationT, youT);
        const hi = Math.max(stationT, youT);
        fill = `<div class="elevFill" style="bottom:${elevPct(lo)}%;height:${elevPct(hi - lo)}%"></div>`;
      }
    }
  }
  return (
    '<div class="elevRail" aria-hidden="true">' +
    `<div class="elevTrack">${fill}</div>${youMark}` +
    `<div class="elevBead" style="bottom:${elevPct(stationT)}%"></div>` +
    '</div>'
  );
}

/** Metres on the left, distance on the right, both under the rose. */
function footerHtml(distance: string, elevM: number | null, youM: number | null): string {
  const dist = `<span class="dist">~${escapeHtml(distance)}</span>`;
  if (elevM === null) return `<div class="meta">${dist}</div>`;
  const face = elevFace(elevM, youM);
  const caret = face.caret === '' ? '' : `<span class="caret ${face.caret}" aria-hidden="true"></span>`;
  return `<div class="meta has-elev"><span class="elevNum">${caret}${face.text}</span>${dist}</div>`;
}

/**
 * The slider is the pilot altitude already in hand. It stays hidden when
 * this screen has no station height, and when no fix, `alt`, or prior drag
 * has an altitude. Programmatic writes are ignored so a clamped range
 * cannot invent one.
 */
function syncAltBar(bounds: ElevWindow | null): void {
  const you = railAltitudeM();
  const show = bounds !== null && you !== null;
  altBarEl.hidden = !show;
  document.body.classList.toggle('has-alt', show);
  if (bounds === null || you === null) return;

  const min = Math.min(bounds.lo - ELEV_SLIDER_PAD_M, you - 50);
  const max = Math.max(bounds.hi + ELEV_SLIDER_PAD_M, you + 50);
  altSyncing = true;
  try {
    altSliderEl.min = String(Math.round(min));
    altSliderEl.max = String(Math.round(max));
    altSliderEl.step = '1';
    if (!altDragging) altSliderEl.value = String(Math.round(you));
  } finally {
    altSyncing = false;
  }
  altReadoutEl.textContent = `${Math.round(you)} m`;
}

function bindAltSlider(): void {
  const stopDrag = (): void => {
    altDragging = false;
  };
  altSliderEl.addEventListener('pointerdown', () => {
    altDragging = true;
  });
  altSliderEl.addEventListener('pointerup', stopDrag);
  altSliderEl.addEventListener('pointercancel', stopDrag);
  altSliderEl.addEventListener('input', event => {
    if (altSyncing || event.isTrusted === false) return;
    const next = Number(altSliderEl.value);
    if (!Number.isFinite(next)) return;
    altOverrideM = next;
    updateView();
  });
}

/** Compact age for the corner chip: `14m`, `1h`, `1h05`. */
function formatAgeChip(minutes: number): string {
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}`;
}

function patchTile(
  node: HTMLElement,
  tile: TileModel,
  units: DisplayUnits,
  elevWindow: ElevWindow | null,
  youM: number | null,
): void {
  const distance = formatDistance(tile.distanceKm, units.distance);
  const where = `${compass8(tile.bearingDeg)} ${distance}`;
  // No chip while live. Aging and stale use one of three fixed colour pairs.
  const chip =
    tile.freshness === 'live'
      ? ''
      : `<span class="ageChip age-${ageChipStep(tile)}">${escapeHtml(formatAgeChip(tile.ageMinutes))}</span>`;
  const markup =
    placeOrbitSvg(tile.bearingDeg) +
    elevRailHtml(tile.elevationM, elevWindow, youM) +
    chip +
    `<div class="name">${escapeHtml(tile.name)}</div>` +
    `<div class="dialWrap">${windDialSvg(tile, units)}</div>` +
    footerHtml(distance, tile.elevationM, youM);
  // SVG serialization expands self-closing tags; comparing innerHTML would
  // recreate every dial on every tick even when no visible value changed.
  if (tileMarkup.get(node) !== markup) {
    node.innerHTML = markup;
    tileMarkup.set(node, markup);
  }

  node.className = 'stationDetail';
  if (tile.terrain === 'peak') node.classList.add('peak');
  node.classList.add(`wind-${tile.windBand}`);
  if (tile.freshness === 'aging') node.classList.add('aging');
  if (tile.freshness === 'stale') node.classList.add('stale');
  if (tile.freshness !== 'live') node.classList.add('has-age');
  // Live stays solid. Aging eases to 0.75 as the chip goes black. Stale keeps
  // fading to 0.4 at the max-age cutoff, where the tile is removed.
  let vis = 1;
  if (tile.freshness === 'aging') vis = 1 - 0.25 * tile.ageFade;
  if (tile.freshness === 'stale') {
    const span = Math.max(1, parseMaxAgeMs() - tile.staleAfterMs);
    const past = Math.min(1, Math.max(0, (tile.ageMs - tile.staleAfterMs) / span));
    vis = 0.75 - 0.35 * past;
  }
  node.style.setProperty('--vis', vis.toFixed(3));

  const age = tile.ageMinutes < 1 ? 'just now' : `${tile.ageMinutes} min ago`;
  const elevM = tile.elevationM;
  const face = elevM === null ? null : elevFace(elevM, youM);
  const elev = elevM === null || face === null
    ? ''
    : ` · ${Math.round(elevM)} m${face.phrase === '' ? '' : ` · ${face.phrase}`}`;
  const avg = roundSpeed(tile.windAvgMps, units.speed);
  const shownGust = displayedGust(tile.windGustMps, units.speed);
  const gust = shownGust === null ? '–' : String(shownGust);
  const direction = tile.calm ? 'calm' : tile.windDirectionDeg === null
    ? 'direction unavailable'
    : `${compassDirection(tile.windDirectionDeg)} (${Math.round(tile.windDirectionDeg)}°)`;
  const wind = `${direction} · average ${avg}, gust ${gust} ${speedUnitLabel(units.speed)}`;
  const retained = tile.refreshFailed ? ' · refresh failed; retained observation' : '';
  node.title = `${tile.name}${elev} · ${wind} · station ${where} · ${tile.terrain} · ${tile.windBand} · ${tile.freshness} · ${age}${retained}`;
  node.setAttribute('aria-label', node.title);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function updateView(): void {
  if (myPosition === null) {
    clearTiles();
    setEmpty(geoError ?? 'wait for position');
    syncAltBar(null);
    return;
  }

  const units = parseDisplayUnits();
  const tiles = buildTileModels(myPosition, performance.now());
  const elevWindow = elevationWindow(tiles);
  const youM = railAltitudeM();
  syncAltBar(elevWindow);
  const keep = new Set<string>();

  for (const [index, tile] of tiles.entries()) {
    keep.add(tile.uid);
    const node = ensureTileNode(tile.uid);
    patchTile(node, tile, units, elevWindow, youM);
    const atIndex = listEl.querySelectorAll('.stationDetail')[index];
    if (atIndex !== node) listEl.insertBefore(node, atIndex ?? null);
  }

  for (const node of listEl.querySelectorAll('.stationDetail')) {
    if (!keep.has(node.id)) node.remove();
  }

  if (tiles.length === 0) {
    if (feedOnline === null) {
      setEmpty('wait for data');
    } else if (feedOnline === false) {
      setEmpty('Wind unavailable · retrying');
    } else if (partialFailureCount > 0 || coverageLimited) {
      setEmpty('No recent wind loaded · search incomplete');
    } else {
      setEmpty('no recent wind nearby');
    }
  } else {
    setEmpty(null);
  }
}

function clearTiles(): void {
  for (const node of listEl.querySelectorAll('.stationDetail')) {
    node.remove();
  }
}

function scheduleFeedRetry(): void {
  if (!pageIsVisible() || feedRetryTimer !== null) return;
  feedRetryTimer = window.setTimeout(() => {
    feedRetryTimer = null;
    void pollFeed();
  }, FEED_RETRY_MS);
}

function markFeedFailed(): void {
  for (const entry of liveByUid.values()) entry.refreshFailed = true;
  setOnlineState(false);
  updateView();
  scheduleFeedRetry();
}

async function pollFeed(): Promise<void> {
  if (pollInFlight || !pageIsVisible()) return;
  refreshPosition(true);
  if (myPosition === null) {
    updateView();
    return;
  }

  clearFeedRetry();
  pollInFlight = true;
  requestController = new AbortController();
  try {
    const result = await loadNearbyWind(client,
      {
        position: myPosition,
        radiusKm: NEAR_RADIUS_KM,
        categories: parseCategories(),
        maxAgeMs: parseMaxAgeMs(),
      },
      { timeoutMs: FEED_TIMEOUT_MS, signal: requestController.signal },
    );
    if (result.catalogueError) {
      // Hidden: keep last good tiles; resume polls. Do not arm a background retry.
      if (pageIsVisible()) markFeedFailed();
      return;
    }
    const candidates = new Set(result.candidateUids);
    const failed = new Set(result.failedUids);
    const refreshed = new Set(result.observations.map(entry => entry.station.id));
    for (const [uid, entry] of liveByUid) {
      // Keep only failed candidates' last good observations, with their ORIGINAL
      // time anchor. A successful expiry or new search never resurrects old data.
      if (!candidates.has(uid) || (!failed.has(uid) && !refreshed.has(uid)) ||
          observationAgeMs(entry) > parseMaxAgeMs()) liveByUid.delete(uid);
      else entry.refreshFailed = failed.has(uid);
    }
    for (const entry of result.observations) {
      if (observationAgeMs(entry) <= parseMaxAgeMs()) {
        liveByUid.set(entry.station.id, { ...entry, refreshFailed: false });
      } else liveByUid.delete(entry.station.id);
    }
    partialFailureCount = failed.size;
    coverageLimited = result.coverageLimited;
    setOnlineState(result.feedErrors.length === 0);
    if (result.feedErrors.length > 0) scheduleFeedRetry();
    updateView();
  } catch {
    // pagehide abort (and any hard throw). Quiet if we are no longer on screen.
    if (!pageIsVisible() || requestController?.signal.aborted) return;
    markFeedFailed();
  } finally {
    requestController = null;
    pollInFlight = false;
  }
}

async function bootstrap(): Promise<void> {
  applySizeFactor();
  applyDarkMode();
  bindAltSlider();
  setOnlineState(null);
  startGeolocationFallback();
  refreshPosition();
  updateView();
  startPolling();
  document.addEventListener('visibilitychange', () => {
    if (pageIsVisible()) {
      startGeolocationFallback();
      startPolling();
      refreshPosition();
      updateView();
      void pollFeed();
    } else {
      stopPolling();
    }
  });
  window.addEventListener('online', () => { void pollFeed(); });
  window.addEventListener('pagehide', () => { requestController?.abort(); });
  await pollFeed();
}

void bootstrap();
