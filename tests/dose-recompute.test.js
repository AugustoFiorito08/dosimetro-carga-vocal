// Dose recomputation from the per-second series (perSecond) for Analítica: other parameters
// on the same recorded workdays, without recording again and without touching the records.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_H_REF, PARAM_RANGES, compareModels, recomputeDoses, recomputeParams, recomputeWorkdays } from '../src/stats/dose-recompute.js';
import { DEFAULT_MODEL_PARAMS } from '../src/math/dose-models.js';
import { createSecondSeries } from '../src/store/second-series.js';
import { createVocalLoadState, stepVocalLoad } from '../src/vocal-load.js';

const near = (a, b, rel) => assert.ok(Math.abs(a - b) <= rel * Math.abs(b), `${a} vs ${b}`);
const F0I = 220;
/** 600 s with 300 s of voice: all at the start, or 10 s on / 10 s off. */
const continuous = { phonation: Array.from({ length: 600 }, (_, k) => (k < 300 ? 1 : 0)), f0I: Array.from({ length: 600 }, (_, k) => (k < 300 ? F0I : 0)) };
const alternating = { phonation: Array.from({ length: 600 }, (_, k) => (Math.floor(k / 10) % 2 ? 0 : 1)), f0I: Array.from({ length: 600 }, (_, k) => (Math.floor(k / 10) % 2 ? 0 : F0I)) };
const params = { beta: 0.03, alphaL: 0.05 };

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const workday = (id, perSecond, { pre = 10, post = 40 } = {}) => ({
  id, participantId: 'P-1', units: 'normalized', doses: { none: 1, linear: 1, power: 1, exponential: 1, saturating: 1 },
  fatigue: { pre, post }, ...(perSecond ? { perSecond } : {}),
});

