// Post-workday recovery (hito 10): fatigue VAS at fixed times after the end of the workday,
// kept as raw points in fatigue.recovery, and the indices R(t), T50, T90 and AUC_F computed
// from them (never stored, so they can be recomputed if their definition changes).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RECOVERY_SLOTS, addRecoveryPoint, preserveRecovery, recoveryEnd, recoverySchedule } from '../src/store/recovery.js';
import { recoveryIndices } from '../src/stats/recovery.js';
import { validateWorkday } from '../src/store/workday.js';
import { WORKDAY_SYNC_JSON_SCHEMA, toSyncRecord } from '../src/store/workday-sync.js';
import { createMemoryRepository } from '../src/store/workday-repository.js';
import { renderTeacher, summariesCsv } from '../src/ui/boards/views.js';

const STARTED = new Date(2026, 10, 12, 8, 0).toISOString(); // 08:00 local, in any time zone
const END = Date.parse(STARTED) + 4 * 3600 * 1000; // a 4 h workday
const after = (min) => new Date(END + min * 60000);
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);

function workday(extra = {}) {
  return {
    schema: 'vd-des-workday/1', id: 'S-20261112-080000-P-0421', participantId: 'P-0421', schoolId: 'E-25', classroom: '2B',
    date: '2026-11-12', startedAt: STARTED, durationS: 4 * 3600, phonationS: 3600, validRatio: 0.9,
    doses: { none: 10, linear: 10, power: 10, exponential: 10, saturating: 10, distance: null, time: 3600, cycle: 1 },
    hMax: 1, f0: { p10: 150, p50: 180, p90: 220 }, level: { p10: 60, p50: 70, p90: 80 }, units: 'normalized', ownVoiceRefDbfs: -30,
    timeline: { minutes: [1, 2], doses: { none: [1, 2], linear: [1, 2], power: [1, 2], exponential: [1, 2], saturating: [1, 2] } },
    events: [], fatigue: { pre: 10, post: 50 }, assessment: null, algorithmVersion: '0.9.0', source: 'live', ...extra,
  };
}

describe('recovery schedule', () => {
  it('has the fixed times +30 min, +1 h, +2 h, +4 h and the next morning', () => {
    assert.deepEqual(RECOVERY_SLOTS.map((s) => s.id), ['R30', 'R60', 'R120', 'R240', 'NEXT']);
    assert.deepEqual(RECOVERY_SLOTS.map((s) => s.targetMin), [30, 60, 120, 240, null]);
  });

  it('starts at the end of the workday', () => {
    assert.equal(recoveryEnd(workday()).getTime(), END);
  });

  it('opens each slot 5 min before its time and closes it when the next one opens', () => {
    const state = (min) => Object.fromEntries(recoverySchedule(workday(), after(min)).map((s) => [s.id, s.status]));
    assert.deepEqual(state(10), { R30: 'upcoming', R60: 'upcoming', R120: 'upcoming', R240: 'upcoming', NEXT: 'upcoming' });
    assert.equal(state(26).R30, 'open');
    assert.equal(state(56).R30, 'missed');
    assert.equal(state(56).R60, 'open');
    assert.equal(state(359).R240, 'open');
    assert.equal(state(361).R240, 'missed');
  });

  it('the next morning is the first 05:00-12:00 local window still open at +8 h', () => {
    const end = new Date(END);
    const nextDay = (hour, min = 0) => new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1, hour, min);
    const status = (at) => recoverySchedule(workday(), at).find((s) => s.id === 'NEXT').status;
    assert.equal(status(nextDay(4, 59)), 'upcoming');
    assert.equal(status(nextDay(5)), 'open');
    assert.equal(status(nextDay(11, 59)), 'open');
    assert.equal(status(nextDay(12)), 'missed');
    // A workday ending at 02:00 (night shift): that same morning, from +8 h and for 4 h.
    const night = workday({ startedAt: new Date(2026, 10, 12, 22, 0).toISOString(), durationS: 4 * 3600 });
    const nightEnd = new Date(2026, 10, 13, 2, 0).getTime();
    const s = recoverySchedule(night, new Date(nightEnd + 479 * 60000)).find((x) => x.id === 'NEXT');
    assert.equal(s.status, 'upcoming');
    assert.equal(s.dueAt.getTime(), nightEnd + 480 * 60000);
    assert.equal(s.closesAt.getTime(), nightEnd + 720 * 60000);
  });
});

describe('recording a recovery point', () => {
  it('stores the slot, the real time, the minutes since the end and the VAS', () => {
    const w = addRecoveryPoint(workday(), { slot: 'R30', value: 40, at: after(33) });
    assert.deepEqual(w.fatigue.recovery, [{ slot: 'R30', at: after(33).toISOString(), minutes: 33, value: 40 }]);
    assert.equal(w.fatigue.pre, 10);
    assert.equal(w.fatigue.post, 50);
    assert.equal(validateWorkday(w), w);
  });

  it('refuses a slot that is not open, a repeated slot or an invalid VAS', () => {
    assert.throws(() => addRecoveryPoint(workday(), { slot: 'R60', value: 40, at: after(30) }), /not open/);
    const once = addRecoveryPoint(workday(), { slot: 'R30', value: 40, at: after(30) });
    assert.throws(() => addRecoveryPoint(once, { slot: 'R30', value: 30, at: after(31) }), /already/);
    assert.throws(() => addRecoveryPoint(workday(), { slot: 'R30', value: 140, at: after(30) }), /0-100/);
  });

  it('only on a finished live workday', () => {
    assert.throws(() => addRecoveryPoint(workday({ source: 'demo' }), { slot: 'R30', value: 40, at: after(30) }), /live/);
    const running = workday({ checkpoint: { status: 'in_progress', savedAt: STARTED } });
    assert.throws(() => addRecoveryPoint(running, { slot: 'R30', value: 40, at: after(30) }), /in progress/);
  });

  it('the validator rejects malformed recovery points', () => {
    const bad = (point) => workday({ fatigue: { pre: 10, post: 50, recovery: [point] } });
    assert.throws(() => validateWorkday(bad({ slot: 'R45', at: STARTED, minutes: 45, value: 1 })), /slot/);
    assert.throws(() => validateWorkday(bad({ slot: 'R30', at: 'yesterday', minutes: 30, value: 1 })), /at/);
    assert.throws(() => validateWorkday(bad({ slot: 'R30', at: STARTED, minutes: -1, value: 1 })), /minutes/);
    assert.throws(() => validateWorkday(bad({ slot: 'R30', at: STARTED, minutes: 30, value: 101 })), /0-100/);
    assert.throws(() => validateWorkday(bad({ slot: 'R30', at: STARTED, minutes: 30, value: 1, note: 'x' })), /unknown/);
  });
});

