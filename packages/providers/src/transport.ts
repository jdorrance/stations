/** Limits are shared by requests to the same URL origin within one fetch instance. */
export interface ProviderRateLimit {
  /** Maximum simultaneous fetch attempts awaiting response headers. Default: 2. */
  readonly maxConcurrent?: number;
  /** Minimum spacing between request starts, including retries. Default: 1000 ms. */
  readonly minIntervalMs?: number;
}

export interface ProviderFetchOptions extends ProviderRateLimit {
  readonly fetch?: typeof fetch;
  /** Total attempts for GET/HEAD, including the first request. Default: 3. */
  readonly maxAttempts?: number;
  /** Full-jitter exponential backoff starts at this ceiling. Default: 500 ms. */
  readonly baseDelayMs?: number;
  /** Backoff ceiling; does not truncate Retry-After. Default: 10000 ms. */
  readonly maxDelayMs?: number;
  /** Connection/headers deadline per attempt. Default: 4000 ms. */
  readonly attemptTimeoutMs?: number;
  /** Queue, backoff and connection budget per call. Default: 15000 ms. */
  readonly maxElapsedMs?: number;
  /** Maximum waiting calls per origin. Default: 100. */
  readonly maxQueueSize?: number;
  /** Exact HTTP(S) origins may override concurrency and spacing. */
  readonly origins?: Readonly<Record<string, ProviderRateLimit>>;
}

type Limit = Required<ProviderRateLimit>;
type Ticket = {
  signal: AbortSignal;
  abort: () => void;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
};
type OriginState = {
  limit: Limit;
  active: number;
  callers: number;
  nextStart: number;
  blockedUntil: number;
  queue: Ticket[];
  timer?: ReturnType<typeof setTimeout>;
};

const managedFetches = new WeakSet<typeof fetch>();
const defaultFetches = new WeakMap<typeof fetch, typeof fetch>();
const nativeFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_TIMER_MS = 2_147_483_647;

function numberOption(value: number, name: string, minimum: number, integer = false): number {
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) {
    throw new RangeError(`Invalid ${name}`);
  }
  return value;
}

function rateLimit(options: ProviderRateLimit, fallback: Limit): Limit {
  return {
    maxConcurrent: numberOption(options.maxConcurrent ?? fallback.maxConcurrent, 'maxConcurrent', 1, true),
    minIntervalMs: numberOption(options.minIntervalMs ?? fallback.minIntervalMs, 'minIntervalMs', 0),
  };
}

function retryAfterMs(value: string | null): number | null {
  if (value === null || value.trim() === '') return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  // Do not interpret malformed numeric delays as calendar dates.
  if (/^[+-]?[\d.]+$/.test(text)) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? Math.max(0, time - Date.now()) : null;
}

function drain(state: OriginState): void {
  clearTimeout(state.timer);
  state.timer = undefined;
  while (state.queue.length && state.active < state.limit.maxConcurrent) {
    const delay = Math.max(state.nextStart, state.blockedUntil) - Date.now();
    if (delay > 0) {
      state.timer = setTimeout(() => drain(state), Math.min(delay, MAX_TIMER_MS));
      return;
    }
    const ticket = state.queue.shift()!;
    ticket.signal.removeEventListener('abort', ticket.abort);
    if (ticket.signal.aborted) {
      ticket.reject(ticket.signal.reason);
      continue;
    }
    state.active += 1;
    state.nextStart = Date.now() + state.limit.minIntervalMs;
    let released = false;
    ticket.resolve(() => {
      if (released) return;
      released = true;
      state.active -= 1;
      drain(state);
    });
  }
}

function acquire(state: OriginState, signal: AbortSignal, maxQueueSize: number): Promise<() => void> {
  signal.throwIfAborted();
  if (state.queue.length >= maxQueueSize) return Promise.reject(new Error('Provider request queue is full'));
  return new Promise((resolve, reject) => {
    const ticket: Ticket = {
      signal, resolve, reject,
      abort() {
        const index = state.queue.indexOf(ticket);
        if (index !== -1) state.queue.splice(index, 1);
        signal.removeEventListener('abort', ticket.abort);
        reject(signal.reason);
        drain(state);
      },
    };
    signal.addEventListener('abort', ticket.abort, { once: true });
    state.queue.push(ticket);
    drain(state);
  });
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, Math.min(milliseconds, MAX_TIMER_MS));
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** Enforce cancellation even when a custom fetch ignores its signal. */
function abortableFetch(run: () => Promise<Response>, signal: AbortSignal): Promise<Response> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }).then(response => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        reject(signal.reason);
      } else resolve(response);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

/**
 * Creates a reusable, in-process origin limiter and retrying fetch. Only GET and
 * HEAD are replayed; successful response bodies and live streams are never replayed.
 * Caller aborts/deadlines take precedence over this transport's retry budget.
 */
