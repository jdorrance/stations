<script lang="ts">
  import { onMount } from 'svelte';
  import { map } from '@windy/map';
  import metrics from '@windy/metrics';
  import broadcast from '@windy/broadcast';
  import { createStationsClient } from '@stations/client';
  import { STATION_CATEGORIES, type StationCategory } from '@stations/contracts';
  import { createWindyData, type WindyDataSnapshot } from './data.ts';
  import { createStationMarkers, listenToViewport } from './markers.ts';
  import { presentStation } from './presentation.ts';

  let enabled = true;
  let category: StationCategory | '' = '';
  let selectedUid: string | null = null;
  let snapshot: WindyDataSnapshot | null = null;
  let nowMs = 0;
  let windMetric = metrics.wind;
  let ticker: number | undefined;
  let data: ReturnType<typeof createWindyData> | null = null;
  let markers: ReturnType<typeof createStationMarkers> | null = null;

  $: selectedEntry = snapshot?.entries.find(entry => entry.station.uid === selectedUid) ?? null;
  $: detail = selectedEntry ? presentStation(selectedEntry, windMetric, nowMs) : null;

  function renderMarkers() {
    if (enabled && !document.hidden && snapshot) markers?.update(snapshot.entries, windMetric, nowMs);
  }

  function viewportChanged() {
    if (!data || !enabled || document.hidden) return;
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
      data.suspend();
      window.clearInterval(ticker);
      ticker = undefined;
      if (!enabled) {
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
    renderMarkers();
  }

  onMount(() => {
    markers = createStationMarkers(map, uid => { selectedUid = uid; });
    data = createWindyData({
      client: createStationsClient({ baseUrl: process.env.STATIONS_API_BASE_URL }),
      onChange(next) {
        snapshot = next;
        if (selectedUid && !next.entries.some(entry => entry.station.uid === selectedUid)) selectedUid = null;
        nowMs = performance.now();
        renderMarkers();
      },
    });
    snapshot = data.getSnapshot();
    const stopViewport = listenToViewport(map, viewportChanged);
    broadcast.on('metricChanged', metricChanged);
    document.addEventListener('visibilitychange', visibilityChanged);
    visibilityChanged();

    return () => {
      window.clearInterval(ticker);
      document.removeEventListener('visibilitychange', visibilityChanged);
      broadcast.off('metricChanged', metricChanged);
      stopViewport();
      data?.destroy();
      markers?.clear();
      data = null;
      markers = null;
    };
  });
</script>

<section class="plugin__content stations-panel" aria-label="Station observations">
  <h2>Station observations</h2>
  <div class="controls">
    <label><input type="checkbox" bind:checked={enabled} on:change={visibilityChanged} /> Show stations</label>
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
  <p class="note">Current station measurements, not observations at the forecast time. Arrows point toward the direction the wind comes from.</p>
  {#if enabled && snapshot}
    {#if snapshot.catalogueStatus === 'loading'}
      <p role="status">Loading station catalogue...</p>
    {:else if snapshot.catalogueError}
      <p role="alert">Catalogue {snapshot.catalogueStatus === 'error' ? 'load' : 'refresh'} failed: {snapshot.catalogueError.message}</p>
    {/if}
    {#if snapshot.catalogueStatus === 'ready'}
      <p role="status">Showing {snapshot.selectedCount} of {snapshot.visibleTotal} visible stations.{#if snapshot.capped} Zoom in to see more.{/if}</p>
    {/if}
    {#if snapshot.degraded}
      <p role="alert">Some station refreshes failed. Retained readings may be out of date.</p>
    {/if}
  {/if}
  {#if enabled && selectedEntry && detail}
    <section class="detail" aria-label="Station details">
      <div class="detail-heading"><h3>{selectedEntry.station.name}</h3><button type="button" on:click={() => selectedUid = null} aria-label="Close station details">Close</button></div>
      <p>{detail.source} ({selectedEntry.station.vendor})</p>
      <p><strong>{detail.status}</strong>{#if detail.freshness} · {detail.freshness}{/if}</p>
      {#if selectedEntry.unavailable?.status === 'unavailable'}<p>Unavailable: {selectedEntry.unavailable.reason}</p>{/if}
      {#if selectedEntry.error}<p>Refresh error: {selectedEntry.error.message}</p>{/if}
      {#if selectedEntry.status !== 'ok' && selectedEntry.observation}<p>Showing the last retained observation.</p>{/if}
      <dl>
        <dt>Observed</dt><dd>{detail.observedAt ?? 'Not reported'}{#if detail.observedAt} ({detail.age}){/if}</dd>
        <dt>Average</dt><dd>{detail.average}</dd>
        <dt>Gust</dt><dd>{detail.gust}</dd>
        <dt>Direction</dt><dd>{detail.direction}</dd>
        <dt>Temperature</dt><dd>{detail.temperature}</dd>
        <dt>Elevation</dt><dd>{detail.elevation}</dd>
      </dl>
      {#if detail.sourceUrl}<a href={detail.sourceUrl} target="_blank" rel="noopener noreferrer">Station source</a>{/if}
    </section>
  {/if}
</section>

<style>
  .stations-panel { padding: 12px; max-height: 48vh; overflow-y: auto; }
  h2 { font-size: 1.1rem; margin: 0 0 8px; }
  h3, p { margin: 6px 0; }
  .controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  label { display: flex; gap: 5px; align-items: center; }
  button, select { min-height: 40px; }
  input { min-width: 20px; min-height: 20px; }
  .note { font-size: 0.85em; }
  .detail { border-top: 1px solid currentColor; margin-top: 8px; padding-top: 6px; }
  .detail-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 8px 0; }
  dt { font-weight: 600; }
  dd { margin: 0; overflow-wrap: anywhere; }
  :global(.stations-marker) { background: transparent; border: 0; cursor: pointer; }
  :global(.stations-marker-label) { display: flex; flex-wrap: wrap; justify-content: center; align-content: center; align-items: center; gap: 2px 4px; box-sizing: border-box; min-width: 64px; min-height: 44px; padding: 3px; border: 2px solid #1d506a; border-radius: 8px; background: #fff; color: #12242e; font: 600 11px/1.1 sans-serif; box-shadow: 0 1px 4px #0008; }
  :global(.stations-marker-arrow) { display: inline-block; font-size: 16px; }
  :global(.stations-marker-state) { flex-basis: 100%; text-align: center; font-size: 9px; }
  :global(.stations-marker-aging), :global(.stations-marker-stale), :global(.stations-marker-refresh-failed), :global(.stations-marker-unavailable) { border-color: #b44d20; }
  :global(.stations-marker:focus-visible) { outline: 3px solid #ff9b25; outline-offset: 2px; }
</style>
