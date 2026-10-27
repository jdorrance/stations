#!/usr/bin/env node
/**
 * Deterministic friendly shortName generator for catalogue overrides.
 *
 * Purpose: turn long vendor names into XCTrack-friendly labels (≤11 chars),
 * matching the curated Armenia style (place-first, noise stripped).
 *
 * Inputs: catalogue stations.json + existing overrides/stations.json
 * Outputs: merges shortName overrides (default: every US state/territory region)
 *
 * State regions are processed in parallel chunks, then uniquified globally.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHORT_NAME_MAX_LENGTH, parseStationOverrides } from '@stations/contracts';
import { REGIONS, coversPoint } from '@stations/geography';

const root = fileURLToPath(new URL('..', import.meta.url));
/** Sentinel: every station with country === 'US' (chunked by state region). */
const ALL_US = 'US';

const ABBREVIATIONS = [
  [/\bNational Seashore\b/gi, 'NS'],
  [/\bState Park\b/gi, 'SP'],
  [/\bNational\b/gi, 'Natl'],
  [/\bBattlefield\b/gi, 'Bfld'],
  [/\bMountains?\b/gi, 'Mtn'],
  [/\bTownship\b/gi, 'Twp'],
  [/\bMemorial\b/gi, 'Mem'],
  [/\bInternational\b/gi, 'Intl'],
  [/\bMunicipal\b/gi, 'Muni'],
  [/\bRegional\b/gi, 'Reg'],
  [/\bExecutive\b/gi, 'Exec'],
  [/\bUniversity\b/gi, 'Univ'],
  [/\bInstitute\b/gi, 'Inst'],
  [/\bResearch\b/gi, 'Res'],
  [/\bCent(?:er|re)s?\b/gi, 'Ctr'],
  [/\bStation\b/gi, 'Stn'],
  [/\bAirport\b/gi, 'Apt'],
  [/\bHeliport\b/gi, 'Heli'],
  [/\bAirfield\b/gi, 'Fld'],
  [/\bCounty\b/gi, 'Co'],
  [/\bIslands?\b/gi, 'Is'],
  [/\bBridge\b/gi, 'Br'],
  [/\bCreek\b/gi, 'Crk'],
  [/\bRiver\b/gi, 'Riv'],
  [/\bValley\b/gi, 'Vly'],
  [/\bRidge\b/gi, 'Rdg'],
  [/\bHills?\b/gi, 'Hl'],
  [/\bLakes?\b/gi, 'Lk'],
  [/\bSprings?\b/gi, 'Spg'],
  [/\bHeights\b/gi, 'Hts'],
  [/\bBeach\b/gi, 'Bch'],
  [/\bPoint\b/gi, 'Pt'],
  [/\bHarbou?r\b/gi, 'Hbr'],
  [/\bLanding\b/gi, 'Lndg'],
  [/\bPeninsula\b/gi, 'Pen'],
  [/\bReservoir\b/gi, 'Rsvr'],
  [/\bBranch\b/gi, 'Br'],
  [/\bDrawbridge\b/gi, 'Drwbr'],
  [/\bFoundation\b/gi, 'Fnd'],
  [/\bHeadquarters\b/gi, 'Headqtrs'],
  [/\bPrincess\b/gi, 'Pr'],
  [/\bUpper\b/gi, 'U'],
  [/\bLower\b/gi, 'L'],
  [/\bGreater\b/gi, ''],
  [/\bCollege\b/gi, 'Coll'],
  [/\bPark\b/gi, 'Pk'],
  [/\b(?:Saint|St\.?)\b/gi, 'St'],
  [/\bMount\b/gi, 'Mt'],
  [/\bFort\b/gi, 'Ft'],
  [/\bButte\b/gi, 'Bte'],
  [/\bRanch\b/gi, 'Rnch'],
  [/\bHorse\b/gi, 'Hrs'],
  [/\bFalls\b/gi, 'Fls'],
  [/\bGlacier\b/gi, 'Glcr'],
  [/\bComplex\b/gi, 'Cplx'],
  [/\bCorners?\b/gi, 'Crn'],
  [/\bLakefront\b/gi, 'Lkfr'],
  [/\bFountains?\b/gi, 'Fount'],
  [/(?<=[A-Za-z])fields?\b/gi, 'fld'],
];

