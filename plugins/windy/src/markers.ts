import type { WindyDataEntry } from './data.ts';
import { presentMarker, type WindMetric } from './presentation.ts';

export function listenToViewport(map: L.LeafletGlMap, onChange: () => void) {
  map.on('moveend', onChange);
  map.on('zoomend', onChange);
  return () => {
    map.off('moveend', onChange);
    map.off('zoomend', onChange);
  };
}

export function createStationMarkers(map: L.LeafletGlMap, onSelect: (uid: string) => void, colorForSpeed: (speed: number) => string) {
  type Item = {
    marker: L.Marker;
    element: HTMLElement;
    label: HTMLElement;
    arrow: HTMLElement;
    value: HTMLElement;
    state: HTMLElement;
    click: (event: MouseEvent) => void;
    keydown: (event: KeyboardEvent) => void;
    focus: () => void;
    blur: () => void;
    latitude: number;
    longitude: number;
    status: WindyDataEntry['status'];
    freshness: string | null;
    hasReading: boolean;
    dot: boolean;
    zIndex: number | null;
    color: string;
    width: number;
    height: number;
    sizeKey: string;
    speed: number | null;
    metric: WindMetric | null;
    unit: string | undefined;
    average: string;
    numeric: string;
  };
  const markers = new Map<string, Item>();
  const sizes = new Map<string, { width: number; height: number }>();
  let selectedUid: string | null = null;
  let focusedUid: string | null = null;
  let viewportKey = '';

  function dispose(item: Item) {
    item.element.removeEventListener('click', item.click);
    item.element.removeEventListener('keydown', item.keydown);
    item.element.removeEventListener('focus', item.focus);
    item.element.removeEventListener('blur', item.blur);
    item.marker.remove();
  }

  function clear() {
    for (const item of markers.values()) dispose(item);
    markers.clear();
    sizes.clear();
    selectedUid = null;
    focusedUid = null;
    viewportKey = '';
  }

  function updateClass(uid: string, item: Item, dot = item.dot) {
    const className = `stations-marker-label stations-marker-${item.status}${item.freshness ? ` stations-marker-${item.freshness}` : ''}${dot ? ' stations-marker-dot' : ''}${uid === selectedUid ? ' stations-marker-selected' : ''}`;
    if (item.label.className !== className) item.label.className = className;
  }

  function updateColor(item: Item) {
    const color = !item.dot && item.hasReading && item.speed !== null ? colorForSpeed(item.speed) : '';
    if (item.color !== color) {
      item.color = color;
      item.label.style.backgroundColor = color;
    }
  }

  function refreshColors() {
    for (const item of markers.values()) updateColor(item);
  }

  function reconcileGeometry() {
    const size = map.getSize();
    const occupied: { left: number; right: number; top: number; bottom: number }[] = [];
    const ordered = [...markers.entries()].sort(([a, x], [b, y]) => {
      const priority = (uid: string, item: Item) => uid === selectedUid ? 0 : uid === focusedUid ? 1 : item.hasReading && item.freshness === 'live' ? 2 : item.hasReading ? 3 : 4;
      return priority(a, x) - priority(b, y) || (a < b ? -1 : a > b ? 1 : 0);
    });
    for (const [uid, item] of ordered) {
      const point = map.latLngToContainerPoint([item.latitude, item.longitude]);
      const box = { left: point.x - item.width / 2 - 2, right: point.x + item.width / 2 + 2, top: point.y - item.height / 2 - 2, bottom: point.y + item.height / 2 + 2 };
      const clipped = !Number.isFinite(point.x) || !Number.isFinite(point.y) || box.left < 0 || box.top < 0 || box.right > size.x || box.bottom > size.y;
      const dot = !item.hasReading || clipped || occupied.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top);
      if (!dot) occupied.push(box);
      if (item.dot !== dot) {
        item.dot = dot;
        item.element.style.width = dot ? '18px' : '44px';
        item.element.style.height = dot ? '18px' : '44px';
        item.element.style.marginLeft = dot ? '-9px' : '-22px';
        item.element.style.marginTop = dot ? '-9px' : '-22px';
      }
      const zIndex = uid === selectedUid ? 300 : uid === focusedUid ? 200 : dot ? 100 : 0;
      if (item.zIndex !== zIndex) {
        item.marker.setZIndexOffset(zIndex);
        item.zIndex = zIndex;
      }
      updateClass(uid, item);
      updateColor(item);
    }
  }

  function viewportSettled() {
    const size = map.getSize();
    const center = map.getCenter();
    const bounds = map.getBounds();
    const key = [size.x, size.y, center.lat, center.lng, map.getZoom(), bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].join(',');
    if (key !== viewportKey) {
      viewportKey = key;
      reconcileGeometry();
    }
  }

  function update(entries: readonly WindyDataEntry[], metric: WindMetric, nowMs: number, nextSelectedUid: string | null = null) {
    let geometryChanged = selectedUid !== nextSelectedUid;
    const measure: { uid: string; item: Item; key: string }[] = [];
    const recolor: Item[] = [];
    selectedUid = nextSelectedUid;
    const selected = new Set(entries.map(entry => entry.station.uid));
    for (const [uid, item] of markers) {
      if (!selected.has(uid)) {
        dispose(item);
        markers.delete(uid);
        if (focusedUid === uid) focusedUid = null;
        geometryChanged = true;
      }
    }
    for (const entry of entries) {
      const { station } = entry;
      let item = markers.get(station.uid);
      if (!item) {
        const marker = new L.Marker([station.latitude, station.longitude], {
          icon: L.divIcon({ className: 'stations-marker', html: '', iconSize: [44, 44], iconAnchor: [22, 22] }),
          keyboard: false,
          bubblingMouseEvents: false,
        }).addTo(map);
        const element = marker.getElement();
        if (!element) {
          marker.remove();
          continue;
        }
        const label = document.createElement('span');
        const arrow = document.createElement('span');
        const value = document.createElement('span');
        const state = document.createElement('span');
        arrow.className = 'stations-marker-arrow';
        arrow.textContent = '"';
        arrow.setAttribute('aria-hidden', 'true');
        value.className = 'stations-marker-value';
        state.className = 'stations-marker-state';
        state.setAttribute('aria-hidden', 'true');
        label.appendChild(arrow);
        label.appendChild(value);
        label.appendChild(state);
        element.appendChild(label);
        const click = (event: MouseEvent) => { event.stopPropagation(); onSelect(station.uid); };
        const keydown = (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            onSelect(station.uid);
          }
        };
        const focus = () => { focusedUid = station.uid; reconcileGeometry(); };
        const blur = () => { if (focusedUid === station.uid) { focusedUid = null; reconcileGeometry(); } };
        element.setAttribute('role', 'button');
        element.tabIndex = 0;
        element.addEventListener('click', click);
        element.addEventListener('keydown', keydown);
        element.addEventListener('focus', focus);
        element.addEventListener('blur', blur);
        item = { marker, element, label, arrow, value, state, click, keydown, focus, blur, latitude: station.latitude, longitude: station.longitude, status: entry.status, freshness: null, hasReading: false, dot: false, zIndex: null, color: '', width: 0, height: 0, sizeKey: '', speed: null, metric: null, unit: undefined, average: 'Not reported', numeric: '' };
        markers.set(station.uid, item);
        geometryChanged = true;
      }
      if (item.latitude !== station.latitude || item.longitude !== station.longitude) {
        item.marker.setLatLng([station.latitude, station.longitude]);
        item.latitude = station.latitude;
        item.longitude = station.longitude;
        geometryChanged = true;
      }
      const view = presentMarker(entry, nowMs);
      const rawSpeed = entry.observation?.status === 'ok' ? entry.observation.reading.windAvgMps : null;
      const speed = rawSpeed !== null && Number.isFinite(rawSpeed) ? rawSpeed : null;
      if (item.speed !== speed) recolor.push(item);
      if (item.speed !== speed || item.metric !== metric || item.unit !== metric.metric) {
        item.speed = speed;
        item.metric = metric;
        item.unit = metric.metric;
        item.average = speed === null ? 'Not reported' : metric.convertValue(speed);
        const number = speed === null ? null : metric.convertNumber(speed);
        item.numeric = number !== null && Number.isFinite(number) ? String(Math.round(number)) : '';
      }
      const hasReading = item.numeric !== '' && (view.freshness === 'live' || view.freshness === 'aging') && entry.status !== 'unavailable';
      if (item.hasReading !== hasReading || (item.freshness === 'live') !== (view.freshness === 'live')) geometryChanged = true;
      item.hasReading = hasReading;
      item.status = entry.status;
      item.freshness = view.freshness;
      updateClass(station.uid, item);
      const aria = `${station.name}: ${item.average}, ${view.direction}, ${view.status}${view.freshness ? `, ${view.freshness}` : ''}${view.observedAt ? `, ${view.age}` : ''}`;
      if (item.element.getAttribute('aria-label') !== aria) item.element.setAttribute('aria-label', aria);
      const title = `${station.name}: ${view.status}${view.freshness ? `, ${view.freshness}` : ''}${view.observedAt ? `, ${view.age}` : ''}`;
      if (item.element.title !== title) item.element.title = title;
      const rotation = view.rotation === null ? '' : `rotate(${view.rotation}deg)`;
      if (item.arrow.style.transform !== rotation) item.arrow.style.transform = rotation;
      if (item.arrow.hidden !== (view.rotation === null)) item.arrow.hidden = view.rotation === null;
      const value = item.numeric;
      if (item.value.textContent !== value) item.value.textContent = value;
      const state = entry.status === 'refresh-failed' || entry.status === 'unavailable' ? '!' : '';
      if (item.state.textContent !== state) item.state.textContent = state;
      const sizeKey = `${value}|${view.rotation === null}|${state}`;
      if (hasReading && item.sizeKey !== sizeKey) {
        item.sizeKey = sizeKey;
        const cached = sizes.get(sizeKey);
        if (cached) {
          if (item.width !== cached.width || item.height !== cached.height) geometryChanged = true;
          item.width = cached.width;
          item.height = cached.height;
        } else {
          updateClass(station.uid, item, false);
          measure.push({ uid: station.uid, item, key: sizeKey });
        }
      }
    }
    const measured = measure.map(({ item, key }) => {
      const cached = sizes.get(key);
      if (cached) return cached;
      const rect = item.label.getBoundingClientRect();
      const width = rect.width || valueWidth(item.numeric, item.arrow.hidden);
      const height = rect.height || 22;
      if (rect.width && rect.height) {
        if (sizes.size >= 256) sizes.clear();
        sizes.set(key, { width, height });
      }
      return { width, height };
    });
    for (const [index, { uid, item }] of measure.entries()) {
      const { width, height } = measured[index];
      if (item.width !== width || item.height !== height) geometryChanged = true;
      item.width = width;
      item.height = height;
      updateClass(uid, item);
    }
    if (geometryChanged) reconcileGeometry();
    for (const item of recolor) updateColor(item);
  }

  function valueWidth(value: string, noDirection: boolean) {
    return value.length * 11 + (noDirection ? 8 : 20);
  }

  function focus(uid: string) {
    markers.get(uid)?.element.focus({ preventScroll: true });
  }

  return { update, viewportSettled, refreshColors, focus, clear };
}
