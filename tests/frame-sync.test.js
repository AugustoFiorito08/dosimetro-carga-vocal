// Sending the primary frames to Supabase in parts (odd/tasks/tramas-primarias.md, T4, S3, S7).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CATEGORIES } from '../src/dsp/frame-classifier.js';
import { createFrameLog } from '../src/store/frame-record.js';
import { FRAME_PART_FORMAT, buildFrameParts, validateFramePart } from '../src/store/frame-sync.js';
import { createMemoryFrameStore } from '../src/store/frame-store.js';
import { createMemoryOutbox } from '../src/store/outbox.js';
import { createMemoryRepository } from '../src/store/workday-repository.js';
import { createSyncService, createSyncingRepository, enqueueFrames } from '../src/store/sync-service.js';
import { SUPABASE_FRAMES_FUNCTION, createSupabaseTransport } from '../src/store/supabase-transport.js';

const DT = 2048 / 48000;
const KEY = 'S-20261127-080000-P-1';

function frameEntry(workdayId = KEY, n = 4000) {
  const log = createFrameLog({ sampleRate: 48000, frameSize: 2048, pressureScale: { mode: 'own_voice', a0Rms: 0.05 }, referencePressure: 1, units: 'normalized', algorithmVersion: 'test' });
  for (let i = 0; i < n; i++) {
    log.push({ dt: DT, rms: 0.01 + ((i * 7919) % 997) / 20000, f0: 150 + ((i * 31) % 97), snrDb: 20 + (i % 13), V: 1, W: 1, Q: 1, phi: i % 4 ? 1 : 0, category: CATEGORIES.ATTRIBUTED }, i * DT);
  }
  return { workdayId, ...log.encode() };
}

describe('frame part contract (vd-des-frames-part/1)', () => {
  it('splits a record in ordered parts that carry the header and the sync key', async () => {
    const parts = await buildFrameParts(frameEntry(), KEY, { maxChars: 2000 });
    assert.ok(parts.length > 1);
    parts.forEach((p, i) => {
      assert.equal(p.format, FRAME_PART_FORMAT);
      assert.equal(p.syncKey, KEY);
      assert.equal(p.part, i);
      assert.equal(p.parts, parts.length);
      assert.equal(p.header.frameCount, 4000);
      assert.doesNotThrow(() => validateFramePart(p));
    });
  });

  it('rejects a broken part', async () => {
    const [p] = await buildFrameParts(frameEntry(), KEY);
    for (const bad of [{ ...p, format: 'x' }, { ...p, part: 1, parts: 1 }, { ...p, data: 'not base64!' }, { ...p, data: '' }, { ...p, syncKey: '' }, { ...p, extra: 1 }, { ...p, header: { ...p.header, schema: 'x' } }]) {
      assert.throws(() => validateFramePart(bad), RangeError);
    }
  });
});

describe('Supabase transport for frame parts', () => {
  it('posts each part to its own function with the upload token', async () => {
    const calls = [];
    const fetch = async (url, init) => { calls.push({ url, init }); return new Response('1', { status: 200 }); };
    const transport = createSupabaseTransport({ url: 'https://demo.supabase.co', anonKey: 'anon', uploadToken: 'tok', fetch });
    const [p] = await buildFrameParts(frameEntry(), KEY);
    await transport.sendFrames(p);
    assert.equal(calls[0].url, `https://demo.supabase.co/rest/v1/rpc/${SUPABASE_FRAMES_FUNCTION}`);
    assert.equal(calls[0].init.headers['x-upload-token'], 'tok');
    assert.deepEqual(JSON.parse(calls[0].init.body), { payload: p });
    await assert.rejects(transport.sendFrames({ ...p, part: 9 }), (e) => e.permanent === true);
  });
});

/** Service over memory adapters; the transport records workdays and frame parts in order. */
function setup({ failFramePart = null } = {}) {
  let clock = Date.UTC(2026, 10, 27, 12);
  const now = () => new Date(clock);
  const sent = [];
  const transport = {
    async send(payload) { sent.push(['workday', payload.workdays[0].id]); },
    async sendFrames(part) {
      if (failFramePart !== null && part.part === failFramePart) {
        failFramePart = null;
        throw Object.assign(new Error('503'), { permanent: false });
      }
      sent.push(['frames', part.part]);
    },
  };
  const outbox = createMemoryOutbox();
  const repository = createMemoryRepository();
  const frames = createMemoryFrameStore();
  const service = createSyncService({ transport, outbox, repository, frames, now, random: () => 0.5, baseDelayMs: 1000, maxDelayMs: 1000, framePartChars: 2000 });
  return { service, outbox, repository, frames, sent, advance: (ms) => { clock += ms; }, now };
}

const workdayItem = (now) => ({
  key: KEY, workdayId: KEY, rev: 'r1', state: 'pending', attempts: 0, nextAttemptAt: now().getTime(), enqueuedAt: now().toISOString(), lastError: null,
  record: { schema: 'vd-des-workday/1', id: KEY, participantId: 'P-1', schoolId: 'E-1', classroom: '1A', date: '2026-11-27', durationS: 1, phonationS: 1, source: 'live', fatigue: { pre: null, post: null }, events: [] },
});

