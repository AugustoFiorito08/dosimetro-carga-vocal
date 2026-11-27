// Supabase transport for the sync service (spec §14.1), with plain fetch and no SDK.
// It calls one Postgres function through PostgREST, `upsert_workdays(payload jsonb)`
// (supabase/workday_sync.sql), which checks the upload token and upserts every workday by
// its sync key: a retry replaces the row instead of duplicating it. The anon key is public
// by design; access is decided by the function and RLS. Nothing here has a default
// endpoint or credential: it sends nothing until it is configured (F3).
import { validateSyncPayload } from './workday-sync.js';
import { validateFramePart } from './frame-sync.js';

export const SUPABASE_UPSERT_FUNCTION = 'upsert_workdays';
/** Function that stores one part of a workday's primary frames (supabase/workday_sync.sql). */
export const SUPABASE_FRAMES_FUNCTION = 'upload_workday_frames';
export const DEFAULT_TIMEOUT_MS = 15000;
const MAX_DETAIL_CHARS = 200;

/** A failed send. `permanent` tells the sync service not to retry (createSyncService). */
export class SyncTransportError extends Error {
  constructor(message, { status = null, code, permanent }) {
    super(message);
    this.name = 'SyncTransportError';
    this.status = status;
    this.code = code;
    this.permanent = permanent;
  }
}

/**
 * HTTP status -> { code, permanent }. Retrying cannot fix a bad request, a refused or
 * revoked token, a missing function, a conflict with another school's record or a body
 * too large; timeouts, rate limits and server errors are retried with backoff.
 */
export function classifyStatus(status) {
  if (status === 401) return { code: 'unauthorized', permanent: true };
  if (status === 403) return { code: 'forbidden', permanent: true };
  if (status === 404) return { code: 'not_found', permanent: true };
  if (status === 408) return { code: 'timeout', permanent: false };
  if (status === 409) return { code: 'conflict', permanent: true };
  if (status === 413) return { code: 'too_large', permanent: true };
  if (status === 425 || status === 429) return { code: 'rate_limited', permanent: false };
  if (status >= 500) return { code: 'server_error', permanent: false };
  return { code: 'invalid', permanent: true }; // 400, 422 and any other 4xx
}

function checkUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new RangeError('Supabase url is required (https://<project>.supabase.co)');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    throw new RangeError('Supabase url must use https (http is only allowed for localhost)');
  }
  return parsed.href.replace(/\/+$/, '');
}

/**
 * @param {object} config
 * @param {string} config.url project URL, e.g. https://<project>.supabase.co
 * @param {string} config.anonKey the project's public anon key
 * @param {string} config.uploadToken the upload token issued for this device or school
 * @param {typeof fetch} [config.fetch]
 * @param {number} [config.timeoutMs]
 * @returns {{ send(payload: object): Promise<{ status: number, accepted: number | null }>,
 *   sendFrames(part: object): Promise<{ status: number, accepted: number | null }> }}
 */
export function createSupabaseTransport(config = {}) {
  const { url, anonKey, uploadToken, timeoutMs = DEFAULT_TIMEOUT_MS, functionName = SUPABASE_UPSERT_FUNCTION, timers = globalThis } = config;
  // An explicit `fetch` (even undefined) wins over the global, so a missing one is reported.
  const fetch = 'fetch' in config ? config.fetch : globalThis.fetch;
  const base = checkUrl(url);
  if (typeof anonKey !== 'string' || !anonKey) throw new RangeError('Supabase anonKey is required');
  if (typeof uploadToken !== 'string' || !uploadToken) throw new RangeError('Supabase uploadToken is required');
  if (typeof fetch !== 'function') throw new TypeError('fetch is not available in this environment');
  if (!(timeoutMs > 0)) throw new RangeError(`timeoutMs must be > 0, got ${timeoutMs}`);
  const endpoint = (name) => `${base}/rest/v1/rpc/${name}`;
  const secrets = [uploadToken, anonKey];

  /** Server detail for the message, short and without our credentials. */
  const redact = (text) => secrets.reduce((t, s) => t.split(s).join('[redacted]'), String(text)).slice(0, MAX_DETAIL_CHARS);

  async function detailOf(response) {
    try {
      const text = await response.text();
      try {
        const json = JSON.parse(text);
        return redact(json?.message ?? json?.error ?? text);
      } catch {
        return redact(text);
      }
    } catch {
      return '';
    }
  }

  /** POSTs `{ payload }` to an RPC function after `validate(payload)`; throws SyncTransportError. */
  async function post(name, payload, validate) {
    try {
      validate(payload);
    } catch (error) {
      throw new SyncTransportError(`invalid payload: ${error.message}`, { code: 'invalid_payload', permanent: true });
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = timers.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    let response;
    try {
      response = await fetch(endpoint(name), {
        method: 'POST',
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${anonKey}`,
          'Content-Type': 'application/json',
          'x-upload-token': uploadToken,
        },
        body: JSON.stringify({ payload }),
        signal: controller.signal,
      });
    } catch (error) {
      if (timedOut) throw new SyncTransportError(`Supabase timeout after ${timeoutMs} ms`, { code: 'timeout', permanent: false });
      throw new SyncTransportError(`Supabase network error: ${redact(error?.message ?? error)}`, { code: 'network', permanent: false });
    } finally {
      timers.clearTimeout(timer);
    }
    if (response.ok) {
      let accepted = null;
      try {
        const text = await response.text();
        const value = text ? JSON.parse(text) : null;
        accepted = typeof value === 'number' ? value : null;
      } catch {
        accepted = null; // confirmed anyway: the status is what counts
      }
      return { status: response.status, accepted };
    }
    const { code, permanent } = classifyStatus(response.status);
    const detail = await detailOf(response);
    throw new SyncTransportError(`Supabase ${response.status} ${code}${detail ? `: ${detail}` : ''}`, { status: response.status, code, permanent });
  }

  return {
    /** One envelope of workday summaries (vd-des-workdays/1). */
    send: (payload) => post(functionName, payload, validateSyncPayload),
    /** One part of a workday's primary frames (vd-des-frames-part/1). */
    sendFrames: (part) => post(SUPABASE_FRAMES_FUNCTION, part, validateFramePart),
  };
}
