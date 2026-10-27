import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';
import {
  CATALOGUE_SCHEMA_VERSION,
  applyStationOverrides,
  catalogueToGeoJson,
  defaultCategoryForVendor,
  enrichStationsWithLaunches,
  parseCatalogueStation,
  parseStationOverrides,
  serializeCatalogueNdjson,
  toPublicCatalogueStation,
  toPublicStationCatalogue,
} from '@stations/contracts';
import {
  INITIAL_SCOPE_REGIONS,
  coverageForRegions,
  coversPoint,
  isRegionCode,
  validPosition,
} from '@stations/geography';
import {
  INITIAL_SEED_STATIONS,
  PROVIDERS,
  createProviderFetch,
  filterCatalogueStations,
  isRecentObservation,
  loadStationFeed,
  mergeDiscoveredStations,
  resolveEnvironment,
  toStationConfigs,
  unwrapAggregatorStation,
} from '@stations/providers';
import { loadDotEnv } from './workspace.mjs';

loadDotEnv();
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_STATION_OVERRIDES_PATH = resolve(repositoryRoot, 'data/overrides/stations.json');

function loadStationOverrides(path = DEFAULT_STATION_OVERRIDES_PATH) {
  if (!existsSync(path)) return null;
  try {
    return parseStationOverrides(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid station overrides at ${path}: ${detail}`);
  }
}

function positiveDistance(raw, name) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`);
  return value;
}

function uniqueSelection(raw, guard, name) {
  const values = raw.split(',').map(value => value.trim());
  if (!values.length || values.some(value => !value || !guard(value))) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return [...new Set(values)];
}

function writeAtomic(path, bytes, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { mode, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
}

function slugify(name) {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function loadKnownLaunches() {
  const launches = [];
  const seenSlugs = new Set();

  const windgramsSitesPath = resolve(repositoryRoot, '../windgrams/forecasts/sites.json');
  if (existsSync(windgramsSitesPath)) {
    try {
      const parsed = JSON.parse(readFileSync(windgramsSitesPath, 'utf8'));
      for (const site of parsed.sites ?? []) {
        if (
          typeof site.slug === 'string' &&
          typeof site.name === 'string' &&
          validPosition(site) &&
          !seenSlugs.has(site.slug)
        ) {
          seenSlugs.add(site.slug);
          launches.push({
            slug: site.slug,
            name: site.name,
            latitude: site.latitude,
            longitude: site.longitude,
          });
        }
      }
    } catch {
      // Ignore if unreadable
    }
  }

  for (const code of ['us', 'ca', 'mx', 'am']) {
    const geoPath = resolve(repositoryRoot, `../flyingsites/data/${code}.geojson.json`);
    if (!existsSync(geoPath)) continue;
    try {
      const geo = JSON.parse(readFileSync(geoPath, 'utf8'));
      for (const feature of geo.features ?? []) {
        const coords = feature?.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) continue;
        const longitude = Number(coords[0]);
        const latitude = Number(coords[1]);
        if (!validPosition({ latitude, longitude })) continue;
        const rawName = String(feature?.properties?.name ?? '').trim() || 'Launch';
        const idSuffix = feature?.id ?? feature?.properties?.pge_site_id ?? '';
        let slug = `${code}-${slugify(rawName) || 'launch'}`;
        if (seenSlugs.has(slug)) {
          slug = `${slug}-${idSuffix || Math.round(Math.abs(latitude * 100))}`;
        }
        seenSlugs.add(slug);
        launches.push({
          slug,
          name: rawName,
          latitude,
          longitude,
        });
      }
    } catch {
      // Ignore if unreadable
    }
  }

  return launches;
}

/** Runs a crawl; injectable providers/launches keep regression tests entirely offline. */
export async function crawlCatalogue(options = {}) {
  const providers = options.providers ?? PROVIDERS;
  const regions = [...new Set(options.regions ?? INITIAL_SCOPE_REGIONS)];
  const vendors = [...new Set(options.vendors ?? Object.keys(providers))];
  if (!regions.length || regions.some(region => !isRegionCode(region))) throw new Error('Invalid crawl regions');
  if (!vendors.length || vendors.some(vendor => !Object.hasOwn(providers, vendor))) throw new Error('Invalid crawl vendors');
  const maxLaunchKm = positiveDistance(options.maxLaunchKm ?? 50, 'maxLaunchKm');
  const corridorKm = positiveDistance(options.corridorKm ?? 25, 'corridorKm');
  if (maxLaunchKm < corridorKm) throw new Error('maxLaunchKm must cover corridorKm');
  let outDir = resolve(options.output ?? 'data/catalogue');
  let cacheDir = resolve(options.cache ?? '.cache/stations-crawl');
  if (isWithin(outDir, cacheDir) || isWithin(cacheDir, outDir)) {
    throw new Error('Private crawl cache and public output must be separate directories');
  }
  mkdirSync(outDir, { recursive: true });
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  // Resolve ancestor symlinks as well as the roots themselves before writing any
  // checkpoint. Lexically separate paths can still name the same directory.
  outDir = realpathSync(outDir);
  cacheDir = realpathSync(cacheDir);
  if (isWithin(outDir, cacheDir) || isWithin(cacheDir, outDir)) {
    throw new Error('Private crawl cache and public output must be separate directories');
  }
  const seeds = options.seeds ?? INITIAL_SEED_STATIONS;
  const log = options.log ?? console.log;
  const credentials =
    options.credentials ??
    (!options.offline && !options.providers && !options.environment
      ? {
          tempestToken: process.env.TEMPEST_TOKEN,
          ecowittApplicationKey: process.env.ECOWITT_APP_KEY,
          ecowittApiKey: process.env.ECOWITT_API_KEY,
          holfuyApiKey: process.env.HOLFUY_API_KEY,
          wuApiKey: process.env.WU_API_KEY,
          synopticToken: process.env.SYNOPTIC_TOKEN,
          synopticApiKey: process.env.SYNOPTIC_API_KEY,
          ambientApiKey: process.env.AMBIENT_API_KEY,
          ambientApplicationKey: process.env.AMBIENT_APP_KEY,
        }
      : undefined);
  const baseEnvironment = resolveEnvironment(
    options.environment ??
      (options.offline
        ? undefined
        : {
            fetch: createProviderFetch({
              maxConcurrent: 6,
              minIntervalMs: 100,
              maxQueueSize: 500,
              origins: {
                'https://holfuy.com': { maxConcurrent: 24, minIntervalMs: 10 },
                'https://www.weatherlink.com': { maxConcurrent: 40, minIntervalMs: 5 },
                'https://weather.prod.avalanche.ca': { maxConcurrent: 15, minIntervalMs: 20 },
                'http://www.findu.com': { maxConcurrent: 12, minIntervalMs: 25 },
                'https://climatenet.am': { maxConcurrent: 10, minIntervalMs: 30 },
                'https://sierragliding.us': { maxConcurrent: 8, minIntervalMs: 30 },
                'https://api.synopticdata.com': { maxConcurrent: 6, minIntervalMs: 50 },
                'https://api.weather.com': { maxConcurrent: 20, minIntervalMs: 15 },
              },
            }),
          }),
  );
  const coverage = coverageForRegions(regions);
  const launches = (options.launches ?? loadKnownLaunches()).filter(launch =>
    typeof launch.slug === 'string' && launch.slug.length > 0 &&
    typeof launch.name === 'string' && launch.name.length > 0 &&
    validPosition(launch) && coversPoint(coverage, launch));
  log(`Loaded ${launches.length} launch locations in requested coverage.`);
  const generatedAt = baseEnvironment.now().toISOString();
  const vendorBatches = [];
  const vendorCounts = {};
  const vendorRuns = {};
  const artifacts = {};
  let previousArtifacts = [];
  try {
    previousArtifacts = Object.keys(JSON.parse(readFileSync(resolve(outDir, 'manifest.json'), 'utf8')).artifacts ?? {});
  } catch {
    // A missing or invalid old manifest has no authority over existing files.
  }
  const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
  const publish = (path, bytes, detail = {}) => {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    writeAtomic(resolve(outDir, path), buffer);
    artifacts[path] = { ...detail, bytes: buffer.byteLength, sha256: sha256(buffer) };
  };
  const publishJson = (path, value, detail) => publish(path, `${JSON.stringify(value, null, 2)}\n`, detail);
  const scope = { schemaVersion: 1, regions: [...regions].sort(), remote: !options.offline };

  for (const vendor of vendors) {
    const vendorScope = { ...scope, seedDigest: sha256(JSON.stringify(seeds.filter(station => station.vendor === vendor))) };
    const scopeKey = sha256(JSON.stringify(vendorScope)).slice(0, 20);
    // Checkpoints preserve server locators for deduplication and live adapters.
    // They never live in the directory intended for public hosting.
    const checkpointFile = resolve(cacheDir, `${vendor}-${scopeKey}.json`);
    let discovered = null;
    let sourceGeneratedAt = generatedAt;
    let status = options.offline ? 'offline' : 'ok';
    const diagnostics = [];
    if (options.resume && existsSync(checkpointFile)) {
      try {
        const cached = JSON.parse(readFileSync(checkpointFile, 'utf8'));
        if (cached.vendor === vendor && JSON.stringify(cached.scope) === JSON.stringify(vendorScope) &&
            Number.isFinite(Date.parse(cached.generatedAt)) && Array.isArray(cached.stations)) {
          const parsed = cached.stations.map(parseCatalogueStation);
          if (parsed.every(Boolean)) {
            discovered = parsed;
            sourceGeneratedAt = cached.generatedAt;
            status = 'resumed';
          }
        }
      } catch {
        // Invalid or interrupted checkpoints are never trusted.
      }
    }
    if (discovered === null) {
      const environment = {
        ...baseEnvironment,
        logger(event) {
          diagnostics.push({ level: event.level, code: event.code });
          baseEnvironment.logger(event);
        },
      };
      try {
        discovered = await providers[vendor].discover({ regions, seeds, launches, credentials,
          includeRemoteDiscovery: !options.offline, environment });
        if (!Array.isArray(discovered)) throw new Error('Provider returned a non-array catalogue');
      } catch (error) {
        status = 'fallback';
        log(`[warn] ${vendor} failed: ${error instanceof Error ? error.message : String(error)}`);
        discovered = seeds.filter(station => station.vendor === vendor);
      }
      const parsed = discovered.map(parseCatalogueStation);
      if (parsed.some(station => station === null) || diagnostics.length > 0) status = 'partial';
      discovered = parsed.filter(Boolean);
      const isGlobalHolfuy = vendor === 'holfuy' && !options.offline && !options.providers && !options.environment;
      if (!isGlobalHolfuy) {
        discovered = filterCatalogueStations(discovered, { regions });
      }
      if (!options.offline && !options.providers && !options.environment && discovered.length > 0) {
        const seedIds = new Set(seeds.filter(station => station.vendor === vendor).map(station => station.uid));
        const toVerify = discovered.length <= 40 ? discovered : discovered.filter(station => seedIds.has(station.uid));
        if (toVerify.length > 0) {
          const nowMs = baseEnvironment.now().getTime();
          const feed = await loadStationFeed({
            stations: toStationConfigs(toVerify, credentials),
            environment: baseEnvironment,
          });
          const deadIds = new Set(
            feed.stations
              .filter(st => st.status !== 'ok' || !st.reading || !isRecentObservation(st.reading.observedAt, nowMs))
              .map(st => st.id),
          );
          if (deadIds.size > 0) {
            discovered = discovered.filter(station => !deadIds.has(station.uid));
          }
        }
      }
      if (
        status === 'ok' ||
        status === 'offline' ||
        (!options.providers && !options.environment && status === 'partial' && discovered.length > 0)
      ) {
        writeAtomic(checkpointFile, `${JSON.stringify({ scope: vendorScope, vendor, generatedAt, stations: discovered })}\n`, 0o600);
      }
    }
    // Re-apply scope even after resume; never infer political boundaries from rectangles.
    const isGlobalHolfuy = vendor === 'holfuy' && !options.offline && !options.providers && !options.environment;
    const scoped = isGlobalHolfuy ? discovered : filterCatalogueStations(discovered, { regions });
    const stations = scoped.map(station => {
      const unwrapped = unwrapAggregatorStation(station);
      return { ...unwrapped, category: unwrapped.category ?? defaultCategoryForVendor(unwrapped.vendor) };
    });
    // Keep source identity until all providers are merged, so direct metadata
    // takes precedence over an aggregator regardless of crawl order.
    vendorBatches.push(scoped);
    vendorCounts[vendor] = stations.length;
    vendorRuns[vendor] = { status, sourceGeneratedAt, diagnostics };
    publishJson(`vendors/${vendor}.json`, {
      schemaVersion: CATALOGUE_SCHEMA_VERSION, generatedAt: sourceGeneratedAt, regions,
      vendor, count: stations.length, stations: stations.map(toPublicCatalogueStation),
    }, { stations: stations.length });
    log(`[${status}] ${vendor}: ${stations.length} stations`);
  }

  let stations = mergeDiscoveredStations(vendorBatches.flat(), true).map(station => ({
    ...station, category: station.category ?? defaultCategoryForVendor(station.vendor),
  }));
  if (!options.offline && !options.providers && !options.environment) {
    stations = stations.filter(station => station.vendor !== 'nws' || (station.aliases?.length ?? 0) > 0);
  }
  stations = enrichStationsWithLaunches(stations, launches, maxLaunchKm);
  const overridesPath =
    options.overrides === undefined
      ? DEFAULT_STATION_OVERRIDES_PATH
      : resolve(options.overrides);
  const overrides = loadStationOverrides(overridesPath);
  if (overrides) {
    stations = applyStationOverrides(stations, overrides, {
      onUnmatched: uid => log(`override unmatched: ${uid}`),
      onConflict: (uid, keys) => log(`override conflict for ${uid}: ${keys.join(', ')}`),
    });
  }
  const publicStations = stations.map(toPublicCatalogueStation);
  const document = toPublicStationCatalogue({ schemaVersion: CATALOGUE_SCHEMA_VERSION,
    generatedAt, regions, stations: publicStations });
  publishJson('stations.json', document, { stations: publicStations.length });
  publishJson('stations.geojson', catalogueToGeoJson(publicStations, generatedAt));
  publish('stations.ndjson.gz', gzipSync(Buffer.from(serializeCatalogueNdjson(publicStations))));

  const corridorStations = publicStations.filter(station =>
    station.country === 'AM' ||
    (station.category ?? defaultCategoryForVendor(station.vendor)) === 'freeflight' ||
    (station.launchContext && station.launchContext.distanceKm <= corridorKm));
  const corridorDoc = { ...document, stations: corridorStations };
  publishJson('launch-corridors.json', corridorDoc, { stations: corridorStations.length });
  publishJson('launch-corridors.geojson', catalogueToGeoJson(corridorStations, generatedAt));

  const regionCounts = {};
  for (const region of regions) {
    const regionalStations = publicStations.filter(station => station.country === region);
    regionCounts[region] = regionalStations.length;
    publishJson(`regions/${region.toLowerCase()}.json`, { ...document, regions: [region], stations: regionalStations });
    publish(`regions/${region.toLowerCase()}.ndjson.gz`, gzipSync(Buffer.from(serializeCatalogueNdjson(regionalStations))));
  }
  const categoryCounts = {};
  const finalVendorCounts = {};
  for (const station of publicStations) {
    const category = station.category ?? defaultCategoryForVendor(station.vendor);
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    finalVendorCounts[station.vendor] = (finalVendorCounts[station.vendor] ?? 0) + 1;
  }
  const manifest = {
    schemaVersion: 1, generatedAt, regions, totalStations: publicStations.length,
    unknownCountryStations: publicStations.filter(station => station.country === null).length,
    launchCorridorStations: corridorStations.length, launchesIndexed: launches.length,
    countsByRegion: regionCounts, countsByCategory: categoryCounts, countsByVendor: finalVendorCounts,
    rawCrawledByVendor: vendorCounts, vendorRuns, artifacts,
  };
  writeAtomic(resolve(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  // Remove only crawler-owned shards listed by the previous manifest. Reject
  // arbitrary paths even if someone has edited that manifest.
  for (const path of previousArtifacts) {
    if (!Object.hasOwn(artifacts, path) &&
        /^(?:regions\/(?:us|ca|mx|am)\.(?:json|ndjson\.gz)|vendors\/[a-z_]+\.json)$/.test(path)) {
      rmSync(resolve(outDir, path), { force: true });
    }
  }
  log(`Crawl complete: ${publicStations.length} unique stations.`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({ options: {
    output: { type: 'string', default: 'data/catalogue' },
    cache: { type: 'string', default: '.cache/stations-crawl' },
    regions: { type: 'string', default: INITIAL_SCOPE_REGIONS.join(',') },
    vendors: { type: 'string' }, offline: { type: 'boolean', default: false },
    resume: { type: 'boolean', default: false },
    maxLaunchKm: { type: 'string', default: '50' }, corridorKm: { type: 'string', default: '25' },
  } });
  await crawlCatalogue({ ...args,
    regions: uniqueSelection(args.regions.toUpperCase(), isRegionCode, 'regions'),
    vendors: args.vendors === undefined ? undefined : uniqueSelection(args.vendors.toLowerCase(), vendor => Object.hasOwn(PROVIDERS, vendor), 'vendors'),
  });
}
