// Teacher view models (odd/tasks/vista-docente-movil.md, T1): which screen of the guided flow
// comes next, and how today's load compares with the teacher's own history (S2).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MIN_HISTORY, comparisonText, nextTeacherStep, personalComparison } from '../src/ui/teacher/teacher-model.js';

const ready = {
  codesOk: true, connected: true, ambientDone: true, enrolled: true, referenceDone: true, calibrated: false,
  preDone: true, mode: 'idle', recordCount: 0, saved: false,
};

describe('next step of the guided flow', () => {
  it('walks the preparation in order', () => {
    const steps = [
      [{ codesOk: false }, 'codes'],
      [{ connected: false }, 'microphone'],
      [{ ambientDone: false }, 'ambient'],
      [{ enrolled: false }, 'enrol'],
      [{ referenceDone: false }, 'reference'],
      [{ preDone: false }, 'pre'],
      [{}, 'ready'],
    ];
    for (const [change, step] of steps) assert.equal(nextTeacherStep({ ...ready, ...change }), step, step);
  });

  it('an earlier missing step wins over a later one', () => {
    assert.equal(nextTeacherStep({ ...ready, connected: false, enrolled: false }), 'microphone');
  });

  it('a calibrated session needs no voice reference', () => {
    assert.equal(nextTeacherStep({ ...ready, referenceDone: false, calibrated: true }), 'ready');
  });

  it('measuring or paused is the live panel; finished and unsaved is POST; saved is the summary', () => {
    assert.equal(nextTeacherStep({ ...ready, mode: 'measuring', recordCount: 10 }), 'live');
    assert.equal(nextTeacherStep({ ...ready, mode: 'paused', recordCount: 10 }), 'live');
    assert.equal(nextTeacherStep({ ...ready, recordCount: 10 }), 'post');
    assert.equal(nextTeacherStep({ ...ready, recordCount: 10, saved: true }), 'summary');
  });

  it('a running preparation task stays on its screen', () => {
    assert.equal(nextTeacherStep({ ...ready, ambientDone: false, mode: 'calibrating' }), 'ambient');
    assert.equal(nextTeacherStep({ ...ready, enrolled: false, mode: 'enrolling' }), 'enrol');
    assert.equal(nextTeacherStep({ ...ready, referenceDone: false, mode: 'referencing' }), 'reference');
  });
});

describe('personal comparison', () => {
  const day = (id, perMinute, { units = 'normalized', participantId = 'P-1', minutes = 60 } = {}) => ({
    id, participantId, units,
    timeline: { minutes: Array.from({ length: minutes }, (_, i) => i + 1), doses: { none: Array.from({ length: minutes }, (_, i) => (i + 1) * perMinute) } },
  });
  const history = [10, 20, 30, 40, 50].map((rate, i) => day(`W${i}`, rate));

  it('needs at least 5 earlier workdays of the same teacher and units', () => {
    assert.equal(MIN_HISTORY, 5);
    const few = personalComparison(history.slice(0, 4), { participantId: 'P-1', units: 'normalized', elapsedMin: 30, dose: 600 });
    assert.equal(few.status, 'insufficient');
    assert.equal(few.n, 4);
    const others = [...history.slice(0, 4), day('X', 10, { participantId: 'P-2' }), day('Y', 10, { units: 'calibrated' })];
    assert.equal(personalComparison(others, { participantId: 'P-1', units: 'normalized', elapsedMin: 30, dose: 600 }).status, 'insufficient');
  });

  it('compares with the dose the same workdays had at the same elapsed minute', () => {
    // At minute 30: 300, 600, 900, 1200, 1500 → median 900, P75 1200.
    const at = (dose) => personalComparison(history, { participantId: 'P-1', units: 'normalized', elapsedMin: 30, dose });
    assert.deepEqual({ ...at(800), ratio: undefined }, { status: 'usual', n: 5, median: 900, p75: 1200, ratio: undefined });
    near(at(800).ratio, 800 / 900);
    assert.equal(at(1000).status, 'above_median');
    assert.equal(at(1300).status, 'above');
  });

  it('only workdays that lasted that long count, and the current one never does', () => {
    const short = [...history, day('S', 1000, { minutes: 10 })];
    assert.equal(personalComparison(short, { participantId: 'P-1', units: 'normalized', elapsedMin: 30, dose: 800 }).n, 5);
    assert.equal(personalComparison(history, { participantId: 'P-1', units: 'normalized', elapsedMin: 30, dose: 800, excludeId: 'W0' }).n, 4);
  });

  it('the whole workday is compared at its full length', () => {
    const r = personalComparison(history, { participantId: 'P-1', units: 'normalized', elapsedMin: 60, dose: 3000 });
    assert.equal(r.median, 1800);
  });

  it('says it in plain words, without zones', () => {
    assert.match(comparisonText({ status: 'insufficient', n: 2 }), /3 jornadas más/);
    assert.match(comparisonText({ status: 'usual', n: 5 }), /dentro de tu jornada habitual/);
    assert.match(comparisonText({ status: 'above_median', n: 5 }), /algo por encima/);
    assert.match(comparisonText({ status: 'above', n: 5 }), /por encima de tu jornada habitual/);
    for (const s of ['usual', 'above_median', 'above']) assert.doesNotMatch(comparisonText({ status: s, n: 5 }), /zona|amarill|roj|alta carga/i);
    assert.match(comparisonText({ status: 'above', n: 5 }, { scope: 'day' }), /^Esta jornada estuvo por encima/);
    assert.doesNotMatch(comparisonText({ status: 'usual', n: 5 }, { scope: 'day' }), /a esta hora/);
  });
});

function near(a, b, tol = 1e-9) {
  assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
}

describe('initial view', () => {
  it('keeps the user choice, else the teacher view on a phone-sized screen', async () => {
    const { initialView } = await import('../src/ui/teacher/teacher-app.js');
    const storage = (value) => ({ getItem: () => value });
    const screen = (phone) => () => ({ matches: phone });
    assert.equal(initialView({ storage: storage('technical'), matchMedia: screen(true) }), 'technical');
    assert.equal(initialView({ storage: storage('teacher'), matchMedia: screen(false) }), 'teacher');
    assert.equal(initialView({ storage: storage(null), matchMedia: screen(true) }), 'teacher');
    assert.equal(initialView({ storage: storage(null), matchMedia: screen(false) }), 'technical');
    const broken = { getItem: () => { throw new Error('blocked'); } };
    assert.equal(initialView({ storage: broken, matchMedia: screen(true) }), 'teacher');
  });
});
