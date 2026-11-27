import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createScoreSeries } from '../src/ui/score-series.js';
import { buildWorkday } from '../src/store/workday.js';
import { DB_VERSION, STORES, createMemoryRepository, upgradeDatabase } from '../src/store/workday-repository.js';
import { createMemoryOutbox } from '../src/store/outbox.js';
import { createWorkdayAutosaver, recoverCheckpoints } from '../src/store/workday-autosave.js';
import { SYNC_FORMAT, validateSyncPayload } from '../src/store/workday-sync.js';
import { backoffDelay, createSyncService, createSyncingRepository } from '../src/store/sync-service.js';

const startedAt = new Date(2026, 10, 12, 8, 0, 0);
const UUID = (n) => `3f6c2a1e-9b7d-4c3a-8e2f-${String(n).padStart(12, '0')}`;

function workday({ participantId = 'P-0421', seconds = 60, source = 'live', sessionUuid, minute = 0 } = {}) {
  const series = createScoreSeries();
  series.push({ t: 0, dt: seconds, phi: 1, f0: 180, level: 80, h: 1, doses: { none: seconds, linear: seconds, power: seconds, exponential: seconds, saturating: seconds }, distanceDose: null });
  const load = {
    h: 1, units: 'normalized', ownVoiceReferenceDbfs: -30, params: { beta: 1 / 300 },
    doses: { none: seconds, linear: seconds, power: seconds, exponential: seconds, saturating: seconds },
    conventionalDoses: { time: seconds, cycle: 180 * seconds }, distanceDose: null,
    metrics: { totalTime: seconds, phonationTime: seconds, nonPhonationTime: 0, timeByCategory: { attributed: seconds, uncertain: 0 } },
  };
  const meta = { participantId, schoolId: 'E-25', classroom: '2B', fatiguePre: null, fatiguePost: null, events: [] };
  const at = new Date(startedAt.getTime() + minute * 60000);
  return buildWorkday({ meta, load, series, startedAt: at, algorithmVersion: '0.8.0', source, sessionUuid });
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Clock + manual interval for the service. */
function fakeClock(start = Date.UTC(2026, 10, 23, 12, 0, 0)) {
  const clock = {
    ms: start,
    now: () => new Date(clock.ms),
    interval: null,
    setInterval(fn, ms) { clock.interval = { fn, ms }; return 1; },
    clearInterval() { clock.interval = null; },
    advance(ms) { clock.ms += ms; },
  };
  return clock;
}

/** Transport whose sends are recorded and resolved by the test. */
function scriptedTransport(script = []) {
  const sent = [];
  return {
    sent,
    async send(payload) {
      sent.push(payload);
      const step = script.length ? script.shift() : 'ok';
      if (step === 'ok') return { ok: true };
      if (step === 'permanent') throw Object.assign(new Error('400 invalid record'), { permanent: true });
      if (typeof step === 'function') return step(payload);
      throw new Error(step);
    },
  };
}

function setup({ script, online = { value: true }, random = () => 0.5, purgeAfterSync, repository = createMemoryRepository(), outbox = createMemoryOutbox() } = {}) {
  const clock = fakeClock();
  const transport = scriptedTransport(script);
  const errors = [];
  const events = [];
  const syncing = createSyncingRepository(repository, outbox, { now: clock.now, onError: (e) => errors.push(e) });
  const service = createSyncService({
    transport, outbox, repository, now: clock.now, timers: clock, online: () => online.value, random,
    baseDelayMs: 1000, maxDelayMs: 60000, pollMs: 30000, purgeAfterSync,
    onEvent: (e) => events.push(e), onError: (e) => errors.push(e),
  });
  return { clock, transport, repository, outbox, syncing, service, errors, events, online };
}

describe('IndexedDB schema v2 (migration)', () => {
  function fakeDb(existing = []) {
    const created = [];
    const names = new Set(existing);
    return {
      created,
      objectStoreNames: { contains: (n) => names.has(n) },
      createObjectStore(name, options) { if (names.has(name)) throw new Error(`${name} exists`); names.add(name); created.push([name, options]); },
    };
  }

  it('is version 3 with the workdays, outbox and frames stores', () => {
    assert.equal(DB_VERSION, 3);
    assert.deepEqual(STORES, { workdays: 'workdays', outbox: 'outbox', frames: 'frames' });
  });

  it('a new database gets both stores', () => {
    const db = fakeDb();
    upgradeDatabase(db, 0);
    assert.deepEqual(db.created, [['workdays', { keyPath: 'id' }], ['outbox', { keyPath: 'key' }], ['frames', { keyPath: 'workdayId' }]]);
  });

  it('upgrading from v1 only adds outbox and never recreates (empties) workdays', () => {
    const db = fakeDb(['workdays']);
    upgradeDatabase(db, 1);
    assert.deepEqual(db.created, [['outbox', { keyPath: 'key' }], ['frames', { keyPath: 'workdayId' }]]);
  });

  it('upgrading from v2 only adds frames', () => {
    const db = fakeDb(['workdays', 'outbox']);
    upgradeDatabase(db, 2);
    assert.deepEqual(db.created, [['frames', { keyPath: 'workdayId' }]]);
  });

  it('is idempotent on an already current database', () => {
    const db = fakeDb(['workdays', 'outbox', 'frames']);
    upgradeDatabase(db, 3);
    assert.deepEqual(db.created, []);
  });
});

describe('outbox (memory adapter, same port as IndexedDB)', () => {
  it('stores items by key, replaces them and lists by next attempt', async () => {
    const outbox = createMemoryOutbox();
    await outbox.put({ key: 'b', nextAttemptAt: 20 });
    await outbox.put({ key: 'a', nextAttemptAt: 10 });
    await outbox.put({ key: 'b', nextAttemptAt: 5 });
    assert.deepEqual((await outbox.list()).map((i) => i.key), ['b', 'a']);
    assert.equal((await outbox.get('a')).nextAttemptAt, 10);
    await outbox.remove('a');
    assert.equal(await outbox.get('a'), null);
  });

  it('hands out copies', async () => {
    const outbox = createMemoryOutbox();
    const item = { key: 'a', record: { x: 1 } };
    await outbox.put(item);
    item.record.x = 2;
    assert.equal((await outbox.get('a')).record.x, 1);
  });
});

describe('syncing repository (enqueue on final save)', () => {
  it('saves locally and enqueues a final live workday under its sync key', async () => {
    const { syncing, repository, outbox, clock } = setup();
    const w = workday({ sessionUuid: UUID(1) });
    assert.equal(await syncing.save(w), w.id);
    assert.ok(await repository.get(w.id), 'local save first');
    const [item] = await outbox.list();
    assert.equal(item.key, UUID(1));
    assert.equal(item.workdayId, w.id);
    assert.equal(item.attempts, 0);
    assert.equal(item.state, 'pending');
    assert.equal(item.nextAttemptAt, clock.ms);
    assert.equal(item.record.id, w.id);
    assert.equal('profile' in item.record, false);
  });

  it('does not enqueue in-progress checkpoints, imported or demo workdays', async () => {
    const { syncing, outbox } = setup();
    const savedAt = new Date().toISOString();
    await syncing.save({ ...workday(), checkpoint: { status: 'in_progress', savedAt } });
    await syncing.save(workday({ participantId: 'P-1', source: 'import' }));
    await syncing.save(workday({ participantId: 'P-2', source: 'demo' }));
    assert.deepEqual(await outbox.list(), []);
  });

  it('enqueues a workday recovered after an unexpected close', async () => {
    const { syncing, repository, outbox } = setup();
    await repository.save({ ...workday(), checkpoint: { status: 'in_progress', savedAt: new Date().toISOString() } });
    await recoverCheckpoints(syncing);
    const [item] = await outbox.list();
    assert.equal(item.record.checkpoint.status, 'recovered');
  });

  it('autosave: checkpoints are not enqueued, finalize() is', async () => {
    const { syncing, outbox } = setup();
    const timers = { setInterval: () => 1, clearInterval() {} };
    const autosave = createWorkdayAutosaver({ repository: syncing, snapshot: () => workday({ seconds: 30 }), timers });
    autosave.start();
    await autosave.checkpoint();
    assert.deepEqual(await outbox.list(), []);
    await autosave.finalize(workday({ seconds: 90 }));
    const items = await outbox.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].record.durationS, 90);
  });

  it('a newer save of the same session replaces the queued record and resets the retries', async () => {
    const { syncing, outbox } = setup();
    await syncing.save(workday({ seconds: 60 }));
    const first = (await outbox.list())[0];
    await outbox.put({ ...first, attempts: 3, nextAttemptAt: first.nextAttemptAt + 99999 });
    await syncing.save(workday({ seconds: 70 }));
    const items = await outbox.list();
    assert.equal(items.length, 1);
    assert.equal(items[0].record.durationS, 70);
    assert.equal(items[0].attempts, 0);
    assert.notEqual(items[0].rev, first.rev);
  });

  it('a failed enqueue never fails the local save', async () => {
    const repository = createMemoryRepository();
    const broken = { ...createMemoryOutbox(), put: async () => { throw new Error('quota'); } };
    const { syncing, errors } = setup({ repository, outbox: broken });
    const w = workday();
    assert.equal(await syncing.save(w), w.id);
    assert.ok(await repository.get(w.id));
    assert.match(errors[0].message, /quota/);
  });

  it('passes the rest of the port through', async () => {
    const { syncing, repository } = setup();
    await repository.save(workday());
    assert.equal((await syncing.list()).length, 1);
    await syncing.remove(workday().id);
    assert.equal(await syncing.get(workday().id), null);
  });
});

