import type { WindyDataEntry } from './data.ts';
import { presentStation, type WindMetric } from './presentation.ts';

export function listenToViewport(map: L.LeafletGlMap, onChange: () => void) {
  map.on('moveend', onChange);
  map.on('zoomend', onChange);
  return () => {
    map.off('moveend', onChange);
    map.off('zoomend', onChange);
  };
}

export function createStationMarkers(map: L.LeafletGlMap, onSelect: (uid: string) => void) {
  const markers = new Map<string, { marker: L.Marker; element: HTMLElement; click: () => void; keydown: (event: KeyboardEvent) => void; latitude: number; longitude: number }>();

  function clear() {
    for (const { marker, element, click, keydown } of markers.values()) {
      marker.off('click', click);
      element.removeEventListener('keydown', keydown);
      marker.remove();
    }
    markers.clear();
  }

  function update(entries: readonly WindyDataEntry[], metric: WindMetric, nowMs: number) {
    const selected = new Set(entries.map(entry => entry.station.uid));
    for (const [uid, item] of markers) {
      if (!selected.has(uid)) {
        item.marker.off('click', item.click);
        item.element.removeEventListener('keydown', item.keydown);
        item.marker.remove();
        markers.delete(uid);
      }
    }
    for (const entry of entries) {
      const { station } = entry;
      let item = markers.get(station.uid);
      if (!item) {
        const marker = new L.Marker([station.latitude, station.longitude], {
          icon: L.divIcon({ className: 'stations-marker', html: '', iconSize: [64, 44], iconAnchor: [32, 22] }),
          keyboard: false,
        }).addTo(map);
        const element = marker.getElement();
        if (!element) {
          marker.remove();
          continue;
        }
        const click = () => onSelect(station.uid);
        marker.on('click', click);
        element.setAttribute('role', 'button');
        element.tabIndex = 0;
        const keydown = (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            click();
          }
        };
        element.addEventListener('keydown', keydown);
        item = { marker, element, click, keydown, latitude: station.latitude, longitude: station.longitude };
        markers.set(station.uid, item);
      }
      if (item.latitude !== station.latitude || item.longitude !== station.longitude) {
        item.marker.setLatLng([station.latitude, station.longitude]);
        item.latitude = station.latitude;
        item.longitude = station.longitude;
      }
      const view = presentStation(entry, metric, nowMs);
      const { element } = item;
      element.setAttribute('aria-label', `${station.name}: ${view.average}, ${view.direction}, ${view.status}${view.freshness ? `, ${view.freshness}` : ''}`);
      element.title = `${station.name}: ${view.status}${view.freshness ? `, ${view.freshness}` : ''}`;
      const label = document.createElement('span');
      label.className = `stations-marker-label stations-marker-${entry.status}${view.freshness ? ` stations-marker-${view.freshness}` : ''}`;
      if (view.rotation !== null) {
        const arrow = document.createElement('span');
        arrow.className = 'stations-marker-arrow';
        arrow.textContent = '↑';
        arrow.style.transform = `rotate(${view.rotation}deg)`;
        arrow.setAttribute('aria-hidden', 'true');
        label.appendChild(arrow);
      }
      const value = document.createElement('span');
      value.textContent = view.average === 'Not reported' ? '—' : view.average;
      label.appendChild(value);
      const state = document.createElement('span');
      state.className = 'stations-marker-state';
      state.textContent = entry.status === 'ok' ? (view.freshness ?? view.status) : view.status;
      label.appendChild(state);
      element.replaceChildren(label);
    }
  }

  return { update, clear };
}
