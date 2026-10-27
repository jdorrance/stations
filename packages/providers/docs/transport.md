# Provider transport

Deep dive for `createProviderFetch`: retries, origin rate limits and
cancellation. Handler-level caching and batching are owned by
[Serving](../../../docs/toolkit-serving.md). Public option types live in
[`transport.ts`](../src/transport.ts).

```ts
import { createProviderFetch, createStationsApiHandler } from '@stations/providers';

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

Create the transport once and reuse it across discovery and the HTTP handler.
Without an explicit transport, callers that share the same underlying fetch
share a default scheduler. Passing an already managed fetch does not wrap
another retry layer.

This policy covers this package’s discovery functions, live adapters, API
handler and exported server loaders. Direct imports from
`@azohra/meteo.station/server` remain upstream APIs — pass a managed fetch into
their environment to apply the same policy.

## Retry behaviour

- Only `GET` and `HEAD` retry. `POST` / login and other methods are sent once.
- Eligible: network errors, connection timeouts, and HTTP 408, 429, 500, 502,
  503, 504. Auth failures and other terminal statuses return immediately.
  Parse errors are outside the transport and are not retried.
- Backoff is random in `[0, ceiling]`, capped by `maxDelayMs`. A valid
  `Retry-After` (delta or HTTP date) is a minimum delay and is never shortened
  to the backoff cap.
- A 429, or any retryable response with `Retry-After`, also sets an origin-wide
  cooldown that outlives the triggering caller’s attempts.
- Failed response bodies are cancelled before retry. After the last attempt the
  final response is returned unchanged for the adapter to classify.
- Successful responses are returned unchanged. Body-read failures and live SSE
  disconnects are not replayed.

## Limits and cancellation

Spacing applies to every request start, including retries. Concurrency counts
attempts awaiting headers — not the lifetime of a returned body or stream.
Waiting requests are bounded by `maxQueueSize`; overflow fails immediately.
Origins progress independently, FIFO within each origin. Credentials and query
parameters are not scheduler keys, so accounts on one origin share its
allowance.

`maxElapsedMs` covers queuing, retry waits and connections. `attemptTimeoutMs`
starts only after admission. Caller signals can end either phase sooner;
cancellation removes queued work and clears timers. The existing upstream
deadline (commonly four seconds) still applies and includes scheduler waits —
raising `maxElapsedMs` does not extend that outer deadline. Under load,
requests may become unavailable rather than exceed their deadline or bypass the
rate limit.

Limits are **in-process**, not a distributed quota. Reuse one transport per
server process; coordinate across replicas separately. Origin overrides should
reflect the upstream allowance and your account quota. A default limit is not a
promise that every provider permits that volume.

Upstream response caching and duplicate-load coalescing run above the
transport, so cache hits do not consume a request slot. Retries never change
observations, credentials, catalogue data or cache authorization scopes.
