import '@azohra/meteo.station/elements/register';
import type { StationFeedElement } from '@azohra/meteo.station/elements';
import {
  Map as MapLibreMap,
  NavigationControl,
  Popup,
  setWorkerUrl,
  type GeoJSONSource,
  type MapLayerMouseEvent,
  type StyleSpecification,
} from 'maplibre-gl';
import {
  createCatalogueIndex,
  createStationsClient,
  createViewportStationStore,
  type CatalogueIndex,
} from '@stations/client';
import {
  compassDirection,
  defaultCategoryForVendor,
  pilotFreshness,
  pilotFreshnessThresholds,
  speedFromMps,
  type CatalogueStation,
  type Station,
  type StationCategory,
  type StationVendor,
} from '@stations/contracts';
import type { Bounds, RegionCode } from '@stations/geography';

setWorkerUrl('/dist/maplibre-gl-worker.js');

type UnitSystem = 'imperial' | 'metric';
type BasemapId = 'opentopo' | 'terrain' | 'streets' | 'offline';

const PRESETS: Record<string, { center: [number, number]; zoom: number }> = {
  pnw: { center: [-122.15, 48.05], zoom: 7.5 },
  gorge: { center: [-121.65, 45.7], zoom: 9 },
  rockies: { center: [-117.1, 51.1], zoom: 7.5 },
  wasatch: { center: [-111.85, 40.45], zoom: 8.5 },
  socal: { center: [-118.2, 34.0], zoom: 7.5 },
  appalachia: { center: [-80.5, 37.2], zoom: 6.8 },
  mexico: { center: [-100.12, 19.15], zoom: 8.5 },
  armenia: { center: [44.65, 40.35], zoom: 8.5 },
  alps: { center: [9.5, 46.8], zoom: 6.5 },
  na: { center: [-100.0, 42.0], zoom: 3.3 },
  world: { center: [10.0, 35.0], zoom: 2.0 },
};

const BASEMAPS: { id: BasemapId; label: string }[] = [
  { id: 'opentopo', label: 'OpenTopo' },
  { id: 'terrain', label: 'Terrain' },
  { id: 'streets', label: 'Streets' },
  { id: 'offline', label: 'Offline' },
];

const STREET_TILES = ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'];
const OPENTOPO_TILES = [
  'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
  'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
  'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
];
const STREET_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>';
const OPENTOPO_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>, SRTM · © <a href="https://opentopomap.org" target="_blank" rel="noopener noreferrer">OpenTopoMap</a> (CC-BY-SA)';
const TERRAIN_ATTRIBUTION =
  '<a href="https://www.mapterhorn.com" target="_blank" rel="noopener noreferrer">Mapterhorn</a> hillshade';

const baseStyle: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#edf1f5' } }],
};

const CATEGORY_ORDER: Record<StationCategory, number> = {
  freeflight: 0,
  mountain: 1,
  synoptic: 2,
  marine: 3,
  pws: 4,
};

const client = createStationsClient({ baseUrl: '/api/stations' });

let catalogueIndex: CatalogueIndex | null = null;
let selectedStationUid: string | null = null;
let unitSystem: UnitSystem =
  (localStorage.getItem('stations-units') as UnitSystem | null) === 'metric'
    ? 'metric'
    : 'imperial';
const liveReadingsByUid = new Map<string, Station>();

const unitSelect = document.getElementById('unit-system') as HTMLSelectElement;
const presetSelect = document.getElementById('preset-select') as HTMLSelectElement;
const countrySelect = document.getElementById('country-select') as HTMLSelectElement;
const categorySelect = document.getElementById('category-select') as HTMLSelectElement;
const vendorSelect = document.getElementById('vendor-select') as HTMLSelectElement;
const searchInput = document.getElementById('station-search') as HTMLInputElement;
const pollViewportBtn = document.getElementById('poll-viewport-btn') as HTMLButtonElement;
const summaryEl = document.getElementById('catalogue-summary') as HTMLElement;
const noticeEl = document.getElementById('explorer-notice') as HTMLElement;
const viewportStatusEl = document.getElementById('viewport-status') as HTMLElement;
const stationTitleEl = document.getElementById('station-title') as HTMLElement;
const stationSubtitleEl = document.getElementById('station-subtitle') as HTMLElement;
const stationMetaDl = document.getElementById('station-meta-dl') as HTMLElement;
const stationExtraDl = document.getElementById('station-extra-dl') as HTMLElement;
const stationDetailsEl = document.getElementById('station-details') as HTMLDetailsElement;
const liveCardMount = document.getElementById('live-card-mount') as HTMLElement;
const tableBody = document.getElementById('stations-table-body') as HTMLElement;

