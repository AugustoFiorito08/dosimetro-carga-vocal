import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createScoreSeries } from '../src/ui/score-series.js';
import { buildWorkday } from '../src/store/workday.js';
import { createMemoryRepository } from '../src/store/workday-repository.js';
import { createMemoryOutbox } from '../src/store/outbox.js';
import { SYNC_FIELDS, buildSyncPayload, syncKey } from '../src/store/workday-sync.js';
import { createSyncService, createSyncingRepository } from '../src/store/sync-service.js';
import {
  SUPABASE_UPSERT_FUNCTION,
  SyncTransportError,
  classifyStatus,
  createSupabaseTransport,
} from '../src/store/supabase-transport.js';

const URL_BASE = 'https://abcdefgh.supabase.co';
const ANON = 'anon-public-key';
const TOKEN = 'upload-token-SECRET-value';
const UUID = '3f6c2a1e-9b7d-4c3a-8e2f-1a2b3c4d5e6f';

function workday({ participantId = 'P-0421', sessionUuid = UUID } = {}) {
  const series = createScoreSeries();
  series.push({ t: 0, dt: 60, phi: 1, f0: 180, level: 80, h: 1, doses: { none: 60, linear: 60, power: 60, exponential: 60, saturating: 60 }, distanceDose: null });
  const load = {
    h: 1, units: 'normalized', ownVoiceReferenceDbfs: -30, params: { beta: 1 / 300 },
    doses: { none: 60, linear: 60, power: 60, exponential: 60, saturating: 60 },
    conventionalDoses: { time: 60, cycle: 10800 }, distanceDose: null,
    metrics: { totalTime: 60, phonationTime: 60, nonPhonationTime: 0, timeByCategory: { attributed: 60, uncertain: 0 } },
  };
  const meta = { participantId, schoolId: 'E-25', classroom: '2B', fatiguePre: null, fatiguePost: null, events: [] };
  return buildWorkday({ meta, load, series, startedAt: new Date(2026, 10, 12, 8), algorithmVersion: '0.8.0', source: 'live', sessionUuid });
}
const payload = () => buildSyncPayload([workday()], { now: new Date('2026-11-23T12:00:00Z') });

/** fetch double: records calls; each response is { status, body } or a function(request) or an Error to throw. */
function fakeFetch(responses = [{ status: 200, body: '1' }]) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.length > 1 ? responses.shift() : responses[0];
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next({ url, init });
    return new Response(next.status === 204 ? null : next.body ?? '', { status: next.status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}
const transportWith = (responses, options = {}) => {
  const f = fakeFetch(responses);
  return { ...f, transport: createSupabaseTransport({ url: URL_BASE, anonKey: ANON, uploadToken: TOKEN, fetch: f.fetch, ...options }) };
};

describe('Supabase transport: configuration', () => {
  it('needs an https url (http only for localhost), the anon key and the upload token, with no defaults', () => {
    const fetch = async () => new Response('');
    assert.throws(() => createSupabaseTransport({ fetch }), /url/);
    assert.throws(() => createSupabaseTransport({ url: 'http://example.org', anonKey: ANON, uploadToken: TOKEN, fetch }), /https/);
    assert.throws(() => createSupabaseTransport({ url: URL_BASE, uploadToken: TOKEN, fetch }), /anonKey/);
    assert.throws(() => createSupabaseTransport({ url: URL_BASE, anonKey: ANON, fetch }), /uploadToken/);
    assert.doesNotThrow(() => createSupabaseTransport({ url: 'http://localhost:54321', anonKey: ANON, uploadToken: TOKEN, fetch }));
    assert.doesNotThrow(() => createSupabaseTransport({ url: 'http://127.0.0.1:54321/', anonKey: ANON, uploadToken: TOKEN, fetch }));
  });

  it('fails clearly without fetch', () => {
    assert.throws(() => createSupabaseTransport({ url: URL_BASE, anonKey: ANON, uploadToken: TOKEN, fetch: undefined }), /fetch/);
  });
});

describe('Supabase transport: request (idempotent upsert RPC)', () => {
  it('POSTs the vd-des-workdays/1 envelope to the upsert function with the keys in headers', async () => {
    const { transport, calls } = transportWith([{ status: 200, body: '1' }]);
    const p = payload();
    const result = await transport.send(p);
    assert.deepEqual(result, { status: 200, accepted: 1 });
    const [{ url, init, body }] = calls;
    assert.equal(url, `${URL_BASE}/rest/v1/rpc/${SUPABASE_UPSERT_FUNCTION}`);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.apikey, ANON);
    assert.equal(init.headers.Authorization, `Bearer ${ANON}`);
    assert.equal(init.headers['x-upload-token'], TOKEN);
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(body, { payload: p });
    assert.ok(init.signal, 'abortable');
  });

  it('a retry sends the same sync key, so the server upsert replaces instead of duplicating', async () => {
    const { transport, calls } = transportWith([{ status: 503 }, { status: 200, body: '1' }]);
    const p = payload();
    await assert.rejects(transport.send(p));
    await transport.send(p);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, calls[1].body);
    assert.equal(syncKey(calls[1].body.payload.workdays[0]), UUID);
  });

  it('only contract fields leave the device', async () => {
    const { transport, calls } = transportWith();
    await transport.send(payload());
    for (const record of calls[0].body.payload.workdays) {
      assert.deepEqual(Object.keys(record).filter((k) => !SYNC_FIELDS.includes(k)), []);
    }
  });

  it('refuses an invalid payload before any request, as a permanent error', async () => {
    const { transport, calls } = transportWith();
    await assert.rejects(transport.send({ format: 'other', workdays: [] }), (e) => e instanceof SyncTransportError && e.permanent && e.code === 'invalid_payload');
    assert.equal(calls.length, 0);
  });

  it('trims a trailing slash of the url', async () => {
    const { transport, calls } = transportWith([{ status: 204 }], { url: `${URL_BASE}/` });
    assert.deepEqual(await transport.send(payload()), { status: 204, accepted: null });
    assert.equal(calls[0].url, `${URL_BASE}/rest/v1/rpc/${SUPABASE_UPSERT_FUNCTION}`);
  });
});

