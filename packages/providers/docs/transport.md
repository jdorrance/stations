# Provider transport

`createProviderFetch` owns a reusable request scheduler. Its input is a fetch
implementation and optional retry/rate settings; its output is a standard fetch
function suitable for `environment.fetch`. See [public options](../src/transport.ts)
for units, defaults and validation.

```ts
import { createProviderFetch, createStationsApiHandler } from '@stations/providers';

// Create once, then reuse across handlers and discovery calls.
const fetch = createProviderFetch({
  maxAttempts: 3,
  origins: {
    'https://api.weather.gov': { maxConcurrent: 2, minIntervalMs: 1500 },
  },
});

export const handler = createStationsApiHandler({
  catalogue,
  environment: { fetch },
});
```

Without an explicit transport, calls using the same underlying fetch share a
default scheduler. Supplying an already managed fetch does not add another retry
layer. This covers this package's discovery functions, individual live adapters,
API handler, and exported server loaders. Direct imports from
`@azohra/meteo.station/server` remain upstream APIs; pass a managed fetch into
their environment to apply this policy.

## Retry behavior

- Only GET and HEAD are retried. POST/login and other methods are sent once.
- Network errors, connection timeouts, and HTTP 408, 429, 500, 502, 503 and 504
  are eligible. Authentication errors and other terminal statuses are returned
  immediately. Parsed-data errors are outside the transport and are not retried.
- The delay is random between zero and the exponentially increasing ceiling,
  capped by `maxDelayMs`. A valid `Retry-After` delta or HTTP date is a minimum
  delay and is never shortened to the backoff cap.
- A 429 response, or a retryable response with `Retry-After`, also sets an
  origin-wide cooldown. That cooldown persists after the triggering caller
  exhausts its attempts or times out.
- Failed response bodies are cancelled before retrying. After the last attempt,
  the final response is returned unchanged for the existing adapter to classify.
- A successful response is returned unchanged. Body-read failures and live SSE
  disconnections are not replayed by this transport.

## Limits and cancellation

Spacing applies to every request start, including retries. Concurrency counts
fetch attempts awaiting headers; it does not count the lifetime of a returned
body or live stream. Waiting requests are bounded by `maxQueueSize`, and overflow
fails immediately. Origins progress independently, with FIFO scheduling within
each origin. Credentials and URL query parameters are not scheduler keys, so all
accounts sharing an origin share its conservative allowance.

`maxElapsedMs` covers queuing, retry waits and connections. `attemptTimeoutMs`
starts only after admission to the scheduler. Caller signals can end either
phase sooner; cancellation removes queued work and clears timers. The existing
upstream deadline (commonly four seconds) is preserved and includes scheduler
waits. Raising `maxElapsedMs` does not extend that outer deadline. Under load,
requests may become unavailable rather than exceed their deadline or bypass the
rate limit. Large feeds should account for this when setting request budgets.

Limits are **in-process**, not a distributed quota service. Reuse one transport
per server process; coordinate across replicas separately. Origin overrides
should reflect the upstream service's allowance and your account's quota. A
default limit is not a promise that every provider permits that request volume.

Existing caching and duplicate-load coalescing run above the transport, so cache
hits do not consume a request slot. No retry logic changes observations,
credentials, catalogue data or cache authorization scopes.