const KEEP_UPPER = new Set([
  'NB',
  'SB',
  'EB',
  'WB',
  'US',
  'MD',
  'VA',
  'WV',
  'NWS',
  'AFB',
  'AAF',
  'RWIS',
  'VT',
  'UVA',
  'SP',
  'NS',
  'NAS',
  'NB',
  'CR',
  'SR',
]);

const GENERIC = new Set([
  'the',
  'near',
  'at',
  'on',
  'of',
  'site',
  'us',
  'md',
  'va',
  'wv',
  'b',
  'i',
  'is',
  'co',
  'nb',
  'and',
  'raws',
  'nws',
  'blm',
  'usgs',
  'sce',
  'fswn',
  'mesonet',
  'hq',
  'rt',
  'pc',
  'mi',
  'cdf',
  'nerrs',
  'uscrn',
]);

const AGENCY_PREFIX =
  /^(?:SCE|FSWN|BLM|USGS|NERRS|USCRN|CDF|MESONET|ODOT|MDDOT|CDOT|INDOT|TxDOT)\s+/i;

const ROUTE_AT =
  /^(I-\d+[A-Z]?|C-\d+|CR-\d+|SR-\d+|US\s*\d+|MD-\d+|VA-\d+|WV-\d+|CO-\d+|CA-\d+|NY-\d+|TX-\d+|MD\s+\d+|US\s+\d+|VA\s+\d+|WV\s+\d+|\d{1,3}(?:[ENSW]B)?)\b.*?(?:\bat\b|@|\bon\b)\s+(.+)$/i;

/** "0.6 mi E of Frisco" / "1.4W OF MCCASLIN RD" / "2.4 N of WCR-34" */
const DISTANCE_OF =
  /^\d+(?:\.\d+)?\s*(?:mi(?:le)?s?)?\s*[NSEW]{1,3}\s+(?:of\s+)?(.+)$/i;

export function titleCase(value) {
  return value.replace(/[A-Za-z0-9']+/g, (word) => {
    const upper = word.toUpperCase();
    if (/^I-\d+[A-Z]?$/i.test(word)) return `I-${word.split('-')[1].toUpperCase()}`;
    if (/^(US|MD|VA|WV)-\d+$/i.test(word)) {
      const [a, b] = word.split('-');
      return `${a.toUpperCase()}-${b}`;
    }
    if (KEEP_UPPER.has(upper)) return upper;
    return word[0].toUpperCase() + word.slice(1).toLowerCase();
  });
}

function stripCallsign(name) {
  return name
    .replace(/^CWOP\s+/i, '')
    .replace(/^[A-Z]{1,2}\d[A-Z]{1,3}(?:-\d+)?\s+/i, '')
    .replace(/^(?:GW|FW|DW|EW|CW|KW|KB|KN)\d+\s+/i, '')
    .replace(/^\d{7}\s*-\s*/, '');
}

function callsignOnlyLabel(name) {
  const trimmed = name.trim();
  // "CWOP GW5845" / bare APRS ids — keep the callsign, not "Cwop".
  const fromCwop = trimmed.match(/^CWOP\s+([A-Z0-9-]{3,11})$/i);
  if (fromCwop) return fromCwop[1].toUpperCase();
  if (/^[A-Z]{1,2}\d[A-Z0-9-]{1,8}$/i.test(trimmed)) return trimmed.toUpperCase().slice(0, SHORT_NAME_MAX_LENGTH);
  return null;
}

