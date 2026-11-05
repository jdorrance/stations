<script lang="ts">
  import { onMount } from 'svelte';
  import { map } from '@windy/map';
  import metrics from '@windy/metrics';
  import broadcast from '@windy/broadcast';
  import colors from '@windy/colors';
  import { createStationsClient } from '@stations/client';
  import { STATION_CATEGORIES, type StationCategory } from '@stations/contracts';
  import { createWindyData, DEFAULT_MAX_CONCURRENT_REQUESTS, type WindyDataSnapshot } from './data.ts';
  import { createIndexedDbSnapshotStore } from './persistence.ts';
  import { createStationMarkers, listenToViewport } from './markers.ts';
  import { createStationPopup } from './popup.ts';

  let enabled = true;
  let category: StationCategory | '' = '';
  let selectedUid: string | null = null;
  let snapshot: WindyDataSnapshot | null = null;
  let nowMs = 0;
  let windMetric = metrics.wind;
  let ticker: number | undefined;
  let data: ReturnType<typeof createWindyData> | null = null;
  let markers: ReturnType<typeof createStationMarkers> | null = null;
  let popup: ReturnType<typeof createStationPopup> | null = null;
  let frame: number | undefined;
  let viewportDirty = false;
  let focusPopup = false;
  let destroyed = false;

  $: refreshing = snapshot?.entries.filter(entry => entry.refreshing).length ?? 0;
  $: failed = snapshot?.entries.filter(entry => entry.status === 'refresh-failed' && !entry.refreshing) ?? [];
  $: unavailable = snapshot?.entries.filter(entry => entry.status === 'unavailable').length ?? 0;

  function render() {
    if (!enabled || document.hidden || !snapshot) return;
    if (viewportDirty) markers?.viewportSettled();
    viewportDirty = false;
    markers?.update(snapshot.entries, windMetric, nowMs, selectedUid);
    const entry = snapshot.entries.find(item => item.station.uid === selectedUid);
    if (entry) popup?.update(entry, windMetric, nowMs);
    else popup?.close();
    if (entry && focusPopup) popup?.focus();
    focusPopup = false;
  }

  function scheduleRender() {
    if (destroyed || !enabled || document.hidden || frame !== undefined) return;
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      render();
    });
  }

  function cancelRender() {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    frame = undefined;
    viewportDirty = false;
    focusPopup = false;
  }

  function viewportChanged() {
    if (!data || !enabled || document.hidden) return;
    viewportDirty = true;
    scheduleRender();
    const bounds = map.getBounds();
    data.setViewport({
      west: bounds.getWest(),
      south: bounds.getSouth(),
      east: bounds.getEast(),
      north: bounds.getNorth(),
    }, category || null);
  }

  function visibilityChanged() {
    if (!data) return;
    if (!enabled || document.hidden) {
      cancelRender();
      data.suspend();
      window.clearInterval(ticker);
      ticker = undefined;
      if (!enabled) {
        popup?.close();
        markers?.clear();
        selectedUid = null;
      }
    } else {
      viewportChanged();
      data.resume();
      metricChanged();
      ticker ??= window.setInterval(metricChanged, 15_000);
    }
  }

  function metricChanged() {
    nowMs = performance.now();
    windMetric = metrics.wind;
    scheduleRender();
  }

  function colorsChanged() {
    markers?.refreshColors();
  }

  onMount(() => {
    markers = createStationMarkers(map, uid => {
      const keyboardFocus = document.activeElement?.classList.contains('stations-marker');
      selectedUid = uid;
      focusPopup = !!keyboardFocus;
      scheduleRender();
    }, speed => colors.wind.colorDark(speed, 20));
    popup = createStationPopup(map, restoreFocus => {
      const previous = selectedUid;
      selectedUid = null;
      focusPopup = false;
      scheduleRender();
      if (restoreFocus && previous) markers?.focus(previous);
    });
    data = createWindyData({
      client: createStationsClient({ baseUrl: process.env.STATIONS_API_BASE_URL }),
      // Lean wind-only catalogue: a pre-compressed projection instead of tens of MB.
      catalogueProfile: 'live',
      maxConcurrentRequests: DEFAULT_MAX_CONCURRENT_REQUESTS,
      // Warm visits paint the last stations and readings before the network resolves.
      snapshotStore: createIndexedDbSnapshotStore({
        databaseName: `stations-windy:${process.env.STATIONS_API_BASE_URL}`,
      }),
      onChange(next) {
        snapshot = next;
        nowMs = performance.now();
        scheduleRender();
      },
    });
    snapshot = data.getSnapshot();
    const stopViewport = listenToViewport(map, viewportChanged);
    broadcast.on('metricChanged', metricChanged);
    broadcast.on('redrawLayers', colorsChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    visibilityChanged();

    return () => {
      destroyed = true;
      cancelRender();
      window.clearInterval(ticker);
      document.removeEventListener('visibilitychange', visibilityChanged);
      broadcast.off('metricChanged', metricChanged);
      broadcast.off('redrawLayers', colorsChanged);
      stopViewport();
      data?.destroy();
      popup?.destroy();
      markers?.clear();
      data = null;
      markers = null;
      popup = null;
    };
  });
</script>

<section class="stations-panel" aria-label="Station observations">
  <div class="panel-heading">
    <h2>Stations</h2>
    <label class="toggle"><input type="checkbox" bind:checked={enabled} on:change={visibilityChanged} /> Show</label>
  </div>
  <div class="controls">
    <label>Category
      <select bind:value={category} on:change={viewportChanged} disabled={!enabled}>
        <option value="">All categories</option>
        {#each STATION_CATEGORIES as option}
          <option value={option}>{option}</option>
        {/each}
      </select>
    </label>
    <button type="button" on:click={() => data?.refresh()} disabled={!enabled}>Refresh</button>
  </div>
  {#if enabled && snapshot}
    {#if snapshot.catalogueStatus === 'loading'}
      <p role="status">Loading station catalogue...</p>
    {:else if snapshot.catalogueError}
      <p role="alert">Catalogue {snapshot.catalogueStatus === 'error' ? 'load' : 'refresh'} failed: {snapshot.catalogueError.message}</p>
    {/if}
    {#if snapshot.catalogueStatus === 'ready'}
      <p role="status">Showing {snapshot.selectedCount} of {snapshot.visibleTotal} visible stations.{#if refreshing} Loading or refreshing {refreshing}.{/if}</p>
      {#if snapshot.capped}<p class="warning">Station limit reached. Zoom in to see more.</p>{/if}
    {/if}
    {#if failed.length}
      <p class="warning" role="alert">{failed.length} station refresh{failed.length === 1 ? '' : 'es'} failed.{#if failed.some(entry => entry.error?.kind === 'timeout')} Some requests timed out.{/if} Retained readings may be out of date.</p>
    {/if}
    {#if unavailable}
      <p role="status">{unavailable} station{unavailable === 1 ? '' : 's'} unavailable.</p>
    {/if}
  {/if}
  <p>Wind speed: {windMetric.metric}</p>
  <details><summary>Info</summary><p>Measurements are current, not forecast-time observations. Arrows point in the direction the wind blows.</p><p>Age and availability are shown in station details. Dots indicate stale, unavailable, loading or overlapping stations.</p></details>
</section>

<style>
  .stations-panel { box-sizing: border-box; width: min(290px, calc(100vw - 24px)); padding: 12px; border: 1px solid #ffffff35; border-radius: 10px; background: rgba(13, 23, 34, .88); color: #f3f6f8; font: 13px/1.35 sans-serif; }
  .panel-heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  h2 { font-size: 16px; margin: 0; }
  p { margin: 8px 0 0; }
  .controls { display: flex; gap: 8px; align-items: end; margin-top: 10px; }
  .controls label { flex: 1; display: grid; gap: 4px; }
  .toggle { display: flex; gap: 5px; align-items: center; }
  button, select { min-height: 34px; border: 1px solid #ffffff55; border-radius: 5px; background: #263643; color: #fff; }
  input { width: 18px; height: 18px; }
  details { margin-top: 8px; color: #c6d0d8; }
  summary { cursor: pointer; }
  .warning, [role='alert'] { color: #ffd5ab; }
  :global(.stations-marker) { background: transparent; border: 0; cursor: pointer; }
  :global(.stations-marker-label) { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; height: 16px; padding: 0 4px; white-space: nowrap; border: 0; border-radius: 3px; color: #fff; font: 700 11px/1 sans-serif; }
  :global(.stations-marker-arrow) { display: inline-block; flex: 0 0 10px; width: 10px; height: 10px; margin-left: 3px; margin-right: 1.5px; font: 10px/10px iconfont; text-align: center; }
  :global(.stations-marker-arrow[hidden]) { display: none; }
  :global(.stations-marker-state) { font-size: 10px; }
  :global(.stations-marker-label.stations-marker-dot) { width: 10px; height: 10px; padding: 0; border: 1px solid #fff9; border-radius: 50%; background: rgba(40, 50, 58, .65); }
  :global(.stations-marker-dot .stations-marker-arrow), :global(.stations-marker-dot .stations-marker-value) { display: none; }
  :global(.stations-marker-dot .stations-marker-state) { font-size: 9px; }
  :global(.stations-marker-selected), :global(.stations-marker:focus-visible .stations-marker-label) { outline: 2px solid #fff; outline-offset: 1px; }
  :global(.stations-popup .leaflet-popup-content-wrapper), :global(.stations-popup .leaflet-popup-tip) { background: rgba(0, 0, 0, .88); border: 0; box-shadow: none; color: #f3f6f8; }
  :global(.stations-popup .leaflet-popup-content-wrapper) { padding: 0; border-radius: 9px; }
  :global(.stations-popup .leaflet-popup-content) { margin: 0; }
  :global(.stations-popup-content) { box-sizing: border-box; width: min(250px, calc(100vw - 60px)); max-height: min(350px, 55vh); overflow-y: auto; padding: 12px; color: #f3f6f8; background: transparent; font: 13px/1.35 sans-serif; }
  :global(.stations-popup-content p) { margin: 5px 0; }
  :global(.stations-popup-heading) { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
  :global(.stations-popup-heading h3) { margin: 0; font-size: 15px; overflow-wrap: anywhere; }
  :global(.stations-popup-close) { border: 0; padding: 0 4px; background: transparent; color: #fff; font-size: 20px; cursor: pointer; }
  :global(.stations-popup-source) { color: #c6d0d8; overflow-wrap: anywhere; }
  :global(.stations-popup-wind) { font-size: 15px; font-weight: 700; }
  :global(.stations-popup-notice) { color: #ffd5ab; }
  :global(.stations-popup-content dl) { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 8px 0; }
  :global(.stations-popup-content dd) { margin: 0; overflow-wrap: anywhere; }
  :global(.stations-popup-content a) { color: #b5dfff; }
</style>