unitSelect.value = unitSystem;

function formatElevation(elevationM: number | null): string {
  if (elevationM === null) return '—';
  if (unitSystem === 'imperial') {
    return `${Math.round(elevationM * 3.28084).toLocaleString()} ft (${Math.round(elevationM)} m)`;
  }
  return `${Math.round(elevationM).toLocaleString()} m`;
}

function formatDistance(distanceKm: number): string {
  if (unitSystem === 'imperial') {
    return `${(distanceKm * 0.621371).toFixed(1)} mi`;
  }
  return `${distanceKm.toFixed(1)} km`;
}

function formatWind(station: Station | undefined): string {
  if (!station) return '—';
  if (station.status === 'unavailable') return `Unavailable (${station.reason})`;
  const { reading } = station;
  const speedUnit = unitSystem === 'imperial' ? 'mph' : 'kmh';
  const unitLabel = unitSystem === 'imperial' ? 'mph' : 'km/h';
  const avg = Math.round(speedFromMps(reading.windAvgMps, speedUnit));
  const gust =
    reading.windGustMps !== null
      ? `g${Math.round(speedFromMps(reading.windGustMps, speedUnit))}`
      : '';
  const dir =
    reading.windDirectionDeg !== null
      ? `${compassDirection(reading.windDirectionDeg)} (${Math.round(reading.windDirectionDeg)}°)`
      : 'Calm';
  return `${dir} · ${avg}${gust ? ` ${gust}` : ''} ${unitLabel}`;
}

function formatTemp(station: Station | undefined): string {
  if (!station || station.status === 'unavailable' || station.reading.temperatureC === null) {
    return '—';
  }
  const c = station.reading.temperatureC;
  if (unitSystem === 'imperial') {
    return `${Math.round((c * 9) / 5 + 32)} °F`;
  }
  return `${c.toFixed(1)} °C`;
}

