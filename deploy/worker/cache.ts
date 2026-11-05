import { withDeadline } from './deadline.ts';

/** Streaming edge responses; cache outages fall through to the source. */
export interface EdgeResponseCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<unknown>;
}

const STORED_AT = 'X-Worker-Cached-At';
const EXPIRES_AT = 'X-Worker-Expires-At';
const CACHE_CONTROL = 'X-Worker-Cache-Control';

export async function cachedResponse(
  cache: EdgeResponseCache | undefined,
  key: Request,
  now: number,
  timeoutMs = 100,
): Promise<Response | null> {
  let match: Promise<Response | undefined> | undefined;
  try {
    match = cache?.match(key);
    const response = match ? await withDeadline(match, timeoutMs, 'Edge cache timed out') : undefined;
    if (!response) return null;
    const expiresAt = Number(response.headers.get(EXPIRES_AT));
    const storedAt = Number(response.headers.get(STORED_AT));
    if (response.status !== 200 || !Number.isFinite(expiresAt) || expiresAt <= now || !Number.isFinite(storedAt)) {
      void response.body?.cancel();
      return null;
    }
    const headers = new Headers(response.headers);
    headers.set('Age', String(Math.max(0, Math.floor((now - storedAt) / 1000))));
    headers.set('Cache-Control', headers.get(CACHE_CONTROL) ?? 'no-store');
    if (headers.has('X-Station-Cache-Ttl')) {
      headers.set('X-Station-Cache-Ttl', String(Math.max(0, Math.floor((expiresAt - now) / 1000))));
    }
    for (const name of [STORED_AT, EXPIRES_AT, CACHE_CONTROL]) headers.delete(name);
    return new Response(response.body, { status: response.status, headers });
  } catch {
    if (match) void match.then(late => { void late?.body?.cancel(); }, () => {});
    return null;
  }
}

export async function cacheResponse(
  cache: EdgeResponseCache | undefined,
  key: Request,
  response: Response,
  ttlSeconds: number,
  now: number,
  timeoutMs = 10_000,
): Promise<void> {
  if (!cache || response.status !== 200 || ttlSeconds <= 0) return;
  const reader = response.body?.getReader();
  try {
    const headers = new Headers(response.headers);
    headers.set(STORED_AT, String(now));
    headers.set(EXPIRES_AT, String(now + ttlSeconds * 1000));
    headers.set(CACHE_CONTROL, headers.get('Cache-Control') ?? 'no-store');
    headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    headers.delete('Age');
    const body = reader ? new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) controller.close();
          else controller.enqueue(value);
        } catch (error) { controller.error(error); }
      },
      cancel: reason => reader.cancel(reason),
    }) : null;
    await withDeadline(cache.put(key, new Response(body, { headers })), timeoutMs, 'Edge cache timed out');
  } catch {
    void reader?.cancel().catch(() => {});
    // A failed cache fill must not discard a successful source response.
  }
}

export function conditionalResponse(response: Response, request: Request): Response {
  const etag = response.headers.get('ETag');
  const matches = etag && request.headers.get('If-None-Match')?.split(',')
    .some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));
  if (matches) {
    void response.body?.cancel();
    const headers = new Headers(response.headers);
    headers.delete('Content-Length');
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') {
    void response.body?.cancel();
    return new Response(null, { status: response.status, headers: response.headers });
  }
  return response;
}