describe('recovery indices', () => {
  const points = [{ minutes: 30, value: 40 }, { minutes: 60, value: 30 }, { minutes: 120, value: 20 }, { minutes: 240, value: 12 }];

  it('ΔF and R(t) = (F_post − F(t)) / ΔF at each point', () => {
    const r = recoveryIndices({ pre: 10, post: 50, points });
    assert.equal(r.deltaF, 40);
    assert.deepEqual(r.points.map((p) => p.r), [0.25, 0.5, 0.75, 0.95]);
  });

  it('T50 and T90 by linear interpolation from the end of the workday (R = 0 at t = 0)', () => {
    const r = recoveryIndices({ pre: 10, post: 50, points });
    assert.equal(r.t50Min, 60);
    near(r.t90Min, 120 + (120 * 0.15) / 0.2, 1e-9, 'T90 between +2 h and +4 h');
    const early = recoveryIndices({ pre: 10, post: 50, points: [{ minutes: 30, value: 20 }] });
    assert.equal(early.t50Min, 20, '50 % reached between 0 and 30 min');
  });

  it('a level not reached by the last point is censored, not invented', () => {
    const r = recoveryIndices({ pre: 10, post: 50, points: points.slice(0, 2) });
    assert.equal(r.t90Min, null);
    assert.equal(r.t90Censored, true);
    assert.equal(r.horizonMin, 60);
  });

  it('AUC_F integrates the residual fatigue F(t) − F_pre with trapezoids, in VAS·h', () => {
    const r = recoveryIndices({ pre: 10, post: 50, points: [{ minutes: 60, value: 30 }, { minutes: 120, value: 10 }] });
    // (40 + 20) / 2 · 1 h + (20 + 0) / 2 · 1 h
    near(r.aucF, 40, 1e-9, 'AUC_F');
  });

  it('without a fatigue increase there is nothing to recover: R, T50 and T90 are null', () => {
    const r = recoveryIndices({ pre: 30, post: 30, points });
    assert.equal(r.deltaF, 0);
    assert.equal(r.t50Min, null);
    assert.equal(r.t90Censored, false);
    assert.ok(r.points.every((p) => p.r === null));
  });

  it('without PRE/POST or without points everything is null', () => {
    const r = recoveryIndices({ pre: null, post: 50, points });
    assert.equal(r.deltaF, null);
    assert.equal(r.aucF, null);
    assert.equal(recoveryIndices({ pre: 10, post: 50, points: [] }).aucF, null);
  });
});

describe('recovery through storage, sync and the boards', () => {
  it('a later save of the same workday without recovery keeps the recorded points', async () => {
    const repo = preserveRecovery(createMemoryRepository());
    const w = workday();
    await repo.save(addRecoveryPoint(w, { slot: 'R30', value: 40, at: after(30) }));
    await repo.save(w); // e.g. «Guardar jornada» pressed again
    assert.equal((await repo.get(w.id)).fatigue.recovery.length, 1);
  });

  it('travels in the sync record inside fatigue, which the schema describes', () => {
    const w = addRecoveryPoint(workday(), { slot: 'R30', value: 40, at: after(30) });
    assert.deepEqual(toSyncRecord(w).fatigue, w.fatigue);
    assert.equal(WORKDAY_SYNC_JSON_SCHEMA.properties.fatigue.properties.recovery.type, 'array');
  });

  it('Mi jornada shows the recovery panel with the open slot and the indices', () => {
    const w = addRecoveryPoint(workday(), { slot: 'R30', value: 30, at: after(30) });
    const root = { innerHTML: '' };
    renderTeacher(root, [w], { dose: 'none', now: () => after(58) });
    for (const text of ['Recuperación', '+30 min', 'Mañana siguiente', 'T₅₀', 'T₉₀', 'AUC']) assert.ok(root.innerHTML.includes(text), text);
    assert.match(root.innerHTML, /data-action="recovery-save" data-slot="R60"/);
  });

  it('the summary CSV adds the recovery indices', () => {
    const w = addRecoveryPoint(workday(), { slot: 'R30', value: 30, at: after(30) });
    const [head, row] = summariesCsv([w]).trimEnd().split('\r\n');
    const cols = head.split(',');
    for (const c of ['recovery_points', 'recovery_t50_min', 'recovery_t90_min', 'recovery_auc_f']) assert.ok(cols.includes(c), c);
    assert.equal(row.split(',')[cols.indexOf('recovery_points')], '1');
  });
});
