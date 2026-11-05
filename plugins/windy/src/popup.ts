import type { WindyDataEntry } from './data.ts';
import { presentStation, type WindMetric } from './presentation.ts';

export function createStationPopup(map: L.LeafletGlMap, onClose: (restoreFocus: boolean) => void) {
  const root = document.createElement('section');
  root.className = 'stations-popup-content';
  root.setAttribute('aria-label', 'Station details');
  const heading = document.createElement('div');
  heading.className = 'stations-popup-heading';
  const name = document.createElement('h3');
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'stations-popup-close';
  closeButton.setAttribute('aria-label', 'Close station details');
  closeButton.textContent = '×';
  heading.append(name, closeButton);
  const source = document.createElement('p');
  source.className = 'stations-popup-source';
  const wind = document.createElement('p');
  wind.className = 'stations-popup-wind';
  const state = document.createElement('p');
  state.className = 'stations-popup-state';
  const notice = document.createElement('p');
  notice.className = 'stations-popup-notice';
  const rows = document.createElement('dl');
  const values = ['Observed', 'Direction', 'Temperature', 'Elevation'].map(label => {
    const term = document.createElement('dt');
    term.textContent = label;
    const value = document.createElement('dd');
    rows.append(term, value);
    return value;
  });
  const link = document.createElement('a');
  link.textContent = 'Station source';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  root.append(heading, source, wind, state, notice, rows, link);

  const popup = L.popup({ className: 'stations-popup', autoPan: false, keepInView: false, closeButton: false, closeOnEscapeKey: false, closeOnClick: false, maxWidth: 280 }).setContent(root);
  let open = false;
  let removing = false;
  let latitude: number | null = null;
  let longitude: number | null = null;

  function close(restoreFocus = false) {
    if (!open) return;
    open = false;
    document.removeEventListener('keydown', keydown, true);
    removing = true;
    popup.remove();
    removing = false;
    onClose(restoreFocus);
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  }
  function stop(event: Event) { event.stopPropagation(); }
  function removed() {
    if (!removing && open) {
      open = false;
      document.removeEventListener('keydown', keydown, true);
      onClose(false);
    }
  }
  function explicitClose() { close(true); }
  function text(element: HTMLElement, value: string) { if (element.textContent !== value) element.textContent = value; }
  const stoppedEvents = ['click', 'dblclick', 'mousedown', 'pointerdown', 'pointerup', 'touchstart', 'touchmove', 'touchend', 'wheel'];
  closeButton.addEventListener('click', explicitClose);
  for (const event of stoppedEvents) root.addEventListener(event, stop);
  popup.on('remove', removed);

  function update(entry: WindyDataEntry, metric: WindMetric, nowMs: number) {
    const view = presentStation(entry, metric, nowMs);
    text(name, entry.station.name);
    text(source, `Station observation · ${view.source === entry.station.vendor ? view.source : `${view.source} · ${entry.station.vendor}`}`);
    text(wind, `${view.average} · Gust ${view.gust}`);
    text(state, `${view.status}${view.freshness ? ` · ${view.freshness}` : ''}${view.observedAt ? ` · ${view.age}` : ''}${entry.refreshing ? ' · Refreshing' : ''}`);
    const notices = [];
    if (entry.unavailable?.status === 'unavailable') notices.push(`Unavailable: ${entry.unavailable.reason}`);
    if (entry.error) notices.push(`Refresh error: ${entry.error.message}`);
    if (entry.status !== 'ok' && entry.observation) notices.push('Showing the last retained observation.');
    text(notice, notices.join(' '));
    if (notice.hidden !== (notices.length === 0)) notice.hidden = notices.length === 0;
    text(values[0], view.observedAt ?? 'Not reported');
    text(values[1], view.direction);
    text(values[2], view.temperature);
    text(values[3], view.elevation);
    if (link.hidden !== !view.sourceUrl) link.hidden = !view.sourceUrl;
    if (view.sourceUrl && link.getAttribute('href') !== view.sourceUrl) link.href = view.sourceUrl;
    else if (!view.sourceUrl && link.hasAttribute('href')) link.removeAttribute('href');
    if (latitude !== entry.station.latitude || longitude !== entry.station.longitude) {
      latitude = entry.station.latitude;
      longitude = entry.station.longitude;
      popup.setLatLng([latitude, longitude]);
    }
    if (!open) {
      open = true;
      document.addEventListener('keydown', keydown, true);
      popup.openOn(map);
    }
  }

  function destroy() {
    close(false);
    popup.off('remove', removed);
    closeButton.removeEventListener('click', explicitClose);
    for (const event of stoppedEvents) root.removeEventListener(event, stop);
  }
  function focus() { if (open) closeButton.focus({ preventScroll: true }); }
  return { update, close, focus, destroy };
}