describe('backoff', () => {
  it('grows exponentially from the base, capped, with jitter between half and the full delay', () => {
    const opts = { baseDelayMs: 1000, maxDelayMs: 60000 };
    assert.equal(backoffDelay(1, { ...opts, random: () => 1 }), 1000);
    assert.equal(backoffDelay(2, { ...opts, random: () => 1 }), 2000);
    assert.equal(backoffDelay(4, { ...opts, random: () => 1 }), 8000);
    assert.equal(backoffDelay(20, { ...opts, random: () => 1 }), 60000);
    assert.equal(backoffDelay(4, { ...opts, random: () => 0 }), 4000);
    assert.equal(backoffDelay(4, { ...opts, random: () => 0.5 }), 6000);
  });
});

describe('sync service', () => {
  it('sends each due item as a valid vd-des-workdays/1 payload, then removes it and purges the local summary', async () => {
    const { syncing, service, transport, repository, outbox, events } = setup();
    const w = workday({ sessionUuid: UUID(1) });
    await syncing.save(w);
    const result = await service.flush();
    assert.deepEqual(result, { sent: 1, failed: 0, skipped: null });
    assert.equal(transport.sent.length, 1);
    const payload = transport.sent[0];
    assert.equal(payload.format, SYNC_FORMAT);
    assert.doesNotThrow(() => validateSyncPayload(payload));
    assert.equal(payload.workdays[0].id, w.id);
    assert.deepEqual(await outbox.list(), []);
    assert.equal(await repository.get(w.id), null, 'local summary purged after confirmation');
    assert.deepEqual(events.map((e) => [e.type, e.key]), [['sent', UUID(1)]]);
  });

  it('keeps the local summary when purgeAfterSync is false', async () => {
    const { syncing, service, repository } = setup({ purgeAfterSync: false });
    const w = workday();
    await syncing.save(w);
    await service.flush();
    assert.ok(await repository.get(w.id));
  });

  it('offline: sends nothing and keeps everything', async () => {
    const online = { value: false };
    const { syncing, service, transport, repository, outbox } = setup({ online });
    const w = workday();
    await syncing.save(w);
    assert.deepEqual(await service.flush(), { sent: 0, failed: 0, skipped: 'offline' });
    assert.equal(transport.sent.length, 0);
    assert.equal((await outbox.list()).length, 1);
    assert.ok(await repository.get(w.id));
    online.value = true;
    assert.equal((await service.flush()).sent, 1);
  });

  it('a transient failure keeps the item and the local summary and backs off with jitter', async () => {
    const { syncing, service, repository, outbox, clock, events } = setup({ script: ['503 unavailable', '503 unavailable', 'ok'], random: () => 0 });
    const w = workday();
    await syncing.save(w);
    const t0 = clock.ms;

    assert.deepEqual(await service.flush(), { sent: 0, failed: 1, skipped: null });
    let [item] = await outbox.list();
    assert.equal(item.attempts, 1);
    assert.equal(item.state, 'pending');
    assert.match(item.lastError, /503/);
    assert.equal(item.nextAttemptAt, t0 + 500, 'base 1000 ms, jitter 0 -> half');
    assert.ok(await repository.get(w.id), 'never purged while pending');
    assert.equal(events[0].type, 'retry');

    assert.equal((await service.flush()).sent, 0, 'not due yet: nothing sent');
    clock.advance(500);
    await service.flush();
    [item] = await outbox.list();
    assert.equal(item.attempts, 2);
    assert.equal(item.nextAttemptAt, clock.ms + 1000);

    clock.advance(1000);
    assert.equal((await service.flush()).sent, 1);
    assert.equal(await repository.get(w.id), null);
  });

  it('a permanent rejection stops retrying and keeps the local summary', async () => {
    const { syncing, service, repository, outbox, clock, transport } = setup({ script: ['permanent'] });
    const w = workday();
    await syncing.save(w);
    await service.flush();
    const [item] = await outbox.list();
    assert.equal(item.state, 'rejected');
    assert.match(item.lastError, /400/);
    clock.advance(10 * 60000);
    await service.flush();
    assert.equal(transport.sent.length, 1, 'not sent again');
    assert.ok(await repository.get(w.id));
  });

  it('concurrent flushes share one run: no duplicated sends', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { syncing, service, transport } = setup({ script: [async () => { await gate; return { ok: true }; }] });
    await syncing.save(workday());
    const a = service.flush();
    const b = service.flush();
    assert.equal(a, b);
    release();
    await a;
    assert.equal(transport.sent.length, 1);
  });

  it('does not purge a local summary that changed after it was queued, and keeps the newer queued version', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const { syncing, service, repository, outbox } = setup({ script: [async () => { await gate; return { ok: true }; }, 'ok'] });
    await syncing.save(workday({ seconds: 60 }));
    const running = service.flush();
    await flush();
    await syncing.save(workday({ seconds: 75 })); // edited while the first version was in flight
    release();
    await running;
    assert.equal((await repository.get(workday().id)).durationS, 75, 'the newer local summary stays');
    const [item] = await outbox.list();
    assert.equal(item.record.durationS, 75, 'the newer version is still queued');
    await service.flush();
    assert.equal(await repository.get(workday().id), null);
  });

  it('sends several due items in queue order and isolates failures', async () => {
    const { syncing, service, outbox, transport, repository } = setup({ script: ['ok', 'timeout', 'ok'] });
    for (const n of [1, 2, 3]) await syncing.save(workday({ participantId: `P-${n}`, minute: n }));
    const result = await service.flush();
    assert.deepEqual(result, { sent: 2, failed: 1, skipped: null });
    assert.deepEqual(transport.sent.map((p) => p.workdays[0].participantId), ['P-1', 'P-2', 'P-3']);
    assert.deepEqual((await outbox.list()).map((i) => i.record.participantId), ['P-2']);
    assert.ok(await repository.get(workday({ participantId: 'P-2', minute: 2 }).id));
  });

  it('never rejects: an outbox failure is reported', async () => {
    const outbox = { ...createMemoryOutbox(), list: async () => { throw new Error('db closed'); } };
    const { service, errors } = setup({ outbox });
    assert.deepEqual(await service.flush(), { sent: 0, failed: 0, skipped: 'error' });
    assert.match(errors[0].message, /db closed/);
  });

  it('a purge failure after a confirmed send is reported and leaves the summary in place', async () => {
    const repository = createMemoryRepository();
    const flaky = { ...repository, removeIf: async () => { throw new Error('locked'); } };
    const { syncing, service, outbox, errors } = setup({ repository: flaky });
    const w = workday();
    await syncing.save(w);
    assert.equal((await service.flush()).sent, 1);
    assert.deepEqual(await outbox.list(), []);
    assert.ok(await repository.get(w.id));
    assert.match(errors[0].message, /locked/);
  });

  it('start() polls on an interval and stop() halts it', async () => {
    const { syncing, service, clock, transport } = setup();
    service.start();
    assert.equal(clock.interval.ms, 30000);
    await syncing.save(workday());
    clock.interval.fn();
    await flush();
    await flush();
    assert.equal(transport.sent.length, 1);
    service.stop();
    assert.equal(clock.interval, null);
  });

  it('pending() counts the queue by state', async () => {
    const { syncing, service } = setup({ script: ['permanent'] });
    await syncing.save(workday({ participantId: 'P-1' }));
    await syncing.save(workday({ participantId: 'P-2', minute: 1 }));
    await service.flush();
    assert.deepEqual(await service.pending(), { pending: 0, rejected: 1 });
  });
});