export function stripNoise(name) {
  let n = name.trim().replace(/\s+/g, ' ');
  n = stripCallsign(n);
  n = n.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  n = n.replace(AGENCY_PREFIX, '');
  // Leading CoCoRaHS-style offset: "3 WNW WOFFORD HEIGHTS"
  n = n.replace(/^\d+\s*[NSEW]{1,3}\s+/i, '');
  // CDOT-style route sensor id: "070E217 US 6 LOVELAND PASS"
  if (/^\d{2,3}[ENSW]\d{3,}\w*\s+/i.test(n)) {
    n = n.replace(/^\d{2,3}[ENSW]\d{3,}\w*\s+/i, '');
    // Drop a following highway designator only when no junction marker remains.
    if (!/(?:\bat\b|@)/i.test(n)) {
      n = n.replace(/^(?:US|SH|SR|CO|CA|NY|TX|MD|VA|WV|I)\s*-?\s*\d+[A-Z]?\s+/i, '');
    }
  }
  n = n.replace(/\s+K[A-Z0-9]{3}$/i, '');
  // Trailing FAA/club codes ("-8W2", "-RMPHA"), not pure numeric route suffixes ("I-65", "CR-82").
  n = n.replace(/\s*-\s*(?=[A-Z0-9]*[A-Za-z])[A-Z0-9]{2,8}$/i, '');
  // Trailing "MD US MDDOT" / "VA US" noise — require a real state code, not "at US-24".
  n = n.replace(
    /\s+(?:AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\s+US(?:\s+[A-Z]+)?.*$/i,
    '',
  );
  n = n.replace(/,\s*[A-Z]{2},\s*US$/i, '');
  n = n.replace(/,\s*[A-Z]{2}$/i, '');
  n = n.replace(/,\s*US$/i, '');
  // "Gruver TX 8.25SW" / "Stinnett TX 1.75ESE"
  n = n.replace(
    /\s+(?:AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|IA|ID|IL|IN|KS|KY|LA|MA|MD|ME|MI|MN|MO|MS|MT|NC|ND|NE|NH|NJ|NM|NV|NY|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VA|VT|WA|WI|WV|WY)\s+\d+(?:\.\d+)?\s*[NSEW]{1,3}$/i,
    '',
  );
  // Drop trailing mileposts, including "@ MP 36" left after a place name.
  n = n.replace(/\s*(?:at|@)?\s*MP\s*[\d.]+$/i, '');
  n = n.replace(/\s+\d+(?:\.\d+)?\s*[NSEW]{1,3}$/i, '');
  // Trailing pole/sensor numbers: "Pole 15"
  n = n.replace(/\s+(?:Nb|Sb|Eb|Wb)?\s*Pole\s+\d+$/i, '');
  // Trailing network noise: "CDF RAWS", "AG MESONET"
  n = n.replace(/\s+(?:CDF\s+)?RAWS$/i, '');
  n = n.replace(/\s+(?:AG\s+)?MESONET$/i, '');
  n = n.replace(/\s+PORTABLE(?:\s+#?\d+)?$/i, '');
  return n.replace(/^[\s\-/ ,]+|[\s\-/ ,]+$/g, '');
}

/** Compass/offset token from the original name, used to disambiguate collisions. */
export function extractCompassHint(name) {
  const match = name.match(/\b(\d+(?:\.\d+)?)\s*([NSEW]{1,3})\b/i);
  if (!match) return null;
  const dir = match[2].toUpperCase();
  if (!/^[NSEW]{1,3}$/.test(dir)) return null;
  return dir;
}

function preferDashPlace(name) {
  // Split on " - " only so route ids like SR-99 stay intact.
  if (!/\s-\s/.test(name)) return null;
  const parts = name
    .split(/\s-\s/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const noisy = /^(?:CDF|RAWS|NWS|Coop|RTR|NB|SB|EB|WB|Median)\b/i;
  const routeish = /^(?:I-?\d+|US-?\d+|SR-?\d+|T\.H\.|U\.S\.|N-\d+|MP\b)/i;
  const candidates = parts.filter((part) => !noisy.test(part) && !/^MP\s*[\d.]+$/i.test(part));
  if (candidates.length === 0) return null;
  // Prefer a non-route place segment when the left side is a highway id.
  if (routeish.test(candidates[0]) && candidates.length > 1) {
    return candidates.find((part) => !routeish.test(part)) ?? candidates[1];
  }
  // Prefer a longer/more specific right-hand place over a short left town when present.
  if (candidates.length >= 2 && candidates[0].length <= 10 && candidates[1].length >= 8) {
    return candidates[1];
  }
  return null;
}

function compressJunction(left, right) {
  const a = left.replace(/\s+/g, '');
  const b = right.replace(/\s+/g, '');
  const compact = `${a}/${b}`;
  if (compact.length <= SHORT_NAME_MAX_LENGTH) return compact;
  // Prefer the non-Interstate landmark when one side must go.
  if (/^I-\d+/i.test(a) && !/^I-\d+/i.test(b) && b.length <= SHORT_NAME_MAX_LENGTH) return b;
  if (/^I-\d+/i.test(b) && !/^I-\d+/i.test(a) && a.length <= SHORT_NAME_MAX_LENGTH) return a;
  return a.slice(0, SHORT_NAME_MAX_LENGTH);
}

function pickPlace(name) {
  const distance = name.match(DISTANCE_OF);
  if (distance) {
    let landmark = distance[1].trim();
    // "CO-91 Copper Mtn" → prefer the place words after a route id.
    const afterRoute = landmark.match(
      /^(?:I-\d+[A-Z]?|[A-Z]{1,2}-?\d+)\s+(.+)$/i,
    );
    if (afterRoute) landmark = afterRoute[1];
    landmark = stripNoise(landmark);
    if (!landmark) landmark = stripNoise(distance[1]);
    return landmark;
  }

  const route = name.match(ROUTE_AT);
  if (route) {
    let landmark = route[2].trim();
    // "I-17 @ MP-306: Stoneman Lake" / "277.9: Oxtail Draw" / "MP 386 Willie Spring"
    landmark = landmark.replace(/^MP-?\d+(?:\.\d+)?:\s*/i, '');
    landmark = landmark.replace(/^MP\s*[\d.]+\s+/i, '');
    landmark = landmark.replace(/^[\d.]+:\s*/, '');
    landmark = stripNoise(landmark);
    if (/^(I-\d+[A-Z]?|C-\d+|CR-\d+|SR-\d+|US\s*-?\d+|[A-Z]{2}-\d+)/i.test(landmark)) {
      return compressJunction(route[1], landmark);
    }
    return landmark;
  }
  const nearMatches = [...name.matchAll(/\bNEAR\b\s+/gi)];
  if (nearMatches.length > 0) {
    const last = nearMatches[nearMatches.length - 1];
    return stripNoise(name.slice(last.index + last[0].length));
  }
  // "Alaska Hwy @ Dot Lake MP …" — `@` is non-word so avoid \b around it.
  const atOrOn = name.match(/(?:\bat\b|@)\s+(.+)$/i);
  if (atOrOn && name.length > 18) {
    let landmark = atOrOn[1].replace(/^[\d.]+:\s*/, '');
    // "US-191 at MP 386 Willie Spring" → Willie Spring
    landmark = landmark.replace(/^MP\s*[\d.]+\s+/i, '');
    landmark = stripNoise(landmark);
    // "Mountain Parkway @ MP 36" — milepost-only landmarks are not place names.
    if (!landmark || /^MP\b/i.test(landmark) || /^[\d.]+$/.test(landmark)) {
      return stripNoise(name.slice(0, atOrOn.index).replace(/\s*(?:at|@)\s*$/i, ''));
    }
    return landmark;
  }
  return name;
}

function isAirportish(name) {
  return /\b(Airport|Heliport|Airfield|Aerodrome|AAF|AFB|Joint Base|Muni|Arpt|Intl|Rgnl|NAS|Naval Air Facility|Air Facility)\b/i.test(
    name,
  );
}

function cleanAirport(name) {
  let n = name.replace(/^Joint Base\s+/i, '');
  n = n.replace(
    /\b(Municipal|Regional|International|Memorial|Executive|Army Airfield|Air Force Base|Washington|Authority|State)\b/gi,
    '',
  );
  n = n.replace(
    /\b(Airport|Heliport|Airfield|Aerodrome|AAF|AFB|Muni|Arpt|Intl|Rgnl|NAS|Cnty|Naval Academy|Trapnell Field|Naval Air Facility|Air Facility)\b/gi,
    '',
  );
  n = n.replace(/\b(?:County|Region)\b/gi, '');
  n = n.replace(/\s+/g, ' ').replace(/^[\s\-/ ,]+|[\s\-/ ,]+$/g, '');
  if (n.includes('/')) n = n.split('/')[0].trim();
  if (n.includes(',')) n = n.split(',')[0].trim();
  if (n.includes('-') && !/^[A-Z]{1,2}-\d+/i.test(n)) {
    const left = n.split('-')[0].trim();
    if (left.length >= 4) n = left;
  }
  return n;
}

export function fitLabel(label, { preferApt = false } = {}) {
  let cur = titleCase(label.replace(/\s+/g, ' ').replace(/^[\s\-/ ,]+|[\s\-/ ,]+$/g, ''));
  if (preferApt && !/\bApt\b/.test(cur) && cur.length <= 8) {
    const withApt = `${cur} Apt`;
    if (withApt.length <= SHORT_NAME_MAX_LENGTH) cur = withApt;
  }
  if (cur.length <= SHORT_NAME_MAX_LENGTH) return cur;

  for (const [pattern, replacement] of ABBREVIATIONS) {
    const next = cur
      .replace(pattern, replacement)
      .replace(/\s+/g, ' ')
      .replace(/^[\s\-/ ,]+|[\s\-/ ,]+$/g, '');
    if (next.length < cur.length) {
      cur = /\d/.test(next) ? next : titleCase(next);
    }
    if (cur.length <= SHORT_NAME_MAX_LENGTH) return cur;
  }

  let words = cur.split(/\s+/).filter(Boolean);
  // Drop trailing generic landform last: keep "Diamond Vly" over "Diamond".
  const trailingGeneric = /^(?:Lk|Riv|Crk|Pk|Spg|Hts|Bch|Pt|Hl|Bte|Rnch|Hrs|Fls|Glcr|Cplx|Rdg|Vly|Is|Br|Mtn)$/i;
  while (words.join(' ').length > SHORT_NAME_MAX_LENGTH && words.length > 2) {
    if (trailingGeneric.test(words[words.length - 1])) words.pop();
    else words.splice(1, 1);
  }
  cur = words.join(' ');
  if (cur.length <= SHORT_NAME_MAX_LENGTH) return cur;

  // Prefer first+last over collapsing to a single opaque token.
  if (words.length >= 2) {
    const pair = `${words[0]} ${words[words.length - 1]}`;
    if (pair.length <= SHORT_NAME_MAX_LENGTH) return pair;
  }

  while (words.join(' ').length > SHORT_NAME_MAX_LENGTH && words.length > 1) {
    // Prefer dropping a trailing generic over the head place name; otherwise
    // keep the leading place token (Seven Fountains → keep Seven…).
    if (trailingGeneric.test(words[words.length - 1])) words = words.slice(0, -1);
    else words = words.slice(0, -1);
  }
  cur = words.join(' ');
  if (cur.length <= SHORT_NAME_MAX_LENGTH) return cur;
  return cur.slice(0, SHORT_NAME_MAX_LENGTH).replace(/[\s\-/]+$/g, '');
}

function fallbackFromName(name, nativeId) {
  const tokens = (name.match(/[A-Za-z][A-Za-z']+/g) ?? []).filter(
    (token) => !GENERIC.has(token.toLowerCase()),
  );
  if (tokens.length > 0) return fitLabel(tokens.slice(0, 2).join(' '));
  return String(nativeId).slice(0, SHORT_NAME_MAX_LENGTH);
}

/** Derive a place-like shortName from a vendor station name (not yet uniquified). */
export function deriveShortName(name, nativeId = 'station') {
  const callsign = callsignOnlyLabel(name);
  if (callsign) return callsign;

  const dashPlace = preferDashPlace(name);
  let n = stripNoise(dashPlace ?? name);
  if (isAirportish(n) || isAirportish(name)) {
    const cleaned = cleanAirport(stripNoise(name));
    const label = fitLabel(cleaned, { preferApt: true });
    // "Washington County Airport" can collapse to "Apt" after stripping County.
    if (label.length >= 3 && !/^Apt$/i.test(label.trim())) return label;
    return fallbackFromName(name, nativeId);
  }

  n = stripNoise(pickPlace(n));

  if (n.includes('/')) {
    const parts = n
      .split('/')
      .map((part) => part.trim())
      .filter(Boolean);
    const routePart = (value) =>
      /^(I-\d+[A-Z]?|C-\d+|CR-\d+|SR-\d+|US\s*\d+|[A-Z]{2}-\d+)$/i.test(value);
    // Keep compact junctions like I-94/I-65.
    if (!(parts.length === 2 && parts.every(routePart))) {
      parts.sort((a, b) => {
        const score = (value) =>
          /\b(Lake|Mount|Mt\.?|River|Gap|Ridge|Knob|Dam|Bridge|Park|Butte|Ranch|Horse)\b/i.test(
            value,
          )
            ? 0
            : 1;
        return score(a) - score(b) || a.length - b.length;
      });
      n = parts[0] ?? n;
    }
  }

  n = n.replace(/^(?:USCRN|CB NERRS|NERRS)\b.*?\bAT\b\s+/i, '');
  n = n.replace(/^(?:USCRN|CB NERRS)\s+SITE\s+/i, '');
  n = n.replace(/\b(?:Env(?:ironmental)?)?\s*RAWS\b/gi, '');
  n = n.replace(/\s+(?:AG\s+)?MESONET\b/gi, '');
  n = n.replace(/\s+-\s+(?:Coop|Heliport|NWS|CDF|RAWS).*$/i, '');
  // Keep dash places already chosen; otherwise drop trailing dash noise.
  if (!dashPlace) n = n.replace(/\s+-\s+.*$/, '');
  n = n.replace(/\bAssateague Island(?: National Seashore)?\b/gi, 'Assateague');
  n = n.replace(/\bCatoctin Mountain\b/gi, 'Catoctin');
  n = n.replace(/\bVirginia Beach\b/gi, 'Va Beach');
  n = n.replace(/\s+/g, ' ').replace(/^[\s\-/ ,]+|[\s\-/ ,]+$/g, '');

  let label = fitLabel(n);
  if (!label || label.length < 3 || GENERIC.has(label.toLowerCase())) {
    label = fallbackFromName(name, nativeId);
  }
  return label;
}

function withCompass(base, compass) {
  if (!compass) return null;
  const room = SHORT_NAME_MAX_LENGTH - compass.length - 1;
  if (room < 3) return null;
  const head = base.slice(0, room).replace(/[\s\-/]+$/g, '');
  if (head.length < 3) return null;
  return `${head} ${compass}`;
}

export function uniquifyShortNames(entries, reserved = new Set()) {
  const used = new Set([...reserved].map((value) => value.toLowerCase()));
  const out = [];
  for (const entry of entries) {
    const base = entry.shortName;
    const compass = entry.compassHint ? withCompass(base, entry.compassHint) : null;
    let label = base;
    let n = 2;
    while (used.has(label.toLowerCase())) {
      if (n === 2 && compass && !used.has(compass.toLowerCase())) {
        label = compass;
        break;
      }
      const suffix = String(n);
      label = `${base.slice(0, SHORT_NAME_MAX_LENGTH - suffix.length).replace(/[\s\-/]+$/g, '')}${suffix}`;
      n += 1;
    }
    used.add(label.toLowerCase());
    out.push({ ...entry, shortName: label });
  }
  return out;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function resolveTargetRegions(stations, regionsArg) {
  if (regionsArg.length === 1 && regionsArg[0] === ALL_US) {
    const found = new Set();
    for (const station of stations) {
      if (station.country === 'US' && station.region) found.add(station.region);
    }
    return [...found].sort();
  }
  return regionsArg;
}

function isUsStation(station, { includeUnscoped = false } = {}) {
  if (station.country === 'US') return true;
  // WU/CWOP/WeatherLink often ship with null country; include by US coverage.
  if (!includeUnscoped) return false;
  if (station.country != null && station.country !== 'US') return false;
  return coversPoint(REGIONS.US.coverage, {
    latitude: station.latitude,
    longitude: station.longitude,
  });
}

function chunkStationsByRegion(stations, regions, { includeUnscoped = false } = {}) {
  const wanted = new Set(regions);
  const chunks = new Map(regions.map((region) => [region, []]));
  if (includeUnscoped) chunks.set('_', []);
  for (const station of stations) {
    if (!isUsStation(station, { includeUnscoped })) continue;
    if (!station.region) {
      if (includeUnscoped) chunks.get('_').push(station);
      continue;
    }
    if (station.country === 'US' && !wanted.has(station.region)) continue;
    // Unscoped-but-in-US-coverage stations may carry a region from another pass; keep them.
    if (station.country == null && !wanted.has(station.region) && includeUnscoped) {
      chunks.get('_').push(station);
      continue;
    }
    if (!wanted.has(station.region)) continue;
    if (!chunks.has(station.region)) chunks.set(station.region, []);
    chunks.get(station.region).push(station);
  }
  if ((chunks.get('_') ?? []).length === 0) chunks.delete('_');
  return chunks;
}

/** Generate shortName proposals for one region chunk (no global uniquify). */
export function generateRegionChunk(stations) {
  return stations
    .slice()
    .sort((a, b) => a.uid.localeCompare(b.uid))
    .map((station) => ({
      uid: station.uid,
      region: station.region,
      vendor: station.vendor,
      name: station.name,
      shortName: deriveShortName(station.name, station.nativeId),
      compassHint: extractCompassHint(station.name),
    }));
}

export async function generateShortNamesForRegions(
  stations,
  regions,
  { concurrency = 8, includeUnscoped = false } = {},
) {
  const chunks = chunkStationsByRegion(stations, regions, { includeUnscoped });
  const regionList = [...chunks.keys()];
  const results = [];
  for (let i = 0; i < regionList.length; i += concurrency) {
    const batch = regionList.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (region) => {
        // Yield so region chunks truly run concurrently under the event loop.
        await Promise.resolve();
        return generateRegionChunk(chunks.get(region) ?? []);
      }),
    );
    for (const chunk of batchResults) results.push(...chunk);
  }
  results.sort((a, b) => a.uid.localeCompare(b.uid));
  return results;
}

function mergeOverrides(existing, generated) {
  const stations = { ...existing.stations };
  for (const entry of generated) {
    const prior = stations[entry.uid] ?? {};
    stations[entry.uid] = { ...prior, shortName: entry.shortName };
  }
  return {
    schemaVersion: existing.schemaVersion ?? 1,
    stations,
  };
}

function parseArgs(argv) {
  const args = {
    regions: [ALL_US],
    catalogue: resolve(root, 'data/catalogue/stations.json'),
    overrides: resolve(root, 'data/overrides/stations.json'),
    samplesPath: resolve(root, '.cache/shortname-samples.json'),
    write: true,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--regions') args.regions = argv[++i].split(',').map((v) => v.trim().toUpperCase());
    else if (arg === '--catalogue') args.catalogue = resolve(argv[++i]);
    else if (arg === '--overrides') args.overrides = resolve(argv[++i]);
    else if (arg === '--dry-run') {
      args.dryRun = true;
      args.write = false;
    } else if (arg === '--help') args.help = true;
  }
  return args;
}

function sampleReport(generated, { perRegion = 3, oddLimit = 40 } = {}) {
  const byRegion = new Map();
  const odd = [];
  for (const row of generated) {
    const list = byRegion.get(row.region) ?? [];
    if (list.length < perRegion) {
      list.push({ shortName: row.shortName, name: row.name, vendor: row.vendor });
      byRegion.set(row.region, list);
    }
    if (
      row.shortName.length < 3 ||
      GENERIC.has(row.shortName.toLowerCase()) ||
      !/[A-Za-z]{2}/.test(row.shortName) ||
      /^\d/.test(row.shortName)
    ) {
      if (odd.length < oddLimit) odd.push(row);
    }
  }
  return {
    byRegion: Object.fromEntries(
      [...byRegion.entries()].sort(([a], [b]) => String(a ?? '_').localeCompare(String(b ?? '_'))),
    ),
    numbered: generated.filter((row) => /\d+$/.test(row.shortName)).length,
    odd: odd.map((row) => ({
      uid: row.uid,
      shortName: row.shortName,
      name: row.name,
      region: row.region,
    })),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/generate-shortnames.mjs [--regions US|VA,MD,WV] [--dry-run]
Generates ≤${SHORT_NAME_MAX_LENGTH}-char shortNames and merges into overrides.
Default --regions US covers every US state/territory region in the catalogue.`);
    return;
  }

  const catalogue = loadJson(args.catalogue);
  const stations = catalogue.stations ?? catalogue;
  const existing = loadJson(args.overrides);
  parseStationOverrides(existing);

  const allUs = args.regions.length === 1 && args.regions[0] === ALL_US;
  const targetRegions = resolveTargetRegions(stations, args.regions);
  const proposed = await generateShortNamesForRegions(stations, targetRegions, {
    includeUnscoped: allUs,
  });
  const targetUids = new Set(proposed.map((row) => row.uid));

  const reserved = new Set(
    Object.entries(existing.stations)
      .filter(([uid]) => !targetUids.has(uid))
      .map(([, value]) => value.shortName)
      .filter(Boolean),
  );

  const generated = uniquifyShortNames(proposed, reserved);

  for (const entry of generated) {
    if (entry.shortName.length < 1 || entry.shortName.length > SHORT_NAME_MAX_LENGTH) {
      throw new Error(`Invalid shortName for ${entry.uid}: ${entry.shortName}`);
    }
  }

  const merged = mergeOverrides(existing, generated);
  parseStationOverrides(merged);

  const report = {
    regions: allUs ? [ALL_US, ...targetRegions] : targetRegions,
    generated: generated.length,
    overridesTotal: Object.keys(merged.stations).length,
    ...sampleReport(generated),
  };
  writeFileSync(args.samplesPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        regions: report.regions.slice(0, allUs ? 1 : undefined),
        stateCount: targetRegions.length,
        generated: report.generated,
        overridesTotal: report.overridesTotal,
        numbered: report.numbered,
        oddCount: report.odd.length,
        samplesPath: args.samplesPath,
        sampleStates: Object.fromEntries(Object.entries(report.byRegion).slice(0, 8)),
        odd: report.odd.slice(0, 15),
      },
      null,
      2,
    ),
  );

  if (args.write) {
    writeFileSync(args.overrides, `${JSON.stringify(merged, null, 2)}\n`);
    console.error(`Wrote ${generated.length} shortNames → ${args.overrides}`);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