export function createProviderFetch(options: ProviderFetchOptions = {}): typeof fetch {
  const fetchImpl = options.fetch ?? nativeFetch;
  const limit = rateLimit(options, { maxConcurrent: 2, minIntervalMs: 1000 });
  const maxAttempts = numberOption(options.maxAttempts ?? 3, 'maxAttempts', 1, true);
  const baseDelayMs = numberOption(options.baseDelayMs ?? 500, 'baseDelayMs', 0);
  const maxDelayMs = numberOption(options.maxDelayMs ?? 10_000, 'maxDelayMs', 0);
  const attemptTimeoutMs = numberOption(options.attemptTimeoutMs ?? 4000, 'attemptTimeoutMs', 1);
  const maxElapsedMs = numberOption(options.maxElapsedMs ?? 15_000, 'maxElapsedMs', 1);
  const maxQueueSize = numberOption(options.maxQueueSize ?? 100, 'maxQueueSize', 1, true);
  if (attemptTimeoutMs > MAX_TIMER_MS || maxElapsedMs > MAX_TIMER_MS || maxDelayMs > MAX_TIMER_MS) {
    throw new RangeError('Provider timeouts and backoff must fit a JavaScript timer');
  }
  const originLimits = new Map<string, Limit>();
  for (const [origin, override] of Object.entries(options.origins ?? {})) {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new TypeError('Rate limit overrides must use exact HTTP(S) origins');
    }
    originLimits.set(origin, rateLimit(override, limit));
  }
  const states = new Map<string, OriginState>();
  const managed: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const origin = new URL(request?.url ?? String(input)).origin;
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    const replayable = method === 'GET' || method === 'HEAD';
    const callerSignal = init?.signal === null ? undefined : init?.signal ?? request?.signal;
    callerSignal?.throwIfAborted();
    let state = states.get(origin);
    if (!state) {
      // Reclaim idle origins without a timer that would keep a process alive.
      for (const [key, candidate] of states) {
        if (!candidate.callers && !candidate.active && !candidate.queue.length &&
            Math.max(candidate.nextStart, candidate.blockedUntil) <= Date.now()) states.delete(key);
      }
      state = { limit: originLimits.get(origin) ?? limit, active: 0, callers: 0, nextStart: 0, blockedUntil: 0, queue: [] };
      states.set(origin, state);
    }
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(new DOMException('Provider request budget exceeded', 'TimeoutError')), maxElapsedMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, budget.signal]) : budget.signal;
    state.callers += 1;
    try {
      for (let attempt = 0; ; attempt += 1) {
        const release = await acquire(state, signal, maxQueueSize);
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(new DOMException('Provider attempt timed out', 'TimeoutError')), attemptTimeoutMs);
        const attemptSignal = AbortSignal.any([signal, timeout.signal]);
        let response: Response | undefined;
        let failure: unknown;
        const backoff = Math.random() * Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt, 30));
        let wait = backoff;
        try {
          response = await abortableFetch(() => fetchImpl(
            request && attempt > 0 ? request.clone() : input,
            { ...init, signal: attemptSignal },
          ), attemptSignal);
          if (RETRYABLE_STATUS.has(response.status)) {
            wait = Math.max(backoff, retryAfterMs(response.headers.get('Retry-After')) ?? 0);
            if (response.status === 429 || response.headers.has('Retry-After')) {
              state.blockedUntil = Math.max(state.blockedUntil, Date.now() + wait);
            }
          }
        } catch (error) {
          failure = error;
        } finally {
          clearTimeout(timer);
          release();
        }
        if (signal.aborted) {
          void response?.body?.cancel().catch(() => {});
          signal.throwIfAborted();
        }
        const retry = replayable && attempt + 1 < maxAttempts && (response
          ? RETRYABLE_STATUS.has(response.status)
          : failure instanceof TypeError || (failure instanceof Error && ['NetworkError', 'TimeoutError'].includes(failure.name)));
        if (!retry) {
          if (response) return response;
          throw failure;
        }
        // Release rejected response bodies before the next attempt. Cancellation
        // must not prevent the caller's deadline from ending the retry loop.
        void response?.body?.cancel().catch(() => {});
        await sleep(Math.min(wait, maxElapsedMs), signal);
      }
    } finally {
      clearTimeout(budgetTimer);
      state.callers -= 1;
    }
  };
  managedFetches.add(managed);
  return managed;
}

/** Internal default: reuse limiter state across environments sharing a fetch. */
export function providerFetch(fetchImpl: typeof fetch = nativeFetch): typeof fetch {
  if (managedFetches.has(fetchImpl)) return fetchImpl;
  let managed = defaultFetches.get(fetchImpl);
  if (!managed) {
    managed = createProviderFetch({ fetch: fetchImpl });
    defaultFetches.set(fetchImpl, managed);
  }
  return managed;
}