describe('dose recomputation from the per-second series', () => {
  it('same phonation and F0·I: same D0, but a continuous block gives more dose with memory than one with pauses', () => {
    const a = recomputeDoses(continuous, params);
    const b = recomputeDoses(alternating, params);
    assert.equal(a.none, 300 * F0I);
    assert.equal(b.none, a.none);
    for (const m of ['linear', 'power', 'exponential', 'saturating']) assert.ok(a[m] > b[m], `${m}: ${a[m]} > ${b[m]}`);
  });

  it('the linear dose follows H = H·e^(−β) + phonation and (1 + α_L·H) second by second', () => {
    const s = { phonation: [1, 0.5, 0], f0I: [100, 200, 0] };
    const h1 = 1;
    const h2 = h1 * Math.exp(-0.03) + 0.5;
    near(recomputeDoses(s, params).linear, 100 * (1 + 0.05 * h1) + 0.5 * 200 * (1 + 0.05 * h2), 1e-12);
  });

  it('with the parameters of a recording it reproduces the doses of the engine', () => {
    let load = createVocalLoadState({ params: { beta: 0.03 } });
    const series = createSecondSeries();
    const dt = 2048 / 48000;
    for (let i = 0; i < 20000; i++) {
      const voiced = i % 50 < 35;
      load = stepVocalLoad(load, { dt, voiced, identityMatch: true, qualityOk: true, f0: 160 + (i % 30), pressure: 0.05 });
      series.push({ dt, phi: load.lastFrame.phi, f0: 160 + (i % 30), intensity: load.lastFrame.intensity });
    }
    const { beta, alphaL, a, p, hRef, alphaE, A, kH } = load.params;
    const doses = recomputeDoses(series.toJSON(), { beta, alphaL, a, p, hRef, alphaE, A, kH });
    for (const m of ['none', 'linear', 'power', 'exponential', 'saturating']) near(doses[m], load.doses[m], 1.5e-2); // 1 Hz resolution: about 1 % at β = 0.03
  });

  it('by default it uses the engine values, so it reproduces the stored doses', () => {
    let load = createVocalLoadState();
    const series = createSecondSeries();
    const dt = 2048 / 48000;
    for (let i = 0; i < 40000; i++) {
      const voiced = i % 50 < 35;
      load = stepVocalLoad(load, { dt, voiced, identityMatch: true, qualityOk: true, f0: 160 + (i % 30), pressure: 0.05 });
      series.push({ dt, phi: load.lastFrame.phi, f0: 160 + (i % 30), intensity: load.lastFrame.intensity });
    }
    const doses = recomputeDoses(series.toJSON());
    for (const m of ['none', 'linear', 'power', 'exponential', 'saturating']) near(doses[m], load.doses[m], 2e-3); // 1 Hz resolution: about 0.1 % at β = 1/300
  });

  it('changing β or α_L recomputes, D0 stays, and the workdays are never modified', () => {
    const days = deepFreeze([workday('A', continuous), workday('B', alternating), workday('OLD', null)]);
    const before = structuredClone(days);
    const r1 = recomputeWorkdays(days, params);
    const r2 = recomputeWorkdays(days, { beta: 0.01, alphaL: 0.05 });
    const r3 = recomputeWorkdays(days, { beta: 0.03, alphaL: 0.1 });
    assert.notEqual(r2.entries[0].doses.linear, r1.entries[0].doses.linear);
    assert.notEqual(r3.entries[0].doses.linear, r1.entries[0].doses.linear);
    assert.equal(r2.entries[0].doses.none, r1.entries[0].doses.none);
    assert.deepEqual(days, before);
  });

  it('workdays without a per-second series are counted apart, not recomputed', () => {
    const r = recomputeWorkdays([workday('A', continuous), workday('OLD', null)], params);
    assert.deepEqual(r.entries.map((e) => e.workday.id), ['A']);
    assert.deepEqual(r.withoutSeries.map((w) => w.id), ['OLD']);
  });

  it('β and α_L must be inside the search ranges', () => {
    assert.throws(() => recomputeDoses(continuous, { beta: 0.5, alphaL: 0.05 }), RangeError);
    assert.throws(() => recomputeDoses(continuous, { beta: 0.03, alphaL: 0 }), RangeError);
  });

  it('every shape has its own range, starting at the engine value; H_ref is fixed at the engine H*', () => {
    const e = DEFAULT_MODEL_PARAMS;
    assert.deepEqual(Object.fromEntries(Object.entries(PARAM_RANGES).map(([k, r]) => [k, [r.min, r.max, r.initial]])), {
      beta: [0.001, 0.1, e.beta], alphaL: [0.001, 0.1, e.alphaL], a: [0.1, 3, e.a], p: [0.5, 3, e.p],
      alphaE: [0.001, 0.06, e.alphaE], A: [0.25, 6, e.A], kH: [5, 600, e.kH],
    });
    assert.ok(Math.abs(e.beta - 1 / 300) < 1e-15);
    assert.equal(FIXED_H_REF, e.hRef);
    assert.equal(FIXED_H_REF, 300);
    const p = recomputeParams({ beta: 0.01 });
    assert.deepEqual([p.beta, p.alphaL, p.a, p.p, p.hRef, p.alphaE, p.A, p.kH], [0.01, e.alphaL, 1, 2, 300, e.alphaE, 2, 300]);
    for (const [name, value] of [['a', 5], ['p', 0.1], ['alphaE', 0.1], ['A', 0.1], ['kH', 700]]) {
      assert.throws(() => recomputeParams({ [name]: value }), RangeError, name);
    }
  });

  it('moving β changes only the memory: the shape of each f(H) stays', () => {
    const shapes = (q) => [q.alphaL, q.a, q.p, q.hRef, q.alphaE, q.A, q.kH];
    assert.deepEqual(shapes(recomputeParams({ beta: 0.005 })), shapes(recomputeParams({ beta: 0.1 })));
  });

  it('each shape parameter moves only its own model', () => {
    const base = recomputeDoses(continuous, params);
    const moved = { a: 'power', p: 'power', alphaE: 'exponential', A: 'saturating', kH: 'saturating', alphaL: 'linear' };
    for (const [name, model] of Object.entries(moved)) {
      const r = PARAM_RANGES[name];
      const d = recomputeDoses(continuous, { ...params, [name]: r.initial === r.max ? r.min : r.max });
      for (const m of Object.keys(base)) {
        if (m === model) assert.notEqual(d[m], base[m], `${name} moves ${m}`);
        else assert.equal(d[m], base[m], `${name} leaves ${m}`);
      }
    }
  });
});

describe('model comparison against D0', () => {
  // Fatigue rises with how continuous the voice was: the memory models should see it, D0 cannot.
  const days = [];
  for (let i = 0; i < 12; i++) {
    const block = 10 + 25 * i; // longer blocks without pauses, same total voice
    const phonation = Array.from({ length: 600 }, (_, k) => (k % (2 * block) < block ? 1 : 0));
    const total = phonation.reduce((a, b) => a + b, 0);
    const scaled = phonation.map((p) => (p * 300) / total);
    days.push(workday(`W${i}`, { phonation: scaled, f0I: scaled.map((p) => (p ? F0I : 0)) }, { pre: 10, post: 15 + 4 * i }));
  }

  it('reports Spearman ρ, the ROC AUC and its difference with D0 for each model', () => {
    const { entries } = recomputeWorkdays(days, params);
    const c = compareModels(entries, 'deltaF', 30);
    assert.equal(c.n, 12);
    assert.deepEqual(Object.keys(c.models), ['none', 'linear', 'power', 'exponential', 'saturating']);
    assert.equal(c.models.none.deltaAuc, 0);
    assert.ok(c.models.linear.rho > 0.8, `${c.models.linear.rho}`);
    for (const e of entries) near(e.doses.none, entries[0].doses.none, 1e-9); // D0 cannot tell the workdays apart
    assert.ok(c.models.linear.auc > c.models.none.auc);
    near(c.models.linear.deltaAuc, c.models.linear.auc - c.models.none.auc, 1e-12);
    assert.ok(c.models.linear.points.length > 2, 'ROC points for the exploratory curve');
  });
});