function formatRelativeAge(observedAt: string, nowMs = Date.now()): string {
  const ageMs = Math.max(0, nowMs - Date.parse(observedAt));
  const mins = Math.round(ageMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m ago` : `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatObservedWithFreshness(
  live: Station | undefined,
  catalogueStation: CatalogueStation,
): string {
  if (!live || live.status !== 'ok') return '—';
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const category = catalogueStation.category ?? defaultCategoryForVendor(catalogueStation.vendor);
  const status = pilotFreshness(
    {
      observedAt: live.reading.observedAt,
      servedAt: nowIso,
      receivedAtMs: nowMs,
      nowMs,
    },
    live,
    category,
  );
  const label = status === 'live' ? 'Live' : status === 'aging' ? 'Aging' : 'Stale';
  return `${label} · ${formatRelativeAge(live.reading.observedAt, nowMs)}`;
}

function ensureRaster(
  map: MapLibreMap,
  id: string,
  tiles: string[],
  attribution: string,
  opacity: number,
  maxzoom: number,
) {
  if (map.getSource(id)) return;
  const before = map.getLayer('stations-Point') ? 'stations-Point' : undefined;
  map.addSource(id, { type: 'raster', tiles, tileSize: 256, attribution, maxzoom });
  map.addLayer(
    {
      id,
      type: 'raster',
      source: id,
      paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 },
    },
    before,
  );
}

function ensureHillshade(map: MapLibreMap) {
  if (map.getSource('mapterhorn')) return;
  const before = map.getLayer('stations-Point') ? 'stations-Point' : undefined;
  map.addSource('mapterhorn', {
    type: 'raster-dem',
    url: 'https://tiles.mapterhorn.com/tilejson.json',
    tileSize: 512,
    attribution: TERRAIN_ATTRIBUTION,
  });
  map.addLayer(
    {
      id: 'hillshade',
      type: 'hillshade',
      source: 'mapterhorn',
      paint: { 'hillshade-shadow-color': '#473B24' },
    },
    before,
  );
}

function applyBasemap(map: MapLibreMap, basemap: BasemapId) {
  if (basemap === 'streets' || basemap === 'terrain') {
    ensureRaster(map, 'osm', STREET_TILES, STREET_ATTRIBUTION, 0.9, 19);
  }
  if (basemap === 'opentopo') {
    ensureRaster(map, 'opentopo', OPENTOPO_TILES, OPENTOPO_ATTRIBUTION, 1, 17);
  }
  if (basemap === 'terrain') ensureHillshade(map);
  const visibility: Record<string, 'visible' | 'none'> = {
    osm: basemap === 'streets' || basemap === 'terrain' ? 'visible' : 'none',
    opentopo: basemap === 'opentopo' ? 'visible' : 'none',
    hillshade: basemap === 'terrain' ? 'visible' : 'none',
  };
  for (const [id, value] of Object.entries(visibility)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', value);
  }
}

function basemapControl(map: MapLibreMap) {
  const control = document.createElement('div');
  control.className = 'maplibregl-ctrl';
  const select = document.createElement('select');
  select.className = 'map-basemap';
  select.setAttribute('aria-label', 'Basemap');
  for (const choice of BASEMAPS) {
    const option = document.createElement('option');
    option.value = choice.id;
    option.textContent = choice.label;
    option.selected = choice.id === 'opentopo';
    select.appendChild(option);
  }
  select.addEventListener('change', () => applyBasemap(map, select.value as BasemapId));
  control.appendChild(select);
  return control;
}

const mapEl = document.getElementById('stations-map') as HTMLElement;
const map = new MapLibreMap({
  container: mapEl,
  style: baseStyle,
  center: PRESETS.pnw!.center,
  zoom: PRESETS.pnw!.zoom,
  minZoom: 2,
  maxZoom: 17,
  bearing: 0,
  pitch: 0,
  maxPitch: 0,
  dragRotate: false,
  touchPitch: false,
  pitchWithRotate: false,
  fadeDuration: 0,
  attributionControl: { compact: false },
});

map.addControl(new NavigationControl({ showCompass: false }), 'top-right');
map.addControl({ onAdd: () => basemapControl(map), onRemove: () => undefined }, 'top-right');

function mapBoundsTuple(): Bounds {
  const b = map.getBounds();
  const west = Math.max(-180, Math.min(180, b.getWest()));
  const south = Math.max(-90, Math.min(90, b.getSouth()));
  const east = Math.max(-180, Math.min(180, b.getEast()));
  const north = Math.max(-90, Math.min(90, b.getNorth()));
  return [west, south, east, north];
}

function currentFilter() {
  const country = countrySelect.value as RegionCode | '';
  const category = categorySelect.value as StationCategory | '';
  const vendor = vendorSelect.value as StationVendor | '';
  const search = searchInput.value.trim().toLowerCase();
  return {
    countries: country ? [country] : undefined,
    categories: category ? [category] : undefined,
    vendors: vendor ? [vendor] : undefined,
    search,
  };
}

function filteredCatalogueStations(): readonly CatalogueStation[] {
  if (!catalogueIndex) return [];
  const { countries, categories, vendors, search } = currentFilter();
  if (!countries && !categories && !vendors && !search) {
    return catalogueIndex.document.stations;
  }
  let list = catalogueIndex.all({ countries, categories, vendors });
  if (search) {
    list = list.filter(
      station =>
        station.name.toLowerCase().includes(search) ||
        station.uid.toLowerCase().includes(search) ||
        (station.launchContext?.nearestLaunchName.toLowerCase().includes(search) ?? false),
    );
  }
  return list;
}

function stationsInCurrentView(): CatalogueStation[] {
  if (!catalogueIndex) return [];
  const { countries, categories, vendors, search } = currentFilter();
  let inView = catalogueIndex.inBounds(mapBoundsTuple(), { countries, categories, vendors });
  if (search) {
    inView = inView.filter(
      station =>
        station.name.toLowerCase().includes(search) ||
        station.uid.toLowerCase().includes(search) ||
        (station.launchContext?.nearestLaunchName.toLowerCase().includes(search) ?? false),
    );
  }
  return inView.sort((a, b) => {
    const catA = CATEGORY_ORDER[a.category ?? defaultCategoryForVendor(a.vendor)];
    const catB = CATEGORY_ORDER[b.category ?? defaultCategoryForVendor(b.vendor)];
    if (catA !== catB) return catA - catB;
    const distA = a.launchContext?.distanceKm ?? Infinity;
    const distB = b.launchContext?.distanceKm ?? Infinity;
    if (distA !== distB) return distA - distB;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function updateMapSource() {
  if (!catalogueIndex) return;
  const source = map.getSource('stations') as GeoJSONSource | undefined;
  if (!source) return;
  const stations = filteredCatalogueStations();
  source.setData(catalogueIndex.toGeoJson(stations) as unknown as GeoJSON.FeatureCollection);
}

function renderStationsTable() {
  const visible = stationsInCurrentView();
  const top = visible.slice(0, 60);
  viewportStatusEl.textContent = `${visible.length.toLocaleString()} stations in map view · showing top ${top.length}`;

  tableBody.replaceChildren();
  for (const station of top) {
    const tr = document.createElement('tr');
    if (station.uid === selectedStationUid) tr.classList.add('is-selected');
    tr.addEventListener('click', () => {
      void selectStation(station.uid, true);
    });

    const nameTd = document.createElement('td');
    nameTd.textContent = station.name;

    const vendorTd = document.createElement('td');
    const vendorBadge = document.createElement('span');
    vendorBadge.className = 'badge';
    vendorBadge.textContent = station.vendor;
    vendorTd.appendChild(vendorBadge);

    const catTd = document.createElement('td');
    catTd.textContent = station.category ?? defaultCategoryForVendor(station.vendor);

    const elevTd = document.createElement('td');
    elevTd.textContent = formatElevation(station.elevationM);

    const launchTd = document.createElement('td');
    if (station.launchContext) {
      launchTd.textContent = `${station.launchContext.nearestLaunchName} (${formatDistance(station.launchContext.distanceKm)})`;
    } else {
      launchTd.textContent = '—';
    }

    const live = liveReadingsByUid.get(station.uid);
    const windTd = document.createElement('td');
    windTd.textContent = formatWind(live);

    const tempTd = document.createElement('td');
    tempTd.textContent = formatTemp(live);

    const obsTd = document.createElement('td');
    obsTd.textContent = formatObservedWithFreshness(live, station);

    tr.append(nameTd, vendorTd, catTd, elevTd, launchTd, windTd, tempTd, obsTd);
    tableBody.appendChild(tr);
  }
}

function setDlEntries(dl: HTMLElement, entries: readonly [string, string][]) {
  dl.replaceChildren();
  for (const [label, value] of entries) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    dl.append(dt, dd);
  }
}

async function selectStation(uid: string, panToStation = false) {
  if (!catalogueIndex) return;
  const station = catalogueIndex.byUid(uid);
  if (!station) return;
  selectedStationUid = station.uid;
  renderStationsTable();

  if (panToStation) {
    map.easeTo({
      center: [station.longitude, station.latitude],
      zoom: Math.max(map.getZoom(), 10.5),
      duration: 350,
    });
  }

  stationTitleEl.textContent = station.name;
  stationSubtitleEl.textContent = `${station.uid} · ${station.country ?? 'Region'} ${station.region ? `(${station.region})` : ''}`;

  const primaryFacts: [string, string][] = [
    ['Coordinates', `${station.latitude.toFixed(4)}°, ${station.longitude.toFixed(4)}°`],
    ['Elevation (MSL)', formatElevation(station.elevationM)],
    ['Category / Network', `${station.category ?? defaultCategoryForVendor(station.vendor)} · ${station.vendor}`],
  ];
  if (station.launchContext) {
    primaryFacts.push([
      'Nearest launch',
      `${station.launchContext.nearestLaunchName} · ${formatDistance(station.launchContext.distanceKm)} (${station.launchContext.bearingDeg}°)`,
    ]);
  }
  setDlEntries(stationMetaDl, primaryFacts);

  const capList = Object.entries(station.capabilities)
    .filter(([, enabled]) => Boolean(enabled))
    .map(([key]) => key)
    .join(', ');
  const category = station.category ?? defaultCategoryForVendor(station.vendor);
  const pilotLimits = pilotFreshnessThresholds(station, category);
  const liveMins = Math.round(pilotLimits.currentForMs / 60_000);
  const staleMins = Math.round(pilotLimits.staleAfterMs / 60_000);

  const extraFacts: [string, string][] = [
    ['Declared capabilities', capList || 'wind'],
    ['Poll cadence', `${station.recommendedPollSeconds} s`],
    ['Pilot freshness limits', `Live ≤ ${liveMins}m · Stale > ${staleMins}m`],
    ['Time zone', station.timeZone ?? 'UTC'],
  ];
  if (station.aliases?.length) {
    extraFacts.push(['Cross-network aliases', station.aliases.join(', ')]);
  }
  setDlEntries(stationExtraDl, extraFacts);
  stationDetailsEl.hidden = false;

  liveCardMount.textContent = 'Fetching live observation…';
  const result = await client.loadFeedResult({ ids: [station.uid] });
  if (selectedStationUid !== station.uid) return;

  if (result.error || !result.data) {
    liveCardMount.textContent = result.error?.message ?? 'Live feed unavailable.';
    return;
  }

  const loadedStation = result.data.stations[0];
  if (loadedStation) {
    liveReadingsByUid.set(station.uid, loadedStation);
    renderStationsTable();
    if (loadedStation.status === 'ok') {
      const freshnessSummary = formatObservedWithFreshness(loadedStation, station);
      setDlEntries(stationMetaDl, [...primaryFacts, ['Pilot freshness', freshnessSummary]]);
    }
  }

  liveCardMount.replaceChildren();
  const feedEl = document.createElement('meteo-station-feed') as StationFeedElement;
  feedEl.feed = result.data;
  feedEl.receivedAtMs = Date.now();
  feedEl.thresholds =
    unitSystem === 'imperial'
      ? { unit: 'mph', values: [8, 15, 22] }
      : { unit: 'kmh', values: [12, 24, 35] };
  if (station.declaredFavorableDirections?.length) {
    feedEl.favorableDirections = station.declaredFavorableDirections.map(arc => ({ ...arc }));
  }

  const cardEl = document.createElement('meteo-station-card');
  cardEl.setAttribute('station', station.uid);
  feedEl.appendChild(cardEl);
  liveCardMount.appendChild(feedEl);
}

async function pollVisibleStations() {
  if (!catalogueIndex) return;
  const candidates = stationsInCurrentView().slice(0, 20);
  if (candidates.length === 0) return;

  pollViewportBtn.disabled = true;
  pollViewportBtn.textContent = `Polling ${candidates.length} stations…`;
  try {
    const result = await client.loadFeedResult({
      ids: candidates.map(s => s.uid),
    });
    if (result.data) {
      for (const st of result.data.stations) {
        liveReadingsByUid.set(st.id, st);
      }
      renderStationsTable();
      if (selectedStationUid && liveReadingsByUid.has(selectedStationUid)) {
        await selectStation(selectedStationUid, false);
      }
    }
  } finally {
    pollViewportBtn.disabled = false;
    pollViewportBtn.textContent = 'Poll live in view';
  }
}

map.on('load', async () => {
  applyBasemap(map, 'opentopo');

  map.addSource('stations', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: 'stations-Point',
    type: 'circle',
    source: 'stations',
    paint: {
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        3,
        ['match', ['get', 'category'], 'freeflight', 4.5, 2.8],
        8,
        ['match', ['get', 'category'], 'freeflight', 7.5, 5.5],
        12,
        ['match', ['get', 'category'], 'freeflight', 10, 7.5],
      ],
      'circle-color': [
        'match',
        ['get', 'category'],
        'freeflight',
        '#1c5cab',
        'mountain',
        '#eb6834',
        'synoptic',
        '#1baf7a',
        'marine',
        '#008080',
        '#898781',
      ],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 1.5,
    },
  });

  map.on('click', 'stations-Point', (event: MapLayerMouseEvent) => {
    const feature = event.features?.[0];
    const uid = feature?.properties?.uid;
    if (typeof uid === 'string') {
      void selectStation(uid, false);
      if (feature?.geometry.type === 'Point') {
        const [lon, lat] = feature.geometry.coordinates as [number, number];
        new Popup({ offset: 10, closeButton: false })
          .setLngLat([lon, lat])
          .setHTML(
            `<strong>${String(feature.properties?.name ?? uid)}</strong><br/><span class="muted">${String(feature.properties?.vendor ?? '')}</span>`,
          )
          .addTo(map);
      }
    }
  });

  map.on('mouseenter', 'stations-Point', () => {
    map.getCanvas().style.cursor = 'pointer';
  });
  map.on('mouseleave', 'stations-Point', () => {
    map.getCanvas().style.cursor = '';
  });

  map.on('moveend', () => {
    renderStationsTable();
  });

  const indexResult = await client.loadCatalogueResult();
  if (indexResult.error || !indexResult.data) {
    summaryEl.textContent = 'Catalogue unavailable';
    noticeEl.textContent = indexResult.error?.message ?? 'Could not load station catalogue';
    noticeEl.hidden = false;
    return;
  }

  catalogueIndex = createCatalogueIndex(indexResult.data);
  const vendorCounts = new Map<string, number>();
  for (const st of catalogueIndex.all()) {
    vendorCounts.set(st.vendor, (vendorCounts.get(st.vendor) ?? 0) + 1);
  }
  for (const [vendor, count] of [...vendorCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const opt = document.createElement('option');
    opt.value = vendor;
    opt.textContent = `${vendor} (${count.toLocaleString()})`;
    vendorSelect.appendChild(opt);
  }

  summaryEl.textContent = `${catalogueIndex.size.toLocaleString()} indexed stations · generated ${new Date(indexResult.data.generatedAt).toLocaleString()}`;
  updateMapSource();
  renderStationsTable();

  // Select the first live free-flight station in view or in the catalogue by default
  const initialStation =
    catalogueIndex.byUid('windguru:2041') ??
    catalogueIndex.byUid('holfuy:1104') ??
    catalogueIndex.byUid('windnerd:bridal-lz') ??
    stationsInCurrentView()[0] ??
    catalogueIndex.all()[0];
  if (initialStation) {
    void selectStation(initialStation.uid, false);
  }

  // Also wire a viewport store for automatic GeoJSON feed conversions when requested
  const viewportStore = createViewportStationStore({
    client,
    catalogueByUid: catalogueIndex.byUidMap,
  });
  viewportStore.subscribe(() => {
    const snap = viewportStore.getSnapshot();
    if (snap.feed) {
      for (const st of snap.feed.stations) {
        liveReadingsByUid.set(st.id, st);
      }
      renderStationsTable();
    }
  });
});

presetSelect.addEventListener('change', () => {
  const preset = PRESETS[presetSelect.value];
  if (preset) {
    map.jumpTo({ center: preset.center, zoom: preset.zoom });
    renderStationsTable();
  }
});

for (const control of [countrySelect, categorySelect, vendorSelect]) {
  control.addEventListener('change', () => {
    updateMapSource();
    renderStationsTable();
  });
}

let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
searchInput.addEventListener('input', () => {
  if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    updateMapSource();
    renderStationsTable();
  }, 120);
});

unitSelect.addEventListener('change', () => {
  unitSystem = unitSelect.value === 'metric' ? 'metric' : 'imperial';
  localStorage.setItem('stations-units', unitSystem);
  renderStationsTable();
  if (selectedStationUid) {
    void selectStation(selectedStationUid, false);
  }
});

pollViewportBtn.addEventListener('click', () => {
  void pollVisibleStations();
});