describe('sync service: frames after their workday, resumable by part', () => {
  it('sends the workday first, then every part in order, and purges the local frames', async () => {
    const s = setup();
    await s.frames.put(frameEntry());
    await s.outbox.put(workdayItem(s.now));
    await enqueueFrames(s.outbox, { workdayId: KEY, syncKey: KEY, now: s.now });
    const r = await s.service.flush();
    const parts = s.sent.filter(([k]) => k === 'frames').map(([, p]) => p);
    assert.deepEqual(s.sent[0], ['workday', KEY]);
    assert.ok(parts.length > 1);
    assert.deepEqual(parts, parts.map((_, i) => i));
    assert.equal(r.sent, 2);
    assert.deepEqual(await s.outbox.list(), []);
    assert.equal(await s.frames.get(KEY), null);
  });

  it('frames queued while their workday is being sent go in the same flush', async () => {
    const s = setup();
    await s.frames.put(frameEntry());
    await s.outbox.put(workdayItem(s.now));
    const first = s.service.flush(); // the workday run starts
    await enqueueFrames(s.outbox, { workdayId: KEY, syncKey: KEY, now: s.now });
    const second = s.service.flush(); // during that run
    assert.equal(second, first, 'concurrent calls share the run');
    await first;
    assert.ok(s.sent.some(([k]) => k === 'frames'));
    assert.deepEqual(await s.outbox.list(), []);
  });

  it('frames wait while their workday is still queued', async () => {
    const s = setup();
    await s.frames.put(frameEntry());
    await s.outbox.put({ ...workdayItem(s.now), state: 'rejected' });
    await enqueueFrames(s.outbox, { workdayId: KEY, syncKey: KEY, now: s.now });
    await s.service.flush();
    assert.deepEqual(s.sent, []);
    assert.equal((await s.outbox.list()).length, 2);
  });

  it('a failed part is retried later from that part, not from the start', async () => {
    const s = setup({ failFramePart: 1 });
    await s.frames.put(frameEntry());
    await enqueueFrames(s.outbox, { workdayId: KEY, syncKey: KEY, now: s.now });
    await s.service.flush();
    assert.deepEqual(s.sent, [['frames', 0]]);
    const [item] = await s.outbox.list();
    assert.equal(item.nextPart, 1);
    s.advance(5000);
    await s.service.flush();
    const sentParts = s.sent.map(([, p]) => p);
    assert.equal(sentParts.filter((p) => p === 0).length, 1, 'part 0 is not sent again');
    assert.deepEqual(sentParts, sentParts.map((_, i) => i), 'each part once, in order');
    assert.ok(sentParts.length >= 2);
    assert.deepEqual(await s.outbox.list(), []);
  });

  it('a frames item whose frames are gone is dropped', async () => {
    const s = setup();
    await enqueueFrames(s.outbox, { workdayId: KEY, syncKey: KEY, now: s.now });
    await s.service.flush();
    assert.deepEqual(await s.outbox.list(), []);
    assert.deepEqual(s.sent, []);
  });

  it('deleting the workday also cancels its frames upload', async () => {
    const s = setup();
    const syncing = createSyncingRepository(s.repository, s.outbox, { now: s.now });
    await enqueueFrames(s.outbox, { workdayId: KEY, syncKey: KEY, now: s.now });
    await syncing.remove(KEY);
    assert.deepEqual(await s.outbox.list(), []);
  });
});

describe('reference SQL for the frames (supabase/workday_sync.sql)', () => {
  const lower = readFileSync(new URL('../supabase/workday_sync.sql', import.meta.url), 'utf8').toLowerCase();

  it('keeps the parts in their own table, removed with their workday', () => {
    assert.match(lower, /create table if not exists public\.workday_frames\s*\(/);
    assert.match(lower, /sync_key\s+text not null references public\.workday_sync \(sync_key\) on delete cascade/);
    assert.match(lower, /primary key \(sync_key, part\)/);
    assert.match(lower, /alter table public\.workday_frames enable row level security/);
    assert.match(lower, /revoke all on public\.workday_frames from anon, authenticated/);
    assert.match(lower, /create policy [\s\S]*on public\.workday_frames for select to authenticated/);
  });

  it('uploads through a token-checked function, idempotent by sync key and part', () => {
    assert.match(lower, new RegExp(`create or replace function public\\.${SUPABASE_FRAMES_FUNCTION}\\(payload jsonb\\)`));
    assert.match(lower, /vd-des-frames-part\/1/);
    assert.match(lower, /on conflict \(sync_key, part\) do update/);
    assert.match(lower, /delete from public\.workday_frames f\s+where f\.sync_key = key and f\.part >= total/);
    assert.match(lower, /grant execute on function public\.upload_workday_frames\(jsonb\) to anon/);
  });
});