describe('Supabase transport: response classification', () => {
  it('maps statuses to permanent or retryable', () => {
    assert.deepEqual(classifyStatus(400), { code: 'invalid', permanent: true });
    assert.deepEqual(classifyStatus(401), { code: 'unauthorized', permanent: true });
    assert.deepEqual(classifyStatus(403), { code: 'forbidden', permanent: true });
    assert.deepEqual(classifyStatus(404), { code: 'not_found', permanent: true });
    assert.deepEqual(classifyStatus(409), { code: 'conflict', permanent: true });
    assert.deepEqual(classifyStatus(413), { code: 'too_large', permanent: true });
    assert.deepEqual(classifyStatus(422), { code: 'invalid', permanent: true });
    assert.deepEqual(classifyStatus(408), { code: 'timeout', permanent: false });
    assert.deepEqual(classifyStatus(425), { code: 'rate_limited', permanent: false });
    assert.deepEqual(classifyStatus(429), { code: 'rate_limited', permanent: false });
    for (const s of [500, 502, 503, 504]) assert.deepEqual(classifyStatus(s), { code: 'server_error', permanent: false });
  });

  for (const [status, code, permanent] of [
    [400, 'invalid', true], [401, 'unauthorized', true], [403, 'forbidden', true], [409, 'conflict', true],
    [429, 'rate_limited', false], [500, 'server_error', false], [503, 'server_error', false],
  ]) {
    it(`${status} rejects with code ${code}, permanent=${permanent}`, async () => {
      const { transport } = transportWith([{ status, body: JSON.stringify({ message: 'details from the server' }) }]);
      const error = await transport.send(payload()).catch((e) => e);
      assert.ok(error instanceof SyncTransportError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.equal(error.permanent, permanent);
      assert.match(error.message, new RegExp(`${status}.*details from the server`));
    });
  }

  it('a network failure is retryable', async () => {
    const { transport } = transportWith([new TypeError('Failed to fetch')]);
    const error = await transport.send(payload()).catch((e) => e);
    assert.equal(error.code, 'network');
    assert.equal(error.permanent, false);
    assert.equal(error.status, null);
  });

  it('a request slower than timeoutMs is aborted and retryable', async () => {
    const hang = ({ init }) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
    const { transport } = transportWith([hang], { timeoutMs: 20 });
    const error = await transport.send(payload()).catch((e) => e);
    assert.equal(error.code, 'timeout');
    assert.equal(error.permanent, false);
  });

  it('never puts the upload token or the anon key in an error message', async () => {
    const echo = { status: 401, body: JSON.stringify({ message: `bad token ${TOKEN} for ${ANON}` }) };
    const { transport } = transportWith([echo]);
    const error = await transport.send(payload()).catch((e) => e);
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    assert.doesNotMatch(error.message, new RegExp(ANON));
  });

  it('caps a long error body', async () => {
    const { transport } = transportWith([{ status: 500, body: 'x'.repeat(5000) }]);
    const error = await transport.send(payload()).catch((e) => e);
    assert.ok(error.message.length < 400);
  });
});

describe('Supabase transport with the F1 sync service', () => {
  function wired(responses) {
    const f = fakeFetch(responses);
    const repository = createMemoryRepository();
    const outbox = createMemoryOutbox();
    let ms = Date.UTC(2026, 10, 23, 12);
    const now = () => new Date(ms);
    const syncing = createSyncingRepository(repository, outbox, { now });
    const transport = createSupabaseTransport({ url: URL_BASE, anonKey: ANON, uploadToken: TOKEN, fetch: f.fetch });
    const service = createSyncService({ transport, outbox, repository, now, random: () => 0, baseDelayMs: 1000, maxDelayMs: 60000 });
    return { ...f, repository, outbox, syncing, service, advance: (d) => { ms += d; } };
  }

  it('503 is retried with backoff, then 200 confirms and purges the local summary', async () => {
    const w = wired([{ status: 503 }, { status: 200, body: '1' }]);
    await w.syncing.save(workday());
    assert.deepEqual(await w.service.flush(), { sent: 0, failed: 1, skipped: null });
    assert.ok(await w.repository.get(workday().id), 'kept while pending');
    w.advance(500);
    assert.deepEqual(await w.service.flush(), { sent: 1, failed: 0, skipped: null });
    assert.equal(await w.repository.get(workday().id), null);
    assert.deepEqual(await w.outbox.list(), []);
  });

  it('401 marks the item rejected and keeps the local summary', async () => {
    const w = wired([{ status: 401, body: '{"message":"invalid upload token"}' }]);
    await w.syncing.save(workday());
    await w.service.flush();
    const [item] = await w.outbox.list();
    assert.equal(item.state, 'rejected');
    assert.match(item.lastError, /401/);
    assert.ok(await w.repository.get(workday().id));
    w.advance(3600 * 1000);
    await w.service.flush();
    assert.equal(w.calls.length, 1, 'not retried in a loop');
  });

  it('a timeout leaves the item pending for a later retry', async () => {
    const hang = ({ init }) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const f = fakeFetch([hang]);
    const repository = createMemoryRepository();
    const outbox = createMemoryOutbox();
    const syncing = createSyncingRepository(repository, outbox);
    const transport = createSupabaseTransport({ url: URL_BASE, anonKey: ANON, uploadToken: TOKEN, fetch: f.fetch, timeoutMs: 10 });
    const service = createSyncService({ transport, outbox, repository });
    await syncing.save(workday());
    assert.equal((await service.flush()).failed, 1);
    const [item] = await outbox.list();
    assert.equal(item.state, 'pending');
    assert.match(item.lastError, /timeout|tiempo/i);
  });
});

describe('reference SQL (supabase/workday_sync.sql)', () => {
  const sql = readFileSync(new URL('../supabase/workday_sync.sql', import.meta.url), 'utf8');
  const lower = sql.toLowerCase();

  it('creates the table keyed by the sync key, its indexes and enables RLS on every table', () => {
    assert.match(lower, /create table if not exists public\.workday_sync\s*\(/);
    assert.match(lower, /sync_key\s+text\s+primary key/);
    assert.match(lower, /record\s+jsonb\s+not null/);
    for (const table of ['workday_sync', 'upload_tokens', 'analysts']) {
      assert.match(lower, new RegExp(`alter table public\\.${table} enable row level security`), table);
    }
    assert.match(lower, /create index if not exists \w+ on public\.workday_sync \(school_id, work_date\)/);
  });

  it('uploads only through the upsert function, by name, with an idempotent on conflict', () => {
    assert.match(lower, new RegExp(`create or replace function public\\.${SUPABASE_UPSERT_FUNCTION}\\(payload jsonb\\)`));
    assert.match(lower, /security definer/);
    assert.match(lower, /set search_path = ''/);
    assert.match(lower, /on conflict \(sync_key\) do update/);
    assert.match(lower, /grant execute on function public\.upsert_workdays\(jsonb\) to anon/);
    assert.match(lower, /revoke all on public\.workday_sync from anon, authenticated/);
    assert.doesNotMatch(lower, /grant (insert|update|delete|all)[^;]* on (table )?public\.workday_sync to anon/);
  });

  it('checks the upload token by hash, scoped to its school, and the contract fields', () => {
    assert.match(lower, /request\.headers/);
    assert.match(lower, /x-upload-token/);
    assert.match(lower, /digest\(/);
    assert.match(lower, /token_hash/);
    for (const field of SYNC_FIELDS) assert.ok(sql.includes(`'${field}'`), `allow-list includes ${field}`);
    assert.match(lower, /in_progress/);
  });

  it('lets analysts read through RLS and holds no secret', () => {
    assert.match(lower, /create policy [\s\S]*on public\.workday_sync for select to authenticated/);
    assert.doesNotMatch(sql, /eyJ[A-Za-z0-9_-]{10,}/, 'no JWT / key in the file');
  });
});
