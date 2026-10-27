import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadDotEnv } from './workspace.mjs';

loadDotEnv();

export const AVIATIONWX_API_BASE_URL = 'https://api.aviationwx.org/v1/airports';
export const WU_UPLOAD_URL =
  'https://weatherstation.wunderground.com/weatherstation/updateweatherstation.php';

const KNOTS_TO_MPH = 1.15077945;

function formatWuDateUtc(isoString) {
  const ms = Date.parse(isoString);
  if (!Number.isFinite(ms)) return 'now';
  const d = new Date(ms);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function buildWuUploadUrl(aviationWxPayload, stationId, password) {
  const w = aviationWxPayload?.weather;
  if (!w || typeof w !== 'object') {
    throw new Error('AviationWX response is missing weather object');
  }

  const url = new URL(WU_UPLOAD_URL);
  url.searchParams.set('ID', stationId);
  url.searchParams.set('PASSWORD', password);
  url.searchParams.set(
    'dateutc',
    formatWuDateUtc(w.observation_time ?? aviationWxPayload?.meta?.observation_time),
  );

  if (typeof w.wind_speed === 'number' && Number.isFinite(w.wind_speed) && w.wind_speed >= 0) {
    url.searchParams.set('windspeedmph', (w.wind_speed * KNOTS_TO_MPH).toFixed(1));
  }
  if (typeof w.gust_speed === 'number' && Number.isFinite(w.gust_speed) && w.gust_speed >= 0) {
    url.searchParams.set('windgustmph', (w.gust_speed * KNOTS_TO_MPH).toFixed(1));
  }
  const dirTrue = w.wind_direction?.true_north ?? w.wind_direction?.magnetic_north;
  if (typeof dirTrue === 'number' && Number.isFinite(dirTrue) && dirTrue >= 0 && dirTrue <= 360) {
    url.searchParams.set('winddir', String(Math.round(dirTrue % 360)));
  }

  const tempF =
    typeof w.temperature_f === 'number' && Number.isFinite(w.temperature_f)
      ? w.temperature_f
      : typeof w.temperature === 'number' && Number.isFinite(w.temperature)
        ? (w.temperature * 9) / 5 + 32
        : null;
  if (tempF !== null) {
    url.searchParams.set('tempf', tempF.toFixed(1));
  }

  const dewF =
    typeof w.dewpoint_f === 'number' && Number.isFinite(w.dewpoint_f)
      ? w.dewpoint_f
      : typeof w.dewpoint === 'number' && Number.isFinite(w.dewpoint)
        ? (w.dewpoint * 9) / 5 + 32
        : null;
  if (dewF !== null) {
    url.searchParams.set('dewptf', dewF.toFixed(1));
  }

  if (typeof w.humidity === 'number' && Number.isFinite(w.humidity)) {
    url.searchParams.set('humidity', String(Math.round(w.humidity)));
  }
  if (typeof w.pressure === 'number' && Number.isFinite(w.pressure) && w.pressure > 20) {
    url.searchParams.set('baromin', w.pressure.toFixed(2));
  }
  if (typeof w.precip_accum === 'number' && Number.isFinite(w.precip_accum) && w.precip_accum >= 0) {
    url.searchParams.set('dailyrainin', w.precip_accum.toFixed(2));
  }

  url.searchParams.set('softwaretype', 'stations-aviationwx-bridge/1.0');
  url.searchParams.set('action', 'updateraw');
  return url;
}

export async function forwardAviationWxOnce(options = {}) {
  const airportId = (options.airport ?? 'wn55').toLowerCase();
  const stationId = options.stationId ?? process.env.WU_STATION_ID ?? '';
  const password = options.password ?? process.env.WU_STATION_PASSWORD ?? '';
  const dryRun = Boolean(options.dryRun || !stationId || !password);
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const sourceUrl = `${AVIATIONWX_API_BASE_URL}/${encodeURIComponent(airportId)}/weather`;
  const res = await fetchImpl(sourceUrl, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(`AviationWX ${airportId} returned HTTP ${res.status}`);
  }
  const payload = await res.json();
  const uploadUrl = buildWuUploadUrl(
    payload,
    stationId || 'YOUR_WU_STATION_ID',
    password || 'YOUR_WU_STATION_KEY',
  );

  if (dryRun) {
    const redacted = new URL(uploadUrl.href);
    if (password) redacted.searchParams.set('PASSWORD', '***');
    console.log(`[dry-run] Fetched live weather from https://${airportId}.aviationwx.org/ (${payload.meta?.airport_name ?? airportId})`);
    console.log(`[dry-run] WU upload URL: ${redacted.href}`);
    if (!stationId || !password) {
      console.log(
        '\nTo push live to Weather Underground and unlock your personal WU_API_KEY:\n' +
          '  1. Go to https://www.wunderground.com/member/devices/new and register a PWS\n' +
          '     (e.g. Location: 46.5115, -122.0062, Elevation: 893 ft for WN55 Randle-Kiona Airpark)\n' +
          '  2. Add WU_STATION_ID=... and WU_STATION_PASSWORD=... to .env\n' +
          '  3. Run: pnpm wu:bridge --watch',
      );
    }
    return { status: 'dry-run', uploadUrl: redacted.href, observation: payload.weather };
  }

  const wuRes = await fetchImpl(uploadUrl.href, {
    signal: AbortSignal.timeout(8_000),
  });
  const body = (await wuRes.text()).trim();
  console.log(
    `[wu-bridge] ${new Date().toISOString()} ${airportId.toUpperCase()} -> ${stationId}: HTTP ${wuRes.status} (${body})`,
  );
  return { status: wuRes.ok ? 'ok' : 'error', httpStatus: wuRes.status, body };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({
    options: {
      airport: { type: 'string', default: 'wn55' },
      'station-id': { type: 'string' },
      password: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      interval: { type: 'string', default: '60' },
    },
  });

  const runOnce = () =>
    forwardAviationWxOnce({
      airport: args.airport,
      stationId: args['station-id'],
      password: args.password,
      dryRun: args['dry-run'],
    });

  await runOnce();
  if (args.watch) {
    const intervalMs = Math.max(15, Number(args.interval) || 60) * 1_000;
    setInterval(() => {
      runOnce().catch(err => {
        console.error('[wu-bridge] error:', err instanceof Error ? err.message : String(err));
      });
    }, intervalMs);
  }
}