describe('sync service: saves racing a send (independent review B1) and robustness', () => {
  /** Runs `hook` once, right before the wrapped async method acts: a save landing in that gap. */
  function hooked(target, method, hook) {
    let pending = hook;
    return {
      ...target,
      async [method](...args) {
        if (pending) { const h = pending; pending = null; await h(); }
        return target[method](...args);
      },
    };
  }

  it('B1a: a newer save landing just before the confirmed item is removed stays queued and is sent next', async () => {
    const repository = createMemoryRepository();
    const base = createMemoryOutbox();
    let syncing;
    let clock;
    const outbox = hooked(base, 'removeIfRev', () => syncing.save(workday({ seconds: 120 })));
    ({ syncing, clock } = setup({ repository, outbox }));
    const service = createSyncService({ transport: { send: async () => {} }, outbox, repository, random: () => 0.5, now: clock.now });
    await syncing.save(workday({ seconds: 60 }));
    assert.equal((await service.flush()).sent, 1);
    const [item] = await base.list();
    assert.equal(item?.record.durationS, 120, 'the newer version is still queued');
    assert.equal((await repository.get(workday().id)).durationS, 120, 'and kept locally');
    await service.flush();
    assert.deepEqual(await base.list(), []);
  });

  it('B1b: a newer save landing before a failed send is rescheduled is not overwritten by the stale version', async () => {
    const repository = createMemoryRepository();
    const base = createMemoryOutbox();
    let syncing;
    let clock;
    const outbox = hooked(base, 'updateIfRev', () => syncing.save(workday({ seconds: 120 })));
    ({ syncing, clock } = setup({ repository, outbox }));
    const service = createSyncService({ transport: { send: async () => { throw new Error('503'); } }, outbox, repository, random: () => 0.5, now: clock.now });
    await syncing.save(workday({ seconds: 60 }));
    await service.flush();
    const [item] = await base.list();
    assert.equal(item.record.durationS, 120);
    assert.equal(item.attempts, 0, 'the newer version keeps its fresh schedule');
  });

  it('B1c: a newer local save landing just before the purge is never deleted', async () => {
    const base = createMemoryRepository();
    const outbox = createMemoryOutbox();
    let syncing;
    let clock;
    const repository = hooked(base, 'removeIf', () => syncing.save(workday({ seconds: 120 })));
    ({ syncing, clock } = setup({ repository: base, outbox }));
    const service = createSyncService({ transport: { send: async () => {} }, outbox, repository, random: () => 0.5, now: clock.now });
    await syncing.save(workday({ seconds: 60 }));
    await service.flush();
    assert.equal((await base.get(workday().id))?.durationS, 120, 'the unsent newer summary stays');
    assert.equal((await outbox.list())[0].record.durationS, 120);
  });

  it('A1: an invalid stored item is rejected without blocking the rest of the queue', async () => {
    const { syncing, service, outbox, transport } = setup();
    await outbox.put({ key: 'broken', workdayId: 'x', record: { schema: 'other' }, rev: 'r', state: 'pending', attempts: 0, nextAttemptAt: 0, enqueuedAt: 0, lastError: null });
    await syncing.save(workday());
    assert.deepEqual(await service.flush(), { sent: 1, failed: 1, skipped: null });
    assert.equal(transport.sent.length, 1);
    const broken = await outbox.get('broken');
    assert.equal(broken.state, 'rejected');
    assert.match(broken.lastError, /schema/);
  });

  it('A2: removing or clearing workdays locally also cancels their pending sends', async () => {
    const { syncing, outbox, service, transport } = setup();
    await syncing.save(workday({ participantId: 'P-1' }));
    await syncing.save(workday({ participantId: 'P-2', minute: 1 }));
    await syncing.remove(workday({ participantId: 'P-1' }).id);
    assert.deepEqual((await outbox.list()).map((i) => i.record.participantId), ['P-2']);
    await syncing.clear();
    assert.deepEqual(await outbox.list(), []);
    await service.flush();
    assert.equal(transport.sent.length, 0);
  });

  it('A3: throwing callbacks never turn into a rejected flush', async () => {
    const outbox = { ...createMemoryOutbox(), list: async () => { throw new Error('db closed'); } };
    const thrower = () => { throw new Error('callback bug'); };
    const a = createSyncService({ transport: { send: async () => {} }, outbox, repository: createMemoryRepository(), onError: thrower });
    assert.deepEqual(await a.flush(), { sent: 0, failed: 0, skipped: 'error' });
    const b = createSyncService({ transport: { send: async () => {} }, outbox: createMemoryOutbox(), repository: createMemoryRepository(), online: thrower });
    assert.deepEqual(await b.flush(), { sent: 0, failed: 0, skipped: 'offline' });
    const c = createSyncService({ transport: { send: async () => {} }, outbox: createMemoryOutbox(), repository: createMemoryRepository(), onEvent: thrower });
    assert.equal((await c.flush()).sent, 0);
  });

  it('A6: revisions of two saves in the same millisecond differ', async () => {
    const { syncing, outbox } = setup();
    await syncing.save(workday({ seconds: 60 }));
    const first = (await outbox.list())[0].rev;
    const other = createSyncingRepository(createMemoryRepository(), outbox, { now: () => new Date(Date.UTC(2026, 10, 23, 12)) });
    await other.save(workday({ seconds: 61 }));
    assert.notEqual((await outbox.list())[0].rev, first);
  });
});
