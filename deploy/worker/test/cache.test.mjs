import assert from 'node:assert/strict';
import test from 'node:test';
import { cacheResponse } from '../cache.ts';

test('a stalled edge fill cancels its owned stream after the I/O budget', async () => {
  let cancelled = false;
  const source = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
    cancel() { cancelled = true; },
  });
  const cache = { put: () => new Promise(() => {}) };
  await cacheResponse(cache, new Request('https://stations.example/cache'), new Response(source), 30, 0, 5);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test('cancelling a failed cache fill leaves the client branch readable', async () => {
  const response = new Response('client response');
  const cache = { put: async () => { throw new Error('offline'); } };
  await cacheResponse(cache, new Request('https://stations.example/cache'), response.clone(), 30, 0, 5);
  assert.equal(await response.text(), 'client response');
});
