import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateDemoWorkdays } from '../src/store/demo-data.js';
import { validateWorkday } from '../src/store/workday.js';

const days = generateDemoWorkdays({ seed: 7 });

describe('simulated workdays', () => {
  it('are reproducible for a seed and differ between seeds', () => {
    assert.deepEqual(generateDemoWorkdays({ seed: 7 }), days);
    assert.notDeepEqual(generateDemoWorkdays({ seed: 8 }).map((w) => w.doses.none), days.map((w) => w.doses.none));
  });

  it('are valid records marked as demo', () => {
    assert.ok(days.length > 100);
    for (const w of days) {
      assert.equal(validateWorkday(w), w);
      assert.equal(w.source, 'demo');
    }
  });

  it('cover several schools, classrooms with at least 3 teachers, and weekdays only', () => {
    const schools = new Set(days.map((w) => w.schoolId));
    assert.equal(schools.size, 3);
    const byClass = new Map();
    for (const w of days) byClass.set(`${w.schoolId}/${w.classroom}`, (byClass.get(`${w.schoolId}/${w.classroom}`) ?? new Set()).add(w.participantId));
    assert.ok([...byClass.values()].every((teachers) => teachers.size >= 3));
    assert.ok(days.every((w) => { const d = new Date(`${w.date}T12:00:00`).getDay(); return d >= 1 && d <= 5; }));
  });

  it('have plausible values and cumulative timelines that never decrease', () => {
    for (const w of days) {
      assert.ok(w.durationS >= 3 * 3600 && w.durationS <= 6 * 3600);
      assert.ok(w.phonationS / w.durationS > 0.1 && w.phonationS / w.durationS < 0.45);
      assert.ok(w.validRatio >= 0.9 && w.validRatio <= 1);
      for (const v of [w.fatigue.pre, w.fatigue.post]) assert.ok(v === null || (v >= 0 && v <= 100));
      const tl = w.timeline.doses.none;
      assert.ok(tl.every((v, i) => i === 0 || v >= tl[i - 1]));
      assert.ok(Math.abs(tl.at(-1) - w.doses.none) < 1e-6 * w.doses.none);
      assert.ok(w.doses.distance > 0);
    }
  });

  it('some VAS values are missing, as in real fieldwork', () => {
    assert.ok(days.some((w) => w.fatigue.post === null));
    assert.ok(days.filter((w) => w.fatigue.post !== null).length > days.length * 0.8);
  });

  it('simulate H0: post-fatigue does not track the burstiness that separates the memory models', () => {
    const rows = days.filter((w) => w.fatigue.post !== null && w.fatigue.pre !== null);
    const burst = rows.map((w) => w.doses.exponential / w.doses.none); // grows with burstiness only
    const change = rows.map((w) => w.fatigue.post - w.fatigue.pre);
    const r = pearson(burst, change);
    assert.ok(Math.abs(r) < 0.1, `r = ${r}`);
  });
});

function pearson(x, y) {
  const n = x.length;
  const mx = x.reduce((a, b) => a + b) / n;
  const my = y.reduce((a, b) => a + b) / n;
  let sxy = 0; let sxx = 0; let syy = 0;
  for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}
