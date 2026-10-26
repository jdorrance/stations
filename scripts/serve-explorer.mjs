import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  CATALOGUE_SCHEMA_VERSION,
  mergeCatalogueStations,
  parseCatalogueStation,
  parseStationCatalogueJson,
} from '@stations/contracts';
import { INITIAL_SCOPE_REGIONS } from '@stations/geography';
import {
  INITIAL_SEED_STATIONS,
  createStationsApiHandler,
  mergeDiscoveredStations,
} from '@stations/providers';
import { root } from './workspace.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Loads the station catalogue for the local explorer, re-attaching private
 * adapter locators from `.cache/stations-crawl/` and `INITIAL_SEED_STATIONS`
 * so live upstream adapters work while `/catalogue` still strips locators.
 */
export function loadExplorerCatalogue(options = {}) {
  const catalogueDir = resolve(root, options.catalogueDir ?? 'data/catalogue');
  const cacheDir = resolve(root, options.cacheDir ?? '.cache/stations-crawl');
  const preferFull = Boolean(options.full);

  const primaryPath = resolve(
    catalogueDir,
    preferFull ? 'stations.json' : 'launch-corridors.json',
  );
  const fallbackPath = resolve(catalogueDir, 'stations.json');
  const chosenPath = existsSync(primaryPath)
    ? primaryPath
    : existsSync(fallbackPath)
      ? fallbackPath
      : null;

  let publicDoc = null;
  if (chosenPath) {
    try {
      publicDoc = parseStationCatalogueJson(readFileSync(chosenPath, 'utf8'));
    } catch {
      publicDoc = null;
    }
  }

  const checkpointStations = [];
  if (existsSync(cacheDir)) {
    try {
      for (const file of readdirSync(cacheDir)) {
        if (!file.endsWith('.json')) continue;
        const parsed = JSON.parse(readFileSync(resolve(cacheDir, file), 'utf8'));
        for (const raw of parsed.stations ?? []) {
          const valid = parseCatalogueStation(raw);
          if (valid) checkpointStations.push(valid);
        }
      }
    } catch {
      // Ignore unreadable cache files
    }
  }

  const locatorByUid = new Map();
  for (const station of [...mergeDiscoveredStations(checkpointStations, false), ...INITIAL_SEED_STATIONS]) {
    if (Object.keys(station.locator).length > 0) {
      locatorByUid.set(station.uid, station.locator);
    }
  }

  const baseStations = publicDoc?.stations ?? INITIAL_SEED_STATIONS;
  const hydrated = mergeCatalogueStations([
    INITIAL_SEED_STATIONS,
    baseStations.map(station => ({
      ...station,
      locator: locatorByUid.get(station.uid) ?? station.locator,
    })),
  ]);

  return {
    schemaVersion: CATALOGUE_SCHEMA_VERSION,
    generatedAt: publicDoc?.generatedAt ?? new Date().toISOString(),
    regions: publicDoc?.regions ?? INITIAL_SCOPE_REGIONS,
    stations: hydrated,
  };
}

export function createExplorerRequestHandler(options = {}) {
  const catalogue = options.catalogue ?? loadExplorerCatalogue(options);
  const apiHandler = createStationsApiHandler({
    catalogue,
    basePath: '/api/stations',
    maxFeedStations: options.maxFeedStations ?? 30,
    environment: options.environment,
    credentials: {
      tempestToken: process.env.TEMPEST_TOKEN,
      ecowittApplicationKey: process.env.ECOWITT_APP_KEY,
      ecowittApiKey: process.env.ECOWITT_API_KEY,
      holfuyApiKey: process.env.HOLFUY_API_KEY,
      wuApiKey: process.env.WU_API_KEY,
      synopticToken: process.env.SYNOPTIC_TOKEN,
      ambientApiKey: process.env.AMBIENT_API_KEY,
      ambientApplicationKey: process.env.AMBIENT_APP_KEY,
      ...options.credentials,
    },
  });

  const webRoot = resolve(root, 'web');
  const staticFiles = new Map([
    ['/', resolve(webRoot, 'index.html')],
    ['/index.html', resolve(webRoot, 'index.html')],
    ['/dist/app.js', resolve(webRoot, 'dist/app.js')],
    ['/dist/styles.css', resolve(webRoot, 'dist/styles.css')],
    ['/dist/maplibre-gl-worker.js', resolve(webRoot, 'dist/maplibre-gl-worker.js')],
    ['/data/catalogue/manifest.json', resolve(root, 'data/catalogue/manifest.json')],
  ]);

  return async function handleRequest(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/stations')) {
      return apiHandler(request);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const target = staticFiles.get(url.pathname);
    if (!target || !existsSync(target)) {
      return new Response('Not found', { status: 404 });
    }
    const ext = extname(target);
    const bytes = readFileSync(target);
    return new Response(request.method === 'HEAD' ? null : bytes, {
      status: 200,
      headers: {
        'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      },
    });
  };
}

export async function startExplorerServer(options = {}) {
  const port = options.port ?? 4331;
  const host = options.host ?? '127.0.0.1';
  const handler = createExplorerRequestHandler(options);

  const server = createServer(async (req, res) => {
    try {
      const origin = `http://${req.headers.host ?? `${host}:${port}`}`;
      const request = new Request(new URL(req.url ?? '/', origin), {
        method: req.method ?? 'GET',
        headers: req.headers,
      });
      const response = await handler(request);
      res.statusCode = response.status;
      response.headers.forEach((value, key) => res.setHeader(key, value));
      const buffer = Buffer.from(await response.arrayBuffer());
      res.end(buffer);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Internal error' }));
    }
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => resolveListen());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close: () =>
      new Promise((resolveClose, rejectClose) => {
        server.closeAllConnections?.();
        server.close(err => (err ? rejectClose(err) : resolveClose()));
      }),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values: args } = parseArgs({
    options: {
      port: { type: 'string', default: '4331' },
      host: { type: 'string', default: '127.0.0.1' },
      full: { type: 'boolean', default: false },
    },
  });
  const started = await startExplorerServer({
    port: Number(args.port),
    host: args.host,
    full: args.full,
  });
  console.log(`Stations explorer running at ${started.url}`);
}
