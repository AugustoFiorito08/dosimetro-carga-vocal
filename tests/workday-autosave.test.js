import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createScoreSeries } from '../src/ui/score-series.js';
import { buildWorkday, validateWorkday } from '../src/store/workday.js';
import { createMemoryRepository } from '../src/store/workday-repository.js';
import {
  CHECKPOINT_STATUSES,
  DEFAULT_AUTOSAVE_INTERVAL_MS,
  createWorkdayAutosaver,
  recoverCheckpoints,
} from '../src/store/workday-autosave.js';

const startedAt = new Date(2026, 10, 12, 8, 0, 0);

function workdayAt(seconds, participantId = 'P-0421') {
  const series = createScoreSeries();
  series.push({ t: 0, dt: seconds, phi: 1, f0: 180, level: 80, h: 1, doses: { none: seconds, linear: seconds, power: seconds, exponential: seconds, saturating: seconds }, distanceDose: null });
  const load = {
    h: 1, units: 'normalized', ownVoiceReferenceDbfs: -30, referencePressure: 1, params: { beta: 1 / 300 },
    doses: { none: seconds, linear: seconds, power: seconds, exponential: seconds, saturating: seconds },
    conventionalDoses: { time: seconds, cycle: 180 * seconds }, distanceDose: null,
    metrics: { totalTime: seconds, phonationTime: seconds, nonPhonationTime: 0, timeByCategory: { attributed: seconds, uncertain: 0 } },
  };
  const meta = { participantId, schoolId: 'E-25', classroom: '2B', fatiguePre: null, fatiguePost: null, events: [] };
  return buildWorkday({ meta, load, series, startedAt, algorithmVersion: '0.7.0', source: 'live' });
}

/** Manual timer: tick() runs the interval callback, as many times as needed. */
function fakeTimers() {
  const timers = {
    callback: null,
    delay: null,
    cleared: 0,
    setInterval(fn, delay) { timers.callback = fn; timers.delay = delay; return 1; },
    clearInterval() { timers.callback = null; timers.cleared++; },
    tick() { timers.callback?.(); },
  };
  return timers;
}

/** Repository whose writes wait until release() is called, to observe overlapping saves. */
function slowRepository() {
  const inner = createMemoryRepository();
  const gates = [];
  let active = 0;
  let maxActive = 0;
  const gated = (fn) => async (...args) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => gates.push(resolve));
    try { return await fn(...args); } finally { active--; }
  };
  return {
    ...inner,
    save: gated(inner.save),
    remove: gated(inner.remove),
    get maxActive() { return maxActive; },
    get waiting() { return gates.length; },
    release() { gates.shift()?.(); },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
let clock = Date.UTC(2026, 10, 12, 11, 0, 0);
const now = () => new Date(clock);

function setup({ repository = createMemoryRepository(), seconds = { value: 60 }, participant = { value: 'P-0421' }, ...rest } = {}) {
  const timers = fakeTimers();
  const errors = [];
  const autosave = createWorkdayAutosaver({
    repository,
    snapshot: () => workdayAt(seconds.value, participant.value),
    timers,
    now,
    onError: (e) => errors.push(e),
    ...rest,
  });
  return { autosave, repository, timers, errors, seconds, participant };
}

describe('workday checkpoint field', () => {
  it('validates the optional checkpoint metadata and keeps records without it valid', () => {
    const w = workdayAt(60);
    assert.equal('checkpoint' in w, false, 'buildWorkday adds no checkpoint');
    assert.equal(validateWorkday(w), w);
    for (const status of CHECKPOINT_STATUSES) {
      assert.doesNotThrow(() => validateWorkday({ ...w, checkpoint: { status, savedAt: now().toISOString() } }));
    }
    assert.throws(() => validateWorkday({ ...w, checkpoint: { status: 'other', savedAt: now().toISOString() } }), /checkpoint/);
    assert.throws(() => validateWorkday({ ...w, checkpoint: { status: 'in_progress', savedAt: 'yesterday' } }), /checkpoint/);
  });
});

describe('workday autosaver', () => {
  it('saves a checkpoint every interval while running, defaulting to 2 minutes', async () => {
    assert.equal(DEFAULT_AUTOSAVE_INTERVAL_MS, 120000);
    const { autosave, repository, timers, seconds } = setup();
    autosave.start();
    assert.equal(timers.delay, DEFAULT_AUTOSAVE_INTERVAL_MS);
    assert.deepEqual(await repository.list(), [], 'nothing is written before the first tick');

    timers.tick();
    await flush();
    let [saved] = await repository.list();
    assert.equal(saved.durationS, 60);
    assert.deepEqual(saved.checkpoint, { status: 'in_progress', savedAt: now().toISOString() });
    assert.equal(autosave.savedId, saved.id);
    assert.equal(autosave.lastSavedAt.getTime(), clock);

    seconds.value = 180;
    clock += 120000;
    timers.tick();
    await flush();
    const all = await repository.list();
    assert.equal(all.length, 1, 'the same record is replaced, never duplicated');
    [saved] = all;
    assert.equal(saved.durationS, 180);
    assert.equal(saved.checkpoint.savedAt, now().toISOString());
  });

  it('accepts a custom interval', () => {
    const { autosave, timers } = setup({ intervalMs: 300000 });
    autosave.start();
    assert.equal(timers.delay, 300000);
    assert.throws(() => setup({ intervalMs: 0 }), RangeError);
  });

  it('never overlaps writes and coalesces checkpoints requested while one is waiting', async () => {
    const repository = slowRepository();
    const { autosave, seconds } = setup({ repository });
    autosave.start();
    const first = autosave.checkpoint();
    await flush();
    seconds.value = 90;
    const second = autosave.checkpoint();
    const third = autosave.checkpoint();
    assert.equal(second, third, 'a queued checkpoint is shared');
    assert.equal(repository.waiting, 1, 'the second write waits for the first');

    repository.release();
    assert.equal((await first).saved, true);
    await flush();
    repository.release();
    assert.equal((await second).saved, true);
    assert.equal(repository.maxActive, 1);
    const all = await repository.list();
    assert.equal(all.length, 1);
    assert.equal(all[0].durationS, 90, 'the queued checkpoint takes the latest data');
  });

  it('a final save waits for the checkpoint in flight and is the last write', async () => {
    const repository = slowRepository();
    const { autosave, timers } = setup({ repository });
    autosave.start();
    const pending = autosave.checkpoint();
    await flush();
    const final = autosave.finalize(workdayAt(200));
    timers.tick(); // a tick after finalize() must not write an in-progress copy again
    repository.release();
    await pending;
    await flush();
    repository.release();
    await final;
    const [saved] = await repository.list();
    assert.equal(saved.durationS, 200);
    assert.equal('checkpoint' in saved, false, 'the final record is clean');
    assert.equal(timers.callback, null, 'the timer is stopped');
    assert.deepEqual(await autosave.checkpoint(), { saved: false, reason: 'closed' });
  });

  it('a final save under another id removes the checkpoint it replaces', async () => {
    const { autosave, repository } = setup();
    autosave.start();
    await autosave.checkpoint();
    await autosave.finalize(workdayAt(120, 'P-0999'));
    const ids = (await repository.list()).map((w) => w.id);
    assert.deepEqual(ids, ['S-20261112-080000-P-0999']);
  });

  it('a checkpoint under a new participant code removes the previous one', async () => {
    const { autosave, repository, participant } = setup();
    autosave.start();
    await autosave.checkpoint();
    participant.value = 'P-0999';
    await autosave.checkpoint();
    const ids = (await repository.list()).map((w) => w.id);
    assert.deepEqual(ids, ['S-20261112-080000-P-0999']);
  });

  it('discard removes the checkpoint and stops autosaving', async () => {
    const { autosave, repository, timers } = setup();
    const other = workdayAt(30, 'P-0001');
    await repository.save(other);
    autosave.start();
    await autosave.checkpoint();
    await autosave.discard();
    assert.deepEqual((await repository.list()).map((w) => w.id), [other.id], 'other workdays are untouched');
    assert.equal(autosave.savedId, null);
    timers.tick();
    await flush();
    assert.equal((await repository.list()).length, 1);
  });

  it('stop() keeps the last checkpoint and halts the timer', async () => {
    const { autosave, repository, timers } = setup();
    autosave.start();
    await autosave.checkpoint();
    autosave.stop();
    assert.equal(timers.callback, null);
    assert.equal((await repository.list())[0].checkpoint.status, 'in_progress');
    assert.equal((await autosave.checkpoint()).saved, true, 'an explicit checkpoint is still possible until finalize or discard');
  });

  it('reports an invalid snapshot (missing codes) without writing or throwing', async () => {
    const { autosave, repository, errors } = setup({ participant: { value: '' } });
    autosave.start();
    const result = await autosave.checkpoint();
    assert.equal(result.saved, false);
    assert.equal(result.reason, 'invalid');
    assert.equal(errors.length, 1);
    assert.deepEqual(await repository.list(), []);
  });

  it('reports a failed write and keeps autosaving afterwards', async () => {
    const repository = createMemoryRepository();
    let fail = true;
    const flaky = { ...repository, save: async (w) => { if (fail) throw new Error('quota exceeded'); return repository.save(w); } };
    const { autosave, errors } = setup({ repository: flaky });
    autosave.start();
    assert.equal((await autosave.checkpoint()).reason, 'error');
    assert.match(errors[0].message, /quota/);
    fail = false;
    assert.equal((await autosave.checkpoint()).saved, true);
  });
});

describe('recoverCheckpoints (start-up after an unexpected close)', () => {
  it('marks in-progress checkpoints as recovered and leaves the rest alone', async () => {
    const repository = createMemoryRepository();
    const lost = { ...workdayAt(600), checkpoint: { status: 'in_progress', savedAt: '2026-11-12T10:30:00.000Z' } };
    const saved = workdayAt(300, 'P-0001');
    const old = { ...workdayAt(100, 'P-0002'), checkpoint: { status: 'recovered', savedAt: '2026-11-10T10:00:00.000Z' } };
    for (const w of [lost, saved, old]) await repository.save(w);

    const recovered = await recoverCheckpoints(repository);
    assert.deepEqual(recovered.map((w) => [w.id, w.durationS, w.checkpoint.savedAt]), [[lost.id, 600, '2026-11-12T10:30:00.000Z']]);
    assert.equal((await repository.get(lost.id)).checkpoint.status, 'recovered');
    assert.equal('checkpoint' in (await repository.get(saved.id)), false);

    assert.deepEqual(await recoverCheckpoints(repository), [], 'reported only once');
  });

  it('a later checkpoint of the same session overwrites a recovered copy back to in progress', async () => {
    const repository = createMemoryRepository();
    const { autosave } = setup({ repository });
    autosave.start();
    await autosave.checkpoint();
    await recoverCheckpoints(repository); // e.g. a second tab started up meanwhile
    await autosave.checkpoint();
    assert.equal((await repository.list())[0].checkpoint.status, 'in_progress');
  });
});
